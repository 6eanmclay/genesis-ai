import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import { readFileSync } from "fs";
import { join } from "path";

// WHAT THE OWNER TOLD US, AND WHAT GENESIS WROTE — the two stay apart.
//
//   npx tsx scripts/verify-owner-facts.ts
//
// Items 1-13 of DRAFT_FIELD_SPLIT_CONTRACT.md section 6. Item 14 is a live
// routing measurement and is deliberately NOT here: it is a separate empirical
// question, and a deterministic suite cannot answer it. Nothing in this file
// claims that carrying `offering` improves J4's decisions.
//
// BRINGS ITS OWN POSTGRES, and is therefore NOT in the shared runner — same
// arrangement as verify-conversations.ts and for the same reason. This suite
// drives getBusinessProfile, which fans out roughly twenty parallel reads;
// PGlite serves one connection, and that has previously killed an unrelated
// suite three positions later. A green shared count does not include this file,
// so it has to be run.
//
// The controls matter more than the assertions here. Almost every way this
// feature could go wrong is a value APPEARING where "not known" is the truth —
// a fallback, a default, a generated sentence promoted into owner testimony. So
// most of the negative controls check that nothing was written.

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
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  // Imported after the database is pointed at, so the client binds to it — and
  // so do profile.ts and digest.ts, which hold their own reference to it.
  const { prisma } = await import("@/lib/prisma");
  const mod = {
    ownerFacts: await import("@/lib/businessModel/ownerFacts"),
    entities: await import("@/lib/businessModel/entities"),
    digest: await import("@/lib/businessModel/digest"),
    profile: await import("@/lib/businessModel/profile"),
    understanding: await import("@/lib/businessModel/understanding"),
  };

  try {
    await run(prisma, mod);
  } finally {
    await db.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

type Mods = {
  ownerFacts: typeof import("@/lib/businessModel/ownerFacts");
  entities: typeof import("@/lib/businessModel/entities");
  digest: typeof import("@/lib/businessModel/digest");
  profile: typeof import("@/lib/businessModel/profile");
  understanding: typeof import("@/lib/businessModel/understanding");
};

type Db = typeof import("@/lib/prisma").prisma;

async function run(prisma: Db, mod: Mods) {
  const { ownerFactsFromDraft, recordOwnerFacts, readOwnerFacts, OWNER_FACT_IDS } = mod.ownerFacts;
  const { ENTITY_REGISTRY } = mod.entities;
  const { digestOf, renderDigest } = mod.digest;
  const { getBusinessProfile } = mod.profile;
  const { getBusinessUnderstanding } = mod.understanding;

  /** The digest exactly as a turn would build it. */
  const digestFor = async (storeId: string) => digestOf(await getBusinessUnderstanding(storeId));
  // =====================================================================
  // THE ADMISSIBILITY RULE — pure, so it needs no store at all
  // =====================================================================
  console.log("\n=== admissibility: which of a draft's contents count as testimony ===\n");

  const formDraft = {
    inputProductType: "Performance gym clothing",
    inputVision: "Dark luxury fitness brand",
    experienceState: null,
  };
  const form = ownerFactsFromDraft(formDraft);
  eq("the form path yields both statements", [form?.offering, form?.intent],
    ["Performance gym clothing", "Dark luxury fitness brand"]);
  eq("typed by the owner, so no model stood between", form?.modelExtracted, false);
  eq("and the source is recorded", form?.source, "onboarding_form");

  // ITEM 3 CONTROL. inputProductType is optional on the form.
  const noProduct = ownerFactsFromDraft({ ...formDraft, inputProductType: null });
  eq("a blank product field yields no offering", noProduct?.offering, null);
  eq("and the intent is unaffected", noProduct?.intent, "Dark luxury fitness brand");

  // ITEM 10 CONTROL, the important one. A draft carrying a full generated
  // concept and NO owner statements must produce nothing.
  const generatedOnly = ownerFactsFromDraft({
    inputProductType: null,
    inputVision: null,
    experienceState: {
      status: "generated",
      transcript: [{ role: "visitor", text: "hi" }],
      concept: {
        productName: "The Ember Candle",
        productDescription: "A hand-poured soy candle with notes of cedar and smoke.",
        businessModelSlug: "print_on_demand",
        brandPositioning: "premium",
        creativeDirection: { name: "Ember & Ash", description: "A rustic candle house for slow evenings." },
        ownerOffering: null,
        ownerIntent: null,
      },
    },
  });
  assert("a generated concept alone is NOT owner testimony", generatedOnly === null,
    "productDescription and creativeDirection.description are copy, not statements");

  // ITEM 9. The conversation path, when the visitor actually said something.
  const spoke = ownerFactsFromDraft({
    inputProductType: null,
    inputVision: null,
    experienceState: {
      status: "generated",
      concept: {
        productDescription: "A hand-poured soy candle with notes of cedar and smoke.",
        creativeDirection: { description: "A rustic candle house for slow evenings." },
        ownerOffering: "candles I pour myself",
        ownerIntent: "somewhere calm that feels like a real workshop",
      },
    },
  });
  eq("the conversation path yields what the visitor said",
    [spoke?.offering, spoke?.intent],
    ["candles I pour myself", "somewhere calm that feels like a real workshop"]);
  eq("a model read it, and that is recorded", spoke?.modelExtracted, true);
  eq("with its own source", spoke?.source, "onboarding_conversation");
  assert("and it did NOT take the generated copy",
    spoke?.offering !== "A hand-poured soy candle with notes of cedar and smoke." &&
    spoke?.intent !== "A rustic candle house for slow evenings.");

  // A session that predates these fields entirely.
  assert("a concept written before this shipped yields nothing",
    ownerFactsFromDraft({
      inputProductType: null, inputVision: null,
      experienceState: { status: "generated", concept: { productDescription: "x" } },
    }) === null);
  assert("and an empty draft yields nothing",
    ownerFactsFromDraft({ inputProductType: null, inputVision: null, experienceState: null }) === null);

  // Whitespace is not a statement.
  assert("a whitespace-only vision is not testimony",
    ownerFactsFromDraft({ inputProductType: "x", inputVision: "   ", experienceState: null }) === null);

  // =====================================================================
  // THE REGISTRY
  // =====================================================================
  console.log("\n=== the registry ===\n");

  assert("offering is a registered entity type", "offering" in ENTITY_REGISTRY);
  assert("intent is a registered entity type", "intent" in ENTITY_REGISTRY);
  assert("offering's schema rejects a shape that is not a statement",
    !ENTITY_REGISTRY.offering.schema.safeParse({ text: "wrong key" }).success);
  assert("and accepts one that is",
    ENTITY_REGISTRY.offering.schema.safeParse({ statement: "candles" }).success);

  // NO SCHEMA CHANGE. The contract binds this to the registry extension path.
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  assert("BusinessRecord gained no columns for this",
    !/offering|intent/i.test(schema.slice(schema.indexOf("model BusinessRecord"), schema.indexOf("model BusinessRecord") + 3000)),
    "the entity-registry extension contract, not a migration");
  assert("and Store gained none either",
    !/^\s+(offering|intent)\s/m.test(schema.slice(schema.indexOf("model Store {"), schema.indexOf("model Store {") + 4000)),
    "decision: no new Store columns");

  // =====================================================================
  // ITEMS 1, 2, 7, 8, 11, 12 — written, read back, with provenance
  // =====================================================================
  console.log("\n=== persistence and provenance ===\n");

  const user = await prisma.user.create({
    data: { email: "owner@example.com", name: "Owner" },
  });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Ember & Ash", slug: "ember-ash", description: "A rustic candle house." },
  });

  // ITEM 8 — a store that predates all of this.
  const before = await readOwnerFacts(store.id);
  eq("an existing store has neither, and nothing invented one", [before.offering, before.intent], [null, null]);

  // ITEM 7 — and the digest still builds.
  const emptyDigest = await digestFor(store.id);
  eq("the digest omits offering when unknown", emptyDigest.offering, null);
  assert("and renders without an empty label", !renderDigest(emptyDigest).includes("Offers:"));

  // ITEMS 1, 2, 11 — the form path.
  await recordOwnerFacts({ storeId: store.id, userId: user.id, facts: form! });
  const stored = await readOwnerFacts(store.id);
  eq("offering survives into the store's records", stored.offering, "Performance gym clothing");
  eq("intent survives into the store's records", stored.intent, "Dark luxury fitness brand");

  const rows = await prisma.businessRecord.findMany({
    where: { storeId: store.id, entityType: { in: ["offering", "intent"] } },
  });
  eq("two records, one each", rows.length, 2);
  assert("both are OWNER provenance", rows.every((r) => r.provenance === "OWNER"));
  assert("neither claims a model stood between", rows.every((r) => r.modelExtracted === false));
  assert("both name the person who said it", rows.every((r) => r.statedById === user.id));
  assert("both record where it was said",
    rows.every((r) => r.provenanceDetail === "onboarding_form"));

  // SINGLETON. Restating corrects rather than accumulating.
  await recordOwnerFacts({
    storeId: store.id, userId: user.id,
    facts: { offering: "Performance gym clothing and accessories", intent: "Dark luxury fitness brand", modelExtracted: false, source: "onboarding_form" },
  });
  const afterRestate = await prisma.businessRecord.findMany({
    where: { storeId: store.id, entityType: "offering" },
  });
  eq("restating what they sell corrects it", afterRestate.length, 1);
  eq("to the new answer", (afterRestate[0].data as { statement: string }).statement,
    "Performance gym clothing and accessories");
  eq("and the external id is the singleton one", afterRestate[0].externalId, OWNER_FACT_IDS.offering);

  // ITEM 12 — the conversation path's provenance.
  const store2 = await prisma.store.create({
    data: { userId: user.id, name: "Slow Wick", slug: "slow-wick" },
  });
  await recordOwnerFacts({ storeId: store2.id, userId: user.id, facts: spoke! });
  const rows2 = await prisma.businessRecord.findMany({
    where: { storeId: store2.id, entityType: { in: ["offering", "intent"] } },
  });
  assert("conversation records are OWNER too", rows2.every((r) => r.provenance === "OWNER"));
  assert("but DO record that a model read them", rows2.every((r) => r.modelExtracted === true));
  assert("and name the conversation as the source",
    rows2.every((r) => r.provenanceDetail === "onboarding_conversation"));

  // ITEM 3 behavioural — a blank yields no row at all.
  const store3 = await prisma.store.create({
    data: { userId: user.id, name: "Quiet Co", slug: "quiet-co", description: "Generated copy about Quiet Co." },
  });
  await recordOwnerFacts({
    storeId: store3.id, userId: user.id,
    facts: { offering: null, intent: "just something calm", modelExtracted: false, source: "onboarding_form" },
  });
  const q = await readOwnerFacts(store3.id);
  eq("no offering record where they said nothing", q.offering, null);
  assert("and it was NOT filled from the store description",
    q.offering !== "Generated copy about Quiet Co.");
  eq("while what they did say is kept", q.intent, "just something calm");

  // =====================================================================
  // ITEMS 4, 5, 6 — the consumers
  // =====================================================================
  console.log("\n=== consumers ===\n");

  const profile = await getBusinessProfile(store.id);
  eq("the profile exposes offering", profile.identity.offering, "Performance gym clothing and accessories");
  eq("and intent", profile.identity.intent, "Dark luxury fitness brand");
  eq("beside the generated description, not merged into it",
    profile.identity.description, "A rustic candle house.");

  const digest = await digestFor(store.id);
  eq("the digest carries offering", digest.offering, "Performance gym clothing and accessories");
  assert("and renders it where J4 will read it",
    renderDigest(digest).includes("Offers: Performance gym clothing and accessories"));

  // ITEM 6 CONTROL — a store with a description but no record.
  const d3 = await digestFor(store3.id);
  eq("no record means no digest offering", d3.offering, null);
  assert("and the description is not substituted",
    !renderDigest(d3).includes("Generated copy about Quiet Co."));

  // =====================================================================
  // ITEM 13 — visionStatement stays derived copy
  // =====================================================================
  console.log("\n=== intent is not visionStatement ===\n");

  const store4 = await prisma.store.create({
    data: {
      userId: user.id, name: "Northlight", slug: "northlight",
      blueprint: { brandIdentity: { visionStatement: "To light every slow evening in the country." } },
    },
  });
  const p4 = await getBusinessProfile(store4.id);
  eq("a store with a visionStatement still has no intent", p4.identity.intent, null);
  eq("and the visionStatement is untouched where it belongs",
    p4.identity.visionStatement, "To light every slow evening in the country.");
  assert("the two are never the same value", p4.identity.intent !== p4.identity.visionStatement);

  // SOURCE LEVEL, comments stripped. The reader must not learn to reach for
  // one when the other is missing.
  const ownerFactsSrc = codeOnly(readFileSync(join(process.cwd(), "lib/businessModel/ownerFacts.ts"), "utf8"));
  assert("the writer never reads brandIdentity", !ownerFactsSrc.includes("brandIdentity"));
  assert("the writer never reads a store description", !/store\.description|draft\.description/.test(ownerFactsSrc));
  assert("and holds no fallback chain into generated copy",
    !/ownerOffering\s*\?\?|ownerIntent\s*\?\?|inputVision\s*\?\?/.test(ownerFactsSrc),
    "?? into generated copy is the exact defect this replaced");

  const aiActions = codeOnly(readFileSync(join(process.cwd(), "app/dashboard/ai-actions.ts"), "utf8"));
  assert("confirmation no longer falls back through description to a vision",
    !aiActions.includes("draft.inputVision ?? draft.description"),
    "the chain that made vision and description interchangeable");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
