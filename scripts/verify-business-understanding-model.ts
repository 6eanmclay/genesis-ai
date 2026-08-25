import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import { readFileSync } from "fs";
import { join } from "path";

// J4'S BUSINESS UNDERSTANDING MODEL — acceptance.
//
//   npx tsx scripts/verify-business-understanding-model.ts
//
// D1-A, D2, D3, D5. Brings its own Postgres — the canonical assembly fans out
// and has previously exhausted PGlite's single connection. NOT in the shared 41.
//
// Every gate has a negative control that proves it can fail.

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}
function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
/** Comments explain the reason; code is the evidence. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

/**
 * The braced block that follows `marker`.
 *
 * A distance-windowed regex was tried first and reported green for the wrong
 * reason: `facts: {` is followed within any reasonable window by `inference: {
 * beliefs`, so "beliefs are not under facts" matched the NEXT layer's contents.
 * Counting braces is the only way to ask about one block.
 */
function blockAfter(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start < 0) return "";
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
}

const CLAIMS = ["targetAudience", "brandPersonality", "brandVoice", "sellingProposition"] as const;

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { prisma } = await import("@/lib/prisma");
  const { getBusinessUnderstanding } = await import("@/lib/businessModel/understanding");
  const { businessContextOf } = await import("@/lib/businessModel/businessContext");
  const { stateFact } = await import("@/lib/businessModel/statements");
  const life = await import("@/lib/businessModel/factLifecycle");

  try {
    const user = await prisma.user.create({ data: { email: `bum-${Date.now()}@test.local` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Model Co", slug: `model-${Date.now()}` },
    });

    // ==================================================================
    console.log("\n=== D1-A — the four claims are owner-authoritative facts ===\n");
    // ==================================================================
    for (const t of CLAIMS) {
      assert(`${t} is owner-authoritative`, life.isOwnerAuthoritative(t));
      assert(`${t} is a singleton`, life.isSingletonFact(t));
    }
    assert("CONTROL: a connector-owned type is still not owner-authoritative",
      !life.isOwnerAuthoritative("transaction"));

    // THE POINT OF D1-A: the content pipeline can no longer produce them.
    const prompts = codeOnly(read("lib", "dashboard", "storeChatPrompts.ts"));
    const identityBlock = prompts.slice(
      prompts.indexOf("BrandIdentitySchema"),
      prompts.indexOf("BrandIdentitySchema") + 900
    );
    for (const f of ["targetAudience", "brandPersonality", "brandVoiceAndTone", "uniqueSellingProposition"]) {
      assert(`the content pipeline no longer generates ${f}`,
        !identityBlock.includes(`${f}:`),
        "a copy edit must not rewrite the business's stated audience as a side effect");
    }
    assert("CONTROL: it still generates the copy it is for",
      identityBlock.includes("brandStory:") && identityBlock.includes("missionStatement:"));

    // Nothing reads them from the blueprint any more.
    let blueprintReads = 0;
    for (const f of ["lib/intelligence/cognitiveLayer.ts", "lib/marketing/assets.ts",
                     "lib/marketing/campaigns.ts", "lib/execution/genesisActions.ts",
                     "app/dashboard/analytics/page.tsx", "lib/businessModel/profile.ts"]) {
      const src = codeOnly(read(...f.split("/")));
      for (const c of ["targetAudience", "brandPersonality", "brandVoiceAndTone", "uniqueSellingProposition"]) {
        if (new RegExp(`brandIdentity\\??\\.${c}`).test(src)) blueprintReads++;
      }
    }
    eq("no consumer reads the four from the blueprint", blueprintReads, 0);

    // ==================================================================
    console.log("\n=== D1-A — provenance, correction and history hold ===\n");
    // ==================================================================
    const first = await stateFact({
      storeId: store.id, userId: user.id, entityType: "targetAudience",
      data: { statement: "people who wait for good things" },
      modelExtracted: false, context: "brand_identity",
    });
    assert("an owner statement is recorded", first.ok);

    const corrected = await stateFact({
      storeId: store.id, userId: user.id, entityType: "targetAudience",
      data: { statement: "gift buyers, mostly" }, modelExtracted: true, context: "chat",
    });
    assert("restating supersedes without a named target", corrected.ok && Boolean(corrected.value.supersededRecordId),
      "a singleton has one current answer, so the target is unambiguous");

    const current = await life.currentFacts(store.id, "targetAudience");
    eq("exactly one is current", current.length, 1);
    eq("and it is the correction", (current[0].data as { statement: string }).statement, "gift buyers, mostly");
    eq("provenance is OWNER", current[0].provenance, "OWNER");
    eq("and the distillation is recorded", current[0].modelExtracted, true);

    const history = await life.factHistory(store.id, "targetAudience");
    eq("history keeps both", history.length, 2);
    assert("so who they used to think their customer was survives",
      history.some((r) => (r.data as { statement?: string }).statement === "people who wait for good things"));

    // ==================================================================
    console.log("\n=== D1-A — the executable's read-back moved with the fields ===\n");
    // ==================================================================
    const { updateBrandIdentityExecutable: brandExec } = await import(
      "@/lib/execution/executables/updateBrandIdentity"
    );
    const execCtx = { storeId: store.id, userId: user.id } as never;

    // A PARTIAL INPUT CHANGES ONE THING. Naming the copy fields explicitly once
    // turned this merge into an unconditional overwrite, and a caller sending
    // only brandStory erased missionStatement and coreValues.
    await prisma.store.update({
      where: { id: store.id },
      data: { blueprint: { brandIdentity: { brandStory: "old", missionStatement: "KEEPME" } } },
    });
    await brandExec.run({ brandStory: "new story" } as never, execCtx);
    const bp = (await prisma.store.findUniqueOrThrow({ where: { id: store.id } }))
      .blueprint as { brandIdentity: Record<string, unknown> };
    eq("a partial update writes what it names", bp.brandIdentity.brandStory, "new story");
    eq("and leaves what it does not", bp.brandIdentity.missionStatement, "KEEPME");
    assert("CONTROL: an absent key was not written as undefined",
      !Object.hasOwn(bp.brandIdentity, "brandPromise"));

    await brandExec.run({ brandStory: "s", targetAudience: "collectors" } as never, execCtx);
    const okOutcome = await brandExec.verify({ brandStory: "s", targetAudience: "collectors" } as never, execCtx, undefined);
    eq("verify confirms a claim from the fact lifecycle, not the blueprint", okOutcome.state, "verified");

    const badOutcome = await brandExec.verify(
      { brandStory: "s", targetAudience: "somebody else entirely" } as never, execCtx, undefined);
    assert("CONTROL: and it fails when the stored claim is not what was asked for",
      badOutcome.state === "failed",
      "dropping the four from verify() would have left four of nine writes unchecked");

    // ==================================================================
    console.log("\n=== D1-A — reversal reads the facts, and cannot capture a blank ===\n");
    // ==================================================================
    const { GENESIS_ACTIONS } = await import("@/lib/execution/genesisActions");
    const brandAction = GENESIS_ACTIONS.update_brand_identity;

    const captured = await brandAction.getCurrentValues({
      storeId: store.id,
      blueprint: { brandIdentity: { brandStory: "from the blueprint" } },
    } as never);
    eq("the copy half still comes from the blueprint",
      (captured as { brandStory: string }).brandStory, "from the blueprint");
    eq("and the claim half comes from the fact lifecycle",
      (captured as { targetAudience: string }).targetAudience, "collectors");

    // THE HOLE THIS CLOSES. The generic autonomous path built a context with no
    // store, so this returned "" for four fields the owner has real answers for
    // — and reversing that proposal would have written the blanks back.
    //
    // ON THE MESSAGE, NOT MERELY ON THROWING. Removing the guard still throws —
    // a store-less read fails somewhere downstream — so "it threw" was green
    // with the guard deleted. The gate has to name the refusal it wants.
    let refusal = "";
    try {
      await brandAction.getCurrentValues({ blueprint: null } as never);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    assert("without a store it refuses rather than answering emptily",
      refusal.includes("identity claims are facts"),
      `a caller forgetting the store must not look like an owner with nothing to say; got: ${refusal.slice(0, 90)}`);

    const autonomySrc = codeOnly(read("lib", "execution", "genesisAutonomy.ts"));
    // Anchored on the `return {`, not on the function name: blockAfter would
    // take the first brace after the name, which is the inline type of the
    // `record` parameter — a block that has never contained what is asked about.
    const fnStart = autonomySrc.indexOf("async function buildActionContext");
    const built = blockAfter(autonomySrc.slice(fnStart), "return ");
    assert("and the autonomous path carries the store", /^\s*storeId,$/m.test(built),
      "this is the path that looks an action up by name, so it must satisfy every one");

    // ==================================================================
    console.log("\n=== D2 — the reasoning boundary is a type ===\n");
    // ==================================================================
    const understanding = await getBusinessUnderstanding(store.id, { viewerUserId: user.id });
    const ctx = businessContextOf(understanding, {
      asOf: understanding.asOf,
      throughEventSequence: understanding.throughEventSequence,
    });

    assert("the five layers are separate",
      "identity" in ctx && "facts" in ctx && "history" in ctx && "inference" in ctx && "intent" in ctx && "platform" in ctx);
    eq("a fact carries its source", ctx.identity.targetAudience?.provenance, "owner");
    // "collectors", not "gift buyers, mostly" — the approved brand-identity
    // change above restated it. That is the point rather than an inconvenience:
    // a direct statement and an executable's write are the same fact with one
    // current answer, not two competing stores of the same claim.
    eq("and its statement is the latest one, whoever stated it",
      ctx.identity.targetAudience?.statement, "collectors");

    const contextSrc = codeOnly(read("lib", "businessModel", "businessContext.ts"));
    assert("an inference cannot be shaped without confidence",
      /InferredClaim\s*\{[\s\S]{0,200}confidence: number;/.test(contextSrc),
      "a belief arriving without it would be an inference wearing a fact's clothes");
    const factsBlock = blockAfter(contextSrc.slice(contextSrc.indexOf("interface BusinessContext")), "facts:");
    assert("the facts layer exists to be checked", factsBlock.includes("categories"));
    assert("beliefs live under inference, never under facts",
      !factsBlock.includes("belief"),
      "a conclusion filed among facts is a conclusion that gets quoted as one");
    assert("CONTROL: they are under inference",
      blockAfter(contextSrc, "inference: {").includes("beliefs"));
    assert("the shape performs no reads",
      !/prisma\.|await /.test(contextSrc.slice(contextSrc.indexOf("export function businessContextOf"))),
      "it selects from an assembled understanding; it is not a second assembler");

    // ==================================================================
    console.log("\n=== D3 — the payloads are selections ===\n");
    // ==================================================================
    for (const f of ["lib/execution/toolHandlers.ts", "lib/intelligence/cognitiveLayer.ts",
                     "lib/dashboard/chatTurnContext.ts"]) {
      assert(`${f.split("/").pop()} builds from the declared shape`,
        codeOnly(read(...f.split("/"))).includes("businessContextOf("));
    }

    // ==================================================================
    console.log("\n=== D5 — the temporal anchor ===\n");
    // ==================================================================
    assert("the understanding says when it is true as of", typeof understanding.asOf === "string");
    eq("and the event mark is null with no events", understanding.throughEventSequence, null);

    await prisma.businessEvent.create({
      data: { storeId: store.id, entityType: "item", eventType: "item.created",
              sourceProvider: "test", summary: "something happened" },
    });
    const after = await getBusinessUnderstanding(store.id, { viewerUserId: user.id });
    // `!== null` WAS NOT ENOUGH. Renaming the field in the assembler left the
    // property undefined, and `undefined !== null` is true — the gate stayed
    // green while the anchor was gone. It has to assert the shape it needs.
    assert("after an event it carries the high-water mark",
      typeof after.throughEventSequence === "string" && /^\d+$/.test(after.throughEventSequence),
      "this is what makes 'what changed since' answerable without comparing clocks; " +
        "a string because BigInt does not survive JSON");

    // ==================================================================
    console.log("\n=== D4 — nothing new came in scope ===\n");
    // ==================================================================
    const { RELATIONSHIP_KIND_KEYS } = await import("@/lib/businessModel/relationships");
    const reads = [...codeOnly(read("lib", "businessModel", "understanding.ts")).matchAll(/relationsByKind\(/g)];
    eq("still exactly one relationship kind is read", reads.length, 1);
    eq("and the registry was not grown to justify reading more", RELATIONSHIP_KIND_KEYS.length, 8);

    // ==================================================================
    console.log("\n=== The promotion path is safe by construction ===\n");
    // ==================================================================
    const promo = codeOnly(read("scripts", "promote-brand-claims.ts"));
    assert("it is a dry run unless told otherwise", promo.includes('includes("--apply")'));
    assert("it writes INFERENCE, never OWNER",
      promo.includes('provenance: "INFERENCE"') && !promo.includes('provenance: "OWNER"'),
      "nobody stated these; writing them as OWNER would fabricate testimony");
    assert("it never overwrites a current fact", promo.includes("existing.length > 0"));
    assert("and it does not touch the blueprint",
      !/store\.update|blueprint:\s*\{/.test(promo),
      "the old values stay where they are, so the promotion is reversible by deleting rows");
  } finally {
    await db.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
