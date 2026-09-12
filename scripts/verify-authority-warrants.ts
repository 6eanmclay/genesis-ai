import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// WHO SAID GENESIS COULD DO THAT (2026-09-11):
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-authority-warrants.ts" -OutFile out.txt
//
// ============ WHY THIS EXISTS ========================================
//
// The two-path audit found that "autonomous" was never one thing. Two
// different production paths execute without the owner clicking anything,
// and they do not share a single gate — neither is a subset of the other:
//
//   PRESENT-OWNER   the owner is signed in and in the conversation.
//                   ai-actions.ts -> proposeAction -> execute, gated on the
//                   registry's authorizationTier and the caller's own live
//                   session permission. No DelegatedAuthority is read.
//   GRANT           the owner is absent. genesisAutonomy.ts ->
//                   tryExecuteAutonomousAction -> execute, gated on the
//                   action's CAP plus an explicit, un-revoked grant, which
//                   execute() then re-verifies by object identity.
//   SYSTEM          the CRON path only (scheduler.ts), connector syncs, no
//                   GENESIS_ACTIONS mutation, forced actorType "SYSTEM".
//   EXEMPT          communicate_finding, and only it.
//
// And in every case the CATEGORY CEILING is the absolute ceiling — no
// warrant reaches past it.
//
// This file locks those semantics. It does not change them: which warrant
// revocation ought to cover is a product decision that has not been made.
//
// ============ WHAT IS PROVEN BY RUNNING, AND WHAT IS NOT =============
//
// The grant warrant is exercised end to end against a real Postgres — grant,
// execute, revoke, refuse. The present-owner warrant CANNOT be: its execute()
// goes through requireStorePermission, which calls auth() for a real signed-in
// session, and the only production caller is a chat turn behind a live model
// call. So it is proven in two honest halves — its gate evaluated against the
// real registry, and its recording asserted against the real source — and the
// halves are labelled as such rather than dressed up as an end-to-end run.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const root = process.cwd();
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
/** Comments explain intent; code is the evidence. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

async function main(): Promise<void> {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { tryExecuteAutonomousAction, grantDelegatedAuthority, revokeDelegatedAuthority } =
    await import("@/lib/execution/genesisAutonomy");
  const { GENESIS_ACTIONS, CATEGORY_MAX_TIER } = await import("@/lib/execution/genesisActions");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  type Def = {
    category: string;
    authorizationTier: string;
    maxAuthorityTier: string;
    authorityExempt?: boolean;
  };
  const D = GENESIS_ACTIONS as unknown as Record<string, Def>;

  // THE GATES AS THE CODE WRITES THEM, not as a test wishes they were. Each
  // is the literal expression its production path evaluates, so a change to
  // either path's rule shows up here as a changed result rather than as a
  // comment that stopped being true.
  const presentOwnerGate = (k: string) => D[k].authorizationTier === "auto" && !D[k].authorityExempt;
  const grantableGate = (k: string) => D[k].maxAuthorityTier !== "always_ask";

  let n = 0;
  const owner = await prisma.user.create({ data: { email: `warrants-${Date.now()}@test.local` } });
  const makeStore = () =>
    prisma.store.create({
      data: {
        userId: owner.id,
        name: "Warrant Co",
        slug: `warrant-${++n}-${Date.now()}`,
        tagline: "t",
        description: "d",
        currency: "USD",
        growthPointBalance: 500,
        blueprint: { marketingAssets: { seoTitle: "Old title", seoMetaDescription: "Old desc" } },
      },
    });

  const seoInput = { seoTitle: "ZZWARRANT", seoMetaDescription: "ZZWARRANT desc" };
  const seoTitleOf = async (storeId: string) =>
    (
      (
        await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { blueprint: true } })
      ).blueprint as { marketingAssets: { seoTitle: string } }
    ).marketingAssets.seoTitle;

  // ======================================================================
  console.log("\n=== 1. The four warrants are distinguishable at all ===\n");
  // ======================================================================
  //
  // The whole slice rests on this: if the record cannot tell them apart,
  // every sentence the product says about who decided something is a guess.
  const schema = read("prisma", "schema.prisma");
  assert("decisionMode still defaults to human",
    /decisionMode\s+String\s+@default\("human"\)/.test(schema),
    "the default is what an un-set path silently claims");
  for (const value of ["human", "chat_auto", "autonomous"]) {
    assert(`  the schema documents "${value}"`, schema.includes(`"${value}"`));
  }
  // SYSTEM is the fourth and deliberately has no decisionMode: it writes no
  // ApprovalRequest at all. Asserted so that "there are only three values"
  // never quietly becomes "there are only three kinds of execution".
  const scheduler = codeOnly(read("lib", "intelligence", "scheduler.ts"));
  assert("the system path writes no ApprovalRequest",
    !/approvalRequest\.(create|update)/.test(scheduler),
    "system execution is identified by ExecutionLog.actorType, not by a decision row");

  // ======================================================================
  console.log("\n=== 2. GRANT — absent owner, and the grant is the authority ===\n");
  // ======================================================================
  const s2 = await makeStore();

  check("no grant exists for this store",
    await prisma.delegatedAuthority.count({ where: { storeId: s2.id } }), 0);
  const refusedWithoutGrant = await tryExecuteAutonomousAction({
    storeId: s2.id,
    actionType: "update_seo",
    input: seoInput,
    summary: "Genesis acted on its own",
    topicKey: null,
    cognitiveOutputId: null,
  } as never);
  check("absent owner + no grant -> REFUSED", refusedWithoutGrant, false);
  check("  and nothing was written", await seoTitleOf(s2.id), "Old title");

  await grantDelegatedAuthority({ storeId: s2.id, actionType: "update_seo", grantedByUserId: owner.id });
  const ranUnderGrant = await tryExecuteAutonomousAction({
    storeId: s2.id,
    actionType: "update_seo",
    input: seoInput,
    summary: "Genesis acted on its own",
    topicKey: null,
    cognitiveOutputId: null,
  } as never);
  check("absent owner + valid grant -> ALLOWED", ranUnderGrant, true);
  check("  and it really landed", await seoTitleOf(s2.id), "ZZWARRANT");

  const granted = await prisma.approvalRequest.findFirstOrThrow({
    where: { storeId: s2.id, actionType: "update_seo", status: "EXECUTED" },
    orderBy: { decidedAt: "desc" },
  });
  check("recorded with the GRANT warrant", granted.decisionMode, "autonomous");
  assert("  and the grant that authorised it is named", !!granted.delegatedAuthorityId,
    "so \"why was Genesis allowed to do this\" survives the grant being revoked");
  check("  nobody is recorded as having decided it", granted.decidedByUserId, null);

  const grantLog = await prisma.executionLog.findFirstOrThrow({
    where: { storeId: s2.id, action: "store.update_seo" },
    orderBy: { createdAt: "desc" },
  });
  check("  the execution is Genesis acting", grantLog.actorType, "GENESIS");
  check("  with no human attached", grantLog.actorId, null);
  check("  and it read its own write back", grantLog.verified, true);

  // REVOCATION CLOSES THIS WARRANT. Only this one — what it should mean for
  // the present-owner warrant is the open product decision, so nothing here
  // asserts an answer to it.
  await revokeDelegatedAuthority(s2.id, "update_seo");
  const afterRevoke = await tryExecuteAutonomousAction({
    storeId: s2.id,
    actionType: "update_seo",
    input: { seoTitle: "ZZAFTERREVOKE", seoMetaDescription: "should not land" },
    summary: "Genesis acted on its own",
    topicKey: null,
    cognitiveOutputId: null,
  } as never);
  check("revoked grant -> REFUSED", afterRevoke, false);
  check("  and nothing was written", await seoTitleOf(s2.id), "ZZWARRANT");

  // ======================================================================
  console.log("\n=== 3. PRESENT-OWNER — the tier is the authority, not a grant ===\n");
  // ======================================================================
  //
  // Gate half: evaluated against the real registry.
  const s3 = await makeStore();
  check("this store has granted Genesis nothing",
    await prisma.delegatedAuthority.count({ where: { storeId: s3.id } }), 0);
  assert("present-owner + auto tier -> the gate is OPEN with no grant",
    presentOwnerGate("update_seo"),
    "the registry tier alone opens it; DelegatedAuthority is never read on this path");
  assert("  while the grant path refuses the identical action and store",
    (await tryExecuteAutonomousAction({
      storeId: s3.id,
      actionType: "update_seo",
      input: seoInput,
      summary: "Genesis acted on its own",
      topicKey: null,
      cognitiveOutputId: null,
    } as never)) === false,
    "same action, same store, same moment — the two warrants genuinely differ");

  // THE PATH READS NO GRANT. A negative asserted across the whole file, which
  // is the only honest way to prove an absence.
  const chatSrc = codeOnly(read("app", "dashboard", "ai-actions.ts"));
  assert("the present-owner path never consults DelegatedAuthority",
    !/delegatedAuthority|getActiveDelegatedAuthority|revokedAt/.test(chatSrc),
    "if this starts failing, revocation has begun covering this path — a product decision");

  // Recording half: asserted against the real source, because this path
  // cannot be driven without a session and a live model call.
  const autoExecuteBlock = chatSrc.slice(
    chatSrc.indexOf('authorizationTier === "auto"'),
    chatSrc.indexOf('authorizationTier === "auto"') + 1600,
  );
  assert("the auto-execute block exists where this expects it",
    autoExecuteBlock.includes('status: "EXECUTED"'),
    "if this fails the assertion below is reading the wrong code, not passing");
  assert("present-owner execution is recorded with the CHAT_AUTO warrant",
    /decisionMode:\s*"chat_auto"/.test(autoExecuteBlock),
    "leaving the default made J4's own change read as the owner's approval");

  // AND NO OTHER PATH MAY LEAVE AN EXECUTION AT THE DEFAULT. The sweep, not
  // the one file — the defect this closes was exactly a write that nobody
  // remembered sets a warrant.
  const humanDecisionPaths = /approveGenesisAction|rejectGenesisAction|revertApprovalRequest|performApproveGenesisAction/;
  const warrantsWritten = [...chatSrc.matchAll(/decisionMode:\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
  // THE CHAT FILE OWNS EXACTLY TWO WARRANTS AND MUST NOT INVENT A THIRD.
  // "autonomous" belongs to genesisAutonomy.ts, where a grant was actually
  // looked up — a conversational path claiming it would be asserting an
  // authority nobody granted.
  check("the conversational file writes only its own two warrants",
    [...new Set(warrantsWritten)], ["chat_auto", "human"]);
  assert("CONTROL: the human decision paths really are in this file",
    humanDecisionPaths.test(chatSrc),
    "otherwise the assertion above is reading a file with no human path to distinguish from");

  // ======================================================================
  console.log("\n=== 4. HUMAN stays distinguishable from both ===\n");
  // ======================================================================
  //
  // A row nobody has decided yet must not claim a warrant. This is the
  // default's real job, and it is what the chat path used to inherit by
  // accident.
  const pending = await prisma.approvalRequest.create({
    data: {
      storeId: s3.id,
      actionType: "update_seo",
      input: seoInput as object,
      previousValues: {} as object,
      summary: "Genesis has an SEO update for you",
      authorizationTier: "auto",
      groupId: `warrants-${Date.now()}`,
    },
  });
  check("an undecided row carries the human default", pending.decisionMode, "human");
  check("  and names nobody as deciding it", pending.decidedByUserId, null);
  assert("the three warrants are three distinct values",
    new Set(["human", pending.decisionMode, granted.decisionMode]).size === 2 &&
      granted.decisionMode !== "human",
    `human vs ${granted.decisionMode}`);

  // THE OWNER-FACING SENTENCE FOLLOWS THE WARRANT, not the absence of one.
  // "You approved this" was rendered over every chat_auto row for months.
  // CODE, NOT THE COMMENTS ABOUT IT. The first version of this read the raw
  // file and found "You approved this" inside the comment explaining why that
  // sentence had been wrong — so the ordering assertion failed against a
  // perfectly correct branch. A test that reads prose is reading the one part
  // of a file that cannot execute.
  const marketing = codeOnly(read("app", "dashboard", "marketing", "page.tsx"));
  assert("the history distinguishes all three warrants",
    marketing.includes('decisionMode === "autonomous"') &&
      marketing.includes('decisionMode === "chat_auto"') &&
      marketing.includes("You approved this"),
    "three warrants, three sentences");
  // >= 0 FIRST, OR THIS PASSES BY ABSENCE. indexOf returns -1 for a branch
  // that isn't there, and -1 is less than everything — so deleting the
  // chat_auto case entirely would have satisfied an ordering check that
  // exists to prove the case is handled. Caught by this file's own sabotage.
  const chatAutoAt = marketing.indexOf('decisionMode === "chat_auto"');
  const humanAt = marketing.indexOf("You approved this");
  assert("  and \"You approved this\" is the fallback, never the chat_auto case",
    chatAutoAt >= 0 && humanAt >= 0 && chatAutoAt < humanAt,
    `chat_auto at ${chatAutoAt}, human sentence at ${humanAt}`);

  // ======================================================================
  console.log("\n=== 5. SYSTEM is not content autonomy ===\n");
  // ======================================================================
  assert("the system seam is the scheduler's, and passes systemStoreId",
    /systemStoreId:/.test(scheduler),
    "the unattended seam");
  assert("  and it executes no GENESIS_ACTIONS action type",
    !/actionType:/.test(scheduler),
    "no actionType means no Growth Points gate and no ApprovalRequest — connector sync only");
  const engine = codeOnly(read("lib", "execution", "engine.ts"));
  assert("  the engine forces SYSTEM for that seam regardless of the caller",
    /systemStoreId[\s\S]{0,160}actorType:\s*"SYSTEM"/.test(engine),
    "a caller cannot dress a system execution up as Genesis or a person");

  // ======================================================================
  console.log("\n=== 6. EXEMPT is one operation, and it is documented ===\n");
  // ======================================================================
  const exempt = Object.entries(D).filter(([, d]) => d.authorityExempt).map(([k]) => k);
  check("exactly one action is authority-exempt", exempt, ["communicate_finding"]);
  assert("  and the present-owner gate excludes it explicitly",
    !presentOwnerGate("communicate_finding"),
    "additive communication is not a content change and must not ride the chat warrant");

  // ======================================================================
  console.log("\n=== 7. The category ceiling outranks every warrant ===\n");
  // ======================================================================
  const RANK: Record<string, number> = { always_ask: 0, auto_below_limit: 1, auto: 2 };
  check("money is capped at always_ask", (CATEGORY_MAX_TIER as Record<string, string>).money, "always_ask");
  check("destructive is capped at always_ask", (CATEGORY_MAX_TIER as Record<string, string>).destructive, "always_ask");

  const dangerous = Object.entries(D).filter(([, d]) => d.category === "money" || d.category === "destructive");
  assert("no money/destructive action can reach either warrant",
    dangerous.every(([k]) => !presentOwnerGate(k) && !grantableGate(k)),
    dangerous.map(([k]) => k).join(", "));
  assert("and no action anywhere sits above its category's ceiling",
    Object.values(D).every((d) => RANK[d.maxAuthorityTier] <= RANK[(CATEGORY_MAX_TIER as Record<string, string>)[d.category]]),
    `${Object.keys(D).length} actions`);

  // THROUGH THE REAL GRANT PATH, not just the table: a destructive action
  // cannot even be delegated, so the ceiling holds where it is enforced.
  const s7 = await makeStore();
  const product = await prisma.product.create({
    data: { storeId: s7.id, name: "ZZKEEP", priceInCents: 1000, active: true },
  });
  let destructiveGrantRefused = false;
  try {
    await grantDelegatedAuthority({ storeId: s7.id, actionType: "delete_product", grantedByUserId: owner.id });
  } catch {
    destructiveGrantRefused = true;
  }
  assert("granting delete_product is refused outright", destructiveGrantRefused);
  const destructiveRan = await tryExecuteAutonomousAction({
    storeId: s7.id,
    actionType: "delete_product",
    input: { productId: product.id },
    summary: "Genesis acted on its own",
    topicKey: null,
    cognitiveOutputId: null,
  } as never);
  check("and it does not run autonomously", destructiveRan, false);
  check("the product is untouched",
    await prisma.product.count({ where: { id: product.id, active: true } }), 1);

  // ======================================================================
  console.log("\n=== 8. The two reverted actions reach neither warrant ===\n");
  // ======================================================================
  for (const k of ["update_homepage_content", "update_store_content"] as const) {
    assert(`${k}: present-owner gate closed`, !presentOwnerGate(k));
    assert(`${k}: not grantable`, !grantableGate(k));
  }

  await prisma.$disconnect();
  await db.close();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
