import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// THE AUTONOMY LADDER — may Genesis act without asking:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-autonomy-live.ts" -OutFile out.txt
//
// The one place that decides whether Genesis changes an owner's storefront
// without asking them first. It had no coverage at all, and it is the highest
// consequence decision in the codebase: everything else here proposes, and this
// is the path that acts.
//
// FIVE INDEPENDENT GATES, EVERY ONE OF WHICH MUST HOLD. The file is careful to
// say it never re-examines Genesis's own judgment — whether Claude thought this
// was a good idea is decided entirely upstream. What it answers is narrower and
// deterministic: does the owner's own granted authority cover THIS action, right
// now.
//
//   1. the action type must be delegable at all (maxAuthorityTier)
//   2. a grant must exist for this store and this action
//   3. the grant must not have been revoked
//   4. the store's owner must still hold the permission the action needs —
//      delegated authority can never let Genesis do something the human owner
//      is not permitted to do
//   5. the input must actually parse
//
// Each is asserted here by removing exactly one and watching it refuse. What is
// NOT covered is whether an action succeeds once authorised — that is execute()'s
// own contract, proved separately by verify-execute-binding-live.ts.

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

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { tryExecuteAutonomousAction, grantDelegatedAuthority, revokeDelegatedAuthority } =
    await import("@/lib/execution/genesisAutonomy");
  const { GENESIS_ACTIONS } = await import("@/lib/execution/genesisActions");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  let n = 0;
  const makeStore = async (name: string, userId: string, growthPointBalance = 0) =>
    prisma.store.create({
      data: {
        userId, name, slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${++n}`,
        tagline: "t", description: "d", currency: "USD", growthPointBalance,
        blueprint: { marketingAssets: { seoTitle: "Old title", seoMetaDescription: "Old description" } },
      },
    });

  const owner = await prisma.user.create({ data: { email: "autonomy@example.test" } });

  // update_seo is the one action with maxAuthorityTier above always_ask — the
  // deliberate choice recorded in genesisActions.ts: narrow blast radius,
  // reversible, invisible to a customer already on the page.
  const DELEGABLE = "update_seo";
  const NOT_DELEGABLE = "update_hero";

  const seoInput = { seoTitle: "A new title", seoMetaDescription: "A new description" };

  const attempt = (storeId: string, actionType: string, input: unknown) =>
    tryExecuteAutonomousAction({
      storeId,
      actionType,
      input,
      summary: "Genesis acted on its own",
      topicKey: null,
      cognitiveOutputId: null,
    } as never);

  // ==========================================================================
  console.log("\n=== 1. The registry decides what may ever be delegated ===\n");
  // ==========================================================================
  check("update_seo is delegable", GENESIS_ACTIONS[DELEGABLE].maxAuthorityTier !== "always_ask", true);
  check("update_hero is deliberately not", GENESIS_ACTIONS[NOT_DELEGABLE].maxAuthorityTier, "always_ask");

  // Granting a non-delegable action is refused outright rather than stored and
  // silently ignored — an owner must never believe they granted something they
  // did not.
  const store = await makeStore("Autonomy Store", owner.id);
  let grantRefused = false;
  try {
    await grantDelegatedAuthority({ storeId: store.id, actionType: NOT_DELEGABLE, grantedByUserId: owner.id });
  } catch {
    grantRefused = true;
  }
  assert("granting a non-delegable action is refused", grantRefused);
  check("and nothing was written",
    await prisma.delegatedAuthority.count({ where: { storeId: store.id } }), 0);

  // ==========================================================================
  console.log("\n=== 2. No grant means no autonomous action ===\n");
  // ==========================================================================
  check("a delegable action with no grant does not run", await attempt(store.id, DELEGABLE, seoInput), false);
  check("and no proposal was created either",
    await prisma.approvalRequest.count({ where: { storeId: store.id } }), 0);
  check("the storefront is untouched",
    ((await prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { blueprint: true } }))
      .blueprint as { marketingAssets: { seoTitle: string } }).marketingAssets.seoTitle,
    "Old title");

  // ==========================================================================
  console.log("\n=== 3. Authority is not a budget ===\n");
  // ==========================================================================
  // A GRANT SAYS "YOU MAY", NEVER "IT IS FREE". update_seo costs a Growth Point,
  // and this store has none — so the action is HANDLED but does not run. Found
  // by writing this suite: tryExecuteAutonomousAction returns true meaning
  // "handled, do not also raise a normal proposal", which is not the same as
  // "succeeded", and conflating the two is easy to do from the outside.
  await grantDelegatedAuthority({ storeId: store.id, actionType: DELEGABLE, grantedByUserId: owner.id });
  const grant = await prisma.delegatedAuthority.findFirstOrThrow({ where: { storeId: store.id } });

  check("it is handled", await attempt(store.id, DELEGABLE, seoInput), true);
  check("but the storefront did NOT change, because the business cannot afford it",
    ((await prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { blueprint: true } }))
      .blueprint as { marketingAssets: { seoTitle: string } }).marketingAssets.seoTitle,
    "Old title");

  // And it does not vanish: it becomes something a human can see and decide on,
  // reading as "Genesis tried this and it failed" rather than "never acted on".
  const failedRecord = await prisma.approvalRequest.findFirstOrThrow({ where: { storeId: store.id } });
  check("it is left for a human to decide", failedRecord.status, "PENDING_APPROVAL");
  assert("carrying the execution that failed", failedRecord.executionId !== null,
    "so it reads as tried-and-failed, not never-attempted");
  check("and never retried silently",
    await prisma.approvalRequest.count({ where: { storeId: store.id } }), 1);

  // ==========================================================================
  console.log("\n=== 3b. With authority AND the means, it acts ===\n");
  // ==========================================================================
  await prisma.store.update({ where: { id: store.id }, data: { growthPointBalance: 50 } });

  check("it acts", await attempt(store.id, DELEGABLE, seoInput), true);
  check("the storefront really changed",
    ((await prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { blueprint: true } }))
      .blueprint as { marketingAssets: { seoTitle: string } }).marketingAssets.seoTitle,
    "A new title");
  assert("and the business paid for it",
    (await prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { growthPointBalance: true } }))
      .growthPointBalance < 50,
    "autonomy does not make execution free");

  // The audit trail is the whole reason this is allowed to happen at all.
  const record = await prisma.approvalRequest.findFirstOrThrow({
    where: { storeId: store.id, status: "EXECUTED" },
  });
  check("a real ApprovalRequest records it", record.actionType, DELEGABLE);
  check("marked as Genesis's own decision", record.decisionMode, "autonomous");
  check("naming the grant that authorised it", record.delegatedAuthorityId, grant.id);
  check("at the auto tier", record.authorizationTier, "auto");
  assert("with the previous values kept, so it can be reverted",
    (record.previousValues as { seoTitle?: string }).seoTitle === "Old title",
    "an autonomous change the owner cannot undo would be a different product");

  const log = await prisma.executionLog.findFirstOrThrow({
    where: { storeId: store.id, status: "SUCCESS" }, orderBy: { createdAt: "desc" },
  });
  check("and an execution logged against Genesis", log.actorType, "GENESIS");

  // ==========================================================================
  console.log("\n=== 4. Revoking stops it, and re-granting is the same row ===\n");
  // ==========================================================================
  await revokeDelegatedAuthority(store.id, DELEGABLE);
  check("a revoked grant stops autonomous action",
    await attempt(store.id, DELEGABLE, { seoTitle: "Should not land", seoMetaDescription: "Nor this" }),
    false);
  check("the storefront kept the last authorised value",
    ((await prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { blueprint: true } }))
      .blueprint as { marketingAssets: { seoTitle: string } }).marketingAssets.seoTitle,
    "A new title");

  // The grant row survives revoked rather than being deleted — the history of
  // what was once authorised is part of answering "why was Genesis allowed to
  // do this" forever.
  const revoked = await prisma.delegatedAuthority.findFirstOrThrow({ where: { id: grant.id } });
  assert("the grant is revoked, not deleted", revoked.revokedAt !== null);

  await grantDelegatedAuthority({ storeId: store.id, actionType: DELEGABLE, grantedByUserId: owner.id });
  check("re-granting reactivates the same row",
    await prisma.delegatedAuthority.count({ where: { storeId: store.id, actionType: DELEGABLE } }), 1);
  const regranted = await prisma.delegatedAuthority.findFirstOrThrow({ where: { id: grant.id } });
  check("with the revocation cleared", regranted.revokedAt, null);
  check("and it acts again",
    await attempt(store.id, DELEGABLE, { seoTitle: "Third title", seoMetaDescription: "Third description" }),
    true);

  // ==========================================================================
  console.log("\n=== 5. Malformed input is refused before anything happens ===\n");
  // ==========================================================================
  const beforeBad = await prisma.approvalRequest.count({ where: { storeId: store.id } });
  check("input that does not parse does not run", await attempt(store.id, DELEGABLE, { seoTitle: 42 }), false);
  check("and creates no proposal", await prisma.approvalRequest.count({ where: { storeId: store.id } }), beforeBad);
  check("the storefront is unchanged",
    ((await prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { blueprint: true } }))
      .blueprint as { marketingAssets: { seoTitle: string } }).marketingAssets.seoTitle,
    "Third title");

  // An action type that is not in the registry at all.
  check("an unknown action type does nothing", await attempt(store.id, "not_a_real_action", seoInput), false);
  // And a non-delegable one, even though it IS a real action.
  check("a real but non-delegable action does nothing",
    await attempt(store.id, NOT_DELEGABLE, { heroHeadline: "h", heroSubheadline: "s" }), false);

  // ==========================================================================
  console.log("\n=== 6. A grant is per business, never per account ===\n");
  // ==========================================================================
  const other = await makeStore("Other Autonomy Store", owner.id, 50);
  check("the same owner's OTHER business has no grant",
    await prisma.delegatedAuthority.count({ where: { storeId: other.id } }), 0);
  check("so Genesis may not act there",
    await attempt(other.id, DELEGABLE, { seoTitle: "Should not land", seoMetaDescription: "Nor this" }),
    false);
  check("and its storefront is untouched",
    ((await prisma.store.findUniqueOrThrow({ where: { id: other.id }, select: { blueprint: true } }))
      .blueprint as { marketingAssets: { seoTitle: string } }).marketingAssets.seoTitle,
    "Old title");
  assert(
    "while the granted business still can",
    (await attempt(store.id, DELEGABLE, { seoTitle: "Fourth title", seoMetaDescription: "Fourth" })) === true,
    "so the refusal above is about the grant, not a blanket denial"
  );

  // A stranger's store with a grant of its own is entirely separate.
  const stranger = await prisma.user.create({ data: { email: "autonomy-stranger@example.test" } });
  const theirs = await makeStore("Stranger Store", stranger.id, 50);
  await grantDelegatedAuthority({ storeId: theirs.id, actionType: DELEGABLE, grantedByUserId: stranger.id });
  check("another account's grant does not authorise anything here",
    await attempt(other.id, DELEGABLE, { seoTitle: "Still should not land", seoMetaDescription: "No" }),
    false);
  check("and their own store's blueprint is only theirs to change",
    ((await prisma.store.findUniqueOrThrow({ where: { id: other.id }, select: { blueprint: true } }))
      .blueprint as { marketingAssets: { seoTitle: string } }).marketingAssets.seoTitle,
    "Old title");

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All autonomy assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
