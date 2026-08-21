import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// Supplier economics, and the whole journey they unlock:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-economics-live.ts" -OutFile out.txt
//
// The progression engine could always reason about minimums, bulk pricing and
// margins. Nothing in production could tell it any of them, so every deepen
// honestly reported as an unblock. This is the layer that closes that — without
// inventing a single number.
//
// The write contract is proven in verify-economics-ingest.ts. This proves what
// the engine DOES with what was written: what it includes in a cost, what it
// refuses to quote, what it qualifies, and what it says when it cannot tell.
//
// Section 9 is the point of the whole thing: somebody with no money at all,
// followed from nothing to owning their best product.

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

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const {
    supplierEconomics, bulkTerms, missingEconomics, readTiers, tierProblem,
    integrityDiagnostic, anyTermsRecorded, provenanceOf, NO_TERMS,
  } = await import("@/lib/sourcing/economics");
  const { ingestFromSupplier, recordOwnerQuote, recordUnavailable } =
    await import("@/lib/sourcing/economicsIngest");
  const { currentFreshnessPolicy, freshnessOf } = await import("@/lib/sourcing/economicsPolicy");
  const { assessFeasibility, decide } = await import("@/lib/sourcing/feasibility");
  const { methodProfile } = await import("@/lib/sourcing/methodProfile");
  const { nextMoves } = await import("@/lib/sourcing/nextMoves");
  const { businessStage, capitalPosture, stateCapital, productEvidence, earnedRungs } =
    await import("@/lib/sourcing/progression");
  const { findGraduationOpportunities, conditionsOf, recordProgressionDecision } =
    await import("@/lib/sourcing/graduation");
  const { currentPolicy } = await import("@/lib/sourcing/progressionPolicy");
  const { prismaSystem: prisma } = await import("@/lib/prisma");
  const POLICY = currentPolicy();
  const FRESHNESS = currentFreshnessPolicy();

  const FITS = { verdict: "fits" as const, score: 10, reasons: ["ok"], concerns: [], basedOn: [] };

  async function reset() {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
        AND tablename <> '_genesis_test_database'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
  }

  const makeUser = (email: string) => prisma.user.create({ data: { email } });
  const makeStore = (userId: string, slug: string, description: string) =>
    prisma.store.create({
      data: {
        userId, name: `${slug} co`, slug, tagline: "t", description,
        brandPositioning: "minimalist", currency: "USD",
      },
    });

  const ref = (sourceKey: string, externalProductId: string, externalVariantId: string | null = null) => ({
    sourceKey, externalProductId, externalVariantId,
  });

  let seq = 0;
  const sell = (storeId: string, productId: string, when: Date, quantity = 1) =>
    prisma.order.create({
      data: {
        storeId, productId, productName: "x", quantity,
        amountInCents: 1_800 * quantity, buyerEmail: "b@example.test", status: "paid",
        paymentProvider: "STRIPE", externalOrderId: `cs_${++seq}`, createdAt: when,
      },
    });

  /** A store with one dropship product that has genuinely earned rung 1. */
  async function provenBusiness(slug: string) {
    const user = await makeUser(`${slug}@example.test`);
    const store = await makeStore(user.id, slug, "A fitness and recovery brand for training at home.");
    const product = await prisma.product.create({
      data: {
        storeId: store.id, name: "Foam roller", description: "recovery training",
        priceInCents: 1_800, costInCents: 980, sourceKind: "WHOLESALE_DROPSHIP",
        sourceKey: "w", externalProductId: "roller-1", active: true,
      },
    });
    await prisma.sourcedProduct.create({
      data: {
        storeId: store.id, sourceKey: "w", externalProductId: "roller-1",
        kind: "WHOLESALE_DROPSHIP", name: "Foam roller",
        adoptedProductId: product.id, status: "ADOPTED",
      },
    });
    for (let i = 0; i < 60; i++) await sell(store.id, product.id, daysAgo(70 - i));
    return { user, store, product };
  }

  try {
    // =======================================================================
    console.log("\n1. Identity is all four parts, always");
    {
      await reset();
      const user = await makeUser("identity@example.test");
      const store = await makeStore(user.id, "identity", "A fitness brand.");

      await ingestFromSupplier({
        storeId: store.id, sourceKey: "supplier-a",
        records: [{ externalProductId: "SHARED", minimumOrderUnits: 50, unitCostInCents: 410 }],
      });
      await ingestFromSupplier({
        storeId: store.id, sourceKey: "supplier-b",
        records: [{ externalProductId: "SHARED", minimumOrderUnits: 5000, unitCostInCents: 9999 }],
      });
      await ingestFromSupplier({
        storeId: store.id, sourceKey: "supplier-a",
        records: [{ externalProductId: "SHARED", externalVariantId: "large", minimumOrderUnits: 200, unitCostInCents: 300 }],
      });

      check("each supplier keeps its own terms", [
        (await supplierEconomics(store.id, ref("supplier-a", "SHARED")))?.minimumOrderUnits,
        (await supplierEconomics(store.id, ref("supplier-b", "SHARED")))?.minimumOrderUnits,
      ], [50, 5000]);
      check("the variant-less row is untouched",
        (await supplierEconomics(store.id, ref("supplier-a", "SHARED")))?.minimumOrderUnits, 50);
      check("and the variant has its own",
        (await supplierEconomics(store.id, ref("supplier-a", "SHARED", "large")))?.minimumOrderUnits, 200);

      const stranger = await makeUser("identity-2@example.test");
      const other = await makeStore(stranger.id, "identity-2", "Something else.");
      check("another business sees nothing",
        await supplierEconomics(other.id, ref("supplier-a", "SHARED")), null);
    }

    // =======================================================================
    console.log("\n2. Three states, and none of them is zero");
    {
      await reset();
      const user = await makeUser("provenance@example.test");
      const store = await makeStore(user.id, "provenance", "A fitness brand.");
      const p = ref("w", "p1");

      // NEVER ASKED.
      check("nothing known yet", await supplierEconomics(store.id, p), null);
      check("and nothing is invented", bulkTerms(null), NO_TERMS);
      check("both gaps are named", missingEconomics(null), ["minimum_order", "bulk_price"]);
      check("and nothing counts as recorded", anyTermsRecorded(NO_TERMS), false);

      // THE SUPPLIER SAID SO.
      await ingestFromSupplier({
        storeId: store.id, sourceKey: "w",
        records: [{ externalProductId: "p1", minimumOrderUnits: 100, unitCostInCents: 410 }],
      });
      const fromSupplier = await supplierEconomics(store.id, p);
      check("recorded as the supplier's own", [provenanceOf(fromSupplier, "minimumOrder"), provenanceOf(fromSupplier, "unitCost")], ["SUPPLIER", "SUPPLIER"]);
      check("with real terms",
        [bulkTerms(fromSupplier).minimumOrderUnits, bulkTerms(fromSupplier).bulkUnitCostInCents], [100, 410]);

      // THE OWNER FOUND OUT. Just as real, and attributed.
      await recordOwnerQuote({
        storeId: store.id, ref: p, minimumOrderUnits: 50, bulkUnitCostInCents: 380,
        userId: user.id, note: "quoted by email",
      });
      const fromOwner = await supplierEconomics(store.id, p);
      check("recorded as the owner's", [provenanceOf(fromOwner, "minimumOrder"), provenanceOf(fromOwner, "unitCost")], ["OWNER", "OWNER"]);
      check("and their figures are used",
        [bulkTerms(fromOwner).minimumOrderUnits, bulkTerms(fromOwner).bulkUnitCostInCents], [50, 380]);
      check("with their note kept", fromOwner?.note, "quoted by email");

      // SOMEBODY LOOKED AND THERE IS NO ANSWER. A different product, because an
      // owner's quote on file is deliberately not erased by a later refusal.
      const p2 = ref("w", "p2");
      await recordUnavailable({ storeId: store.id, ref: p2, note: "supplier will not quote" });
      const unavailable = await supplierEconomics(store.id, p2);
      check("recorded as unavailable", [provenanceOf(unavailable, "minimumOrder"), provenanceOf(unavailable, "unitCost")], ["UNAVAILABLE", "UNAVAILABLE"]);
      check("and resolves to nothing",
        [bulkTerms(unavailable).minimumOrderUnits, bulkTerms(unavailable).bulkUnitCostInCents], [null, null]);
      assert("while remaining a real record", unavailable !== null);
      // The distinction that makes UNAVAILABLE worth storing at all.
      check("which counts as something having been said",
        anyTermsRecorded(bulkTerms(unavailable)), true);
    }

    // =======================================================================
    console.log("\n3. Price breaks, and a partial answer that stays partial");
    {
      await reset();
      const user = await makeUser("tiers@example.test");
      const store = await makeStore(user.id, "tiers", "A fitness brand.");

      await ingestFromSupplier({
        storeId: store.id, sourceKey: "w",
        records: [
          {
            externalProductId: "p1",
            tiers: [
              { minUnits: 50, unitCostInCents: 700 },
              { minUnits: 100, unitCostInCents: 410 },
              { minUnits: 500, unitCostInCents: 300 },
            ],
          },
          // A price without a minimum. One thing said, the other not.
          { externalProductId: "p2", unitCostInCents: 410 },
        ],
      });

      const tiered = await supplierEconomics(store.id, ref("w", "p1"));
      check("tiers are kept in order", tiered?.tiers?.map((t) => t.minUnits), [50, 100, 500]);
      check("the cheapest break is what a bulk purchase means",
        [bulkTerms(tiered).minimumOrderUnits, bulkTerms(tiered).bulkUnitCostInCents], [500, 300]);

      const partial = await supplierEconomics(store.id, ref("w", "p2"));
      check("a price without a minimum is still incomplete",
        [bulkTerms(partial).minimumOrderUnits, bulkTerms(partial).bulkUnitCostInCents], [null, 410]);
      check("and says which half is missing", missingEconomics(partial), ["minimum_order"]);
    }

    // =======================================================================
    console.log("\n4. Broken price breaks are refused, never quietly replaced");
    {
      // The pure rules first — the same validator the writer uses.
      check("valid tiers pass", tierProblem([{ minUnits: 100, unitCostInCents: 410 }]), null);
      check("no tiers is not a problem", readTiers(null), { tiers: null, integrity: { ok: true } });
      check("an empty list is a real answer", readTiers([]), { tiers: [], integrity: { ok: true } });
      assert("a quantity of zero is refused",
        tierProblem([{ minUnits: 0, unitCostInCents: 410 }])?.includes("not a quantity") === true);
      assert("a negative price is refused",
        tierProblem([{ minUnits: 10, unitCostInCents: -1 }])?.includes("not a price") === true);
      assert("two prices for one quantity is the contradiction",
        tierProblem([{ minUnits: 100, unitCostInCents: 410 }, { minUnits: 100, unitCostInCents: 380 }])
          ?.includes("same quantity") === true);
      // NOT a contradiction: a bigger order costing more per unit is odd, and
      // Genesis does not know the supplier's business better than they do.
      check("a non-monotonic price break is odd, not invalid",
        tierProblem([{ minUnits: 100, unitCostInCents: 300 }, { minUnits: 500, unitCostInCents: 400 }]), null);

      await reset();
      const user = await makeUser("broken@example.test");
      const store = await makeStore(user.id, "broken", "A fitness and recovery brand for training at home.");

      // Bad data written PAST the writer, which is the only way it can exist:
      // an import, a migration, or a connector written before the validator.
      const rows: [string, string][] = [
        ["not-a-list", `'{"minUnits":100}'::jsonb`],
        ["not-objects", `'[100, 410]'::jsonb`],
        ["no-quantity", `'[{"unitCostInCents":410}]'::jsonb`],
        ["no-price", `'[{"minUnits":100}]'::jsonb`],
        ["string-price", `'[{"minUnits":100,"unitCostInCents":"410"}]'::jsonb`],
        ["duplicate-quantity", `'[{"minUnits":100,"unitCostInCents":410},{"minUnits":100,"unitCostInCents":380}]'::jsonb`],
      ];
      for (const [id, json] of rows) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "SupplierEconomics"
             ("id","storeId","sourceKey","externalProductId","externalVariantId","currency",
              "unitCostInCents","unitCostProvenance","unitCostStatedAt",
              "minimumOrderUnits","minimumOrderProvenance","minimumOrderStatedAt",
              "tiers","tiersProvenance","tiersStatedAt",
              "requiresCapabilities","updatedAt")
           VALUES (gen_random_uuid()::text, $1, 'w', $2, '', 'USD',
                   410, 'SUPPLIER', NOW(),
                   100, 'SUPPLIER', NOW(),
                   ${json}, 'SUPPLIER', NOW(),
                   ARRAY[]::TEXT[], NOW())`,
          store.id, id
        );
      }

      for (const [id] of rows) {
        const broken = await supplierEconomics(store.id, ref("w", id));
        assert(`${id}: the record is marked unusable`, broken?.integrity.ok === false,
          JSON.stringify(broken?.integrity));
        // THE FAILURE THIS PREVENTS. Both flat figures are present and would
        // have produced a confident 100 x 410 with nothing indicating the price
        // breaks were nonsense.
        check(`${id}: nothing is quoted from it`,
          [bulkTerms(broken).minimumOrderUnits, bulkTerms(broken).bulkUnitCostInCents], [null, null]);
        assert(`${id}: and it is named as the problem`,
          missingEconomics(broken).includes("unusable_tiers"), missingEconomics(broken).join(", "));
        const diagnostic = integrityDiagnostic(store.id, broken!);
        assert(`${id}: with an operator diagnostic naming the row`,
          diagnostic !== null && diagnostic.includes(id) && diagnostic.includes(store.id),
          diagnostic ?? "none");
      }

      // A valid record beside them is unaffected.
      await ingestFromSupplier({
        storeId: store.id, sourceKey: "w",
        records: [{ externalProductId: "fine", tiers: [{ minUnits: 100, unitCostInCents: 410 }] }],
      });
      check("a valid record beside them still quotes", [
        bulkTerms(await supplierEconomics(store.id, ref("w", "fine"))).minimumOrderUnits,
        bulkTerms(await supplierEconomics(store.id, ref("w", "fine"))).bulkUnitCostInCents,
      ], [100, 410]);

      // AND IT REACHES THE OWNER AS AN HONEST BLOCK. Not silence, not a figure.
      const product = await prisma.product.create({
        data: {
          storeId: store.id, name: "Foam roller", description: "recovery training",
          priceInCents: 1_800, costInCents: 980, sourceKind: "WHOLESALE_DROPSHIP",
          sourceKey: "w", externalProductId: "duplicate-quantity", active: true,
        },
      });
      await prisma.sourcedProduct.create({
        data: {
          storeId: store.id, sourceKey: "w", externalProductId: "duplicate-quantity",
          kind: "WHOLESALE_DROPSHIP", name: "Foam roller",
          // Discovery's own columns hold a plausible figure. It must NOT be used
          // as a fallback for a record we have just established is broken.
          minimumOrderUnits: 25, bulkUnitCostInCents: 900,
          adoptedProductId: product.id, status: "ADOPTED",
        },
      });
      for (let i = 0; i < 60; i++) await sell(store.id, product.id, daysAgo(70 - i));

      const blocked = await nextMoves(store.id);
      check("the owner gets a question, not a quote", blocked.moves[0].kind, "unblock");
      assert("that says the recorded price breaks don't add up",
        blocked.moves[0].evidence.some((e) => e.includes("doesn't add up")),
        blocked.moves[0].evidence.join(" | "));
      // WHAT THE OWNER READS, not the whole object. The earlier version searched
      // the serialised move for "900" and passed by luck until a generated cuid
      // happened to contain "9000" — an assertion that can be defeated by an id
      // is not asserting what it claims to.
      const spoken = [
        blocked.moves[0].recommendation,
        blocked.moves[0].action,
        blocked.moves[0].unlocks,
        ...blocked.moves[0].evidence,
        ...blocked.moves[0].why,
        ...blocked.moves[0].blockers,
      ].join(" | ");
      assert("and no figure from anywhere else is quoted", !spoken.includes("900"), spoken);
    }

    // =======================================================================
    console.log("\n5. Shipping, lead time and what a product demands of the owner");
    {
      const stocked = methodProfile("WHOLESALE_STOCKED");
      // DELIBERATELY SHORT OF THE ORDER. These cases are about what goes INTO
      // the cost, so the outcome has to be the one that carries a cost figure —
      // an owner who can already afford it gets `affordable`, which says nothing
      // about what the total was made of.
      const posture = {
        state: "stated" as const, investableCents: 1_000,
        capabilities: ["hold_stock" as const], currency: "USD", statedAt: new Date(),
      };
      const wellFunded = { ...posture, investableCents: 50_000 };
      const evidence = {
        productId: "p", unitsSold: 60, windowDays: 70, unitsPerWeek: 6,
        netRevenueCents: 60 * 1_800, netMarginCents: 60 * 820, marginPerUnitCents: 820,
        returnRate: 0, currency: "USD",
        refundedUnits: 0, orderCount: 60, firstSoldAt: daysAgo(70),
      };
      const base = { ...NO_TERMS, minimumOrderUnits: 100, bulkUnitCostInCents: 410 };

      // SHIPPING IS MONEY THAT LEAVES THE OWNER'S HANDS TO GET THE ORDER.
      const noShipping = assessFeasibility({ profile: stocked, posture, supplier: base, evidence, currency: "USD" });
      const withShipping = assessFeasibility({
        profile: stocked, posture,
        supplier: { ...base, shippingPerUnitInCents: 60 },
        evidence, currency: "USD",
      });
      check("without a shipping figure the order is 100 x 410",
        noShipping.kind === "not_yet" ? noShipping.upfrontCents : null, 41_000);
      check("with one it is 100 x 470",
        withShipping.kind === "not_yet" ? withShipping.upfrontCents : null, 47_000);

      // A STATED ZERO IS AN ANSWER — "delivery included" — not an unknown.
      const included = assessFeasibility({
        profile: stocked, posture, supplier: { ...base, shippingPerUnitInCents: 0, leadTimeDays: 14 },
        evidence, currency: "USD",
      });
      check("a stated zero completes the figure",
        included.kind === "not_yet" ? included.costBasis : null, "complete");
      check("and nothing needs qualifying",
        included.kind === "not_yet" ? included.confidence.level : null, "firm");
      check("while nobody having said leaves it a floor",
        noShipping.kind === "not_yet" ? noShipping.costBasis : null, "excludes_shipping");

      const floorOutcome = decide(FITS, noShipping);
      assert("and the owner is told the total is a floor",
        floorOutcome.kind === "not_yet" && floorOutcome.blockers.some((b) => b.includes("at least")),
        JSON.stringify(floorOutcome));
      const completeOutcome = decide(FITS, withShipping);
      assert("whereas a complete figure is stated flat",
        completeOutcome.kind === "not_yet" && !completeOutcome.blockers.some((b) => b.includes("at least")),
        JSON.stringify(completeOutcome));

      // LEAD TIME IS PART OF PAYBACK. The clock starts when the money leaves.
      const instant = assessFeasibility({
        profile: stocked, posture, supplier: { ...base, shippingPerUnitInCents: 0 }, evidence, currency: "USD",
      });
      const slow = assessFeasibility({
        profile: stocked, posture,
        supplier: { ...base, shippingPerUnitInCents: 0, leadTimeDays: 28 },
        evidence, currency: "USD",
      });
      const instantWeeks = instant.kind === "not_yet" ? instant.paybackWeeks : null;
      const slowWeeks = slow.kind === "not_yet" ? slow.paybackWeeks : null;
      assert("a four-week lead time is four more weeks of payback",
        instantWeeks !== null && slowWeeks === instantWeeks + 4, `${instantWeeks} vs ${slowWeeks}`);
      assert("and an unknown lead time says the timing starts when stock lands",
        instant.kind === "not_yet" &&
          instant.confidence.caveats.some((c) => c.includes("how long they take to arrive")),
        JSON.stringify(instant.kind === "not_yet" ? instant.confidence : null));

      // WHAT THE PRODUCT DEMANDS, ON TOP OF WHAT THE METHOD DEMANDS.
      const needsArtwork = assessFeasibility({
        profile: stocked, posture,
        supplier: { ...base, shippingPerUnitInCents: 0, leadTimeDays: 7, requiresCapabilities: ["provide_artwork"] },
        evidence, currency: "USD",
      });
      check("a product needing artwork is not affordable to somebody without it", needsArtwork.kind, "not_yet");
      check("and the capability is named",
        needsArtwork.kind === "not_yet" ? needsArtwork.missingCapabilities : null, ["provide_artwork"]);
      const capable = assessFeasibility({
        profile: stocked,
        posture: { ...wellFunded, capabilities: ["hold_stock", "provide_artwork"] },
        supplier: { ...base, shippingPerUnitInCents: 0, leadTimeDays: 7, requiresCapabilities: ["provide_artwork"] },
        evidence, currency: "USD",
      });
      check("an owner who has it can afford it", capable.kind, "affordable");

      // AND IT APPLIES AT RUNG 0 TOO, where there is no money involved at all.
      const dropship = assessFeasibility({
        profile: methodProfile("WHOLESALE_DROPSHIP"),
        posture: { ...posture, capabilities: [] },
        supplier: { ...NO_TERMS, requiresCapabilities: ["provide_artwork"] },
        evidence: null, currency: "USD",
      });
      check("a dropship product needing artwork is blocked on it too",
        dropship.kind === "not_yet" ? dropship.missingCapabilities : null, ["provide_artwork"]);
      check("and it still costs nothing",
        dropship.kind === "not_yet" ? dropship.upfrontCents : null, 0);
    }

    // =======================================================================
    console.log("\n6. Old figures qualify a recommendation, they do not withdraw it");
    {
      // The policy itself: three windows, three reasons.
      const now = new Date("2026-08-20T00:00:00Z");
      check("a fresh owner quote is fresh",
        freshnessOf("OWNER", new Date("2026-08-01T00:00:00Z"), now, FRESHNESS).state, "fresh");
      check("a five-month-old one is stale",
        freshnessOf("OWNER", new Date("2026-03-01T00:00:00Z"), now, FRESHNESS).state, "stale");
      check("a catalogue sync goes stale sooner",
        freshnessOf("SUPPLIER", new Date("2026-06-20T00:00:00Z"), now, FRESHNESS).state, "stale");
      check("and the same date is still fresh for an owner",
        freshnessOf("OWNER", new Date("2026-06-20T00:00:00Z"), now, FRESHNESS).state, "fresh");

      await reset();
      const { user, store } = await provenBusiness("stale-terms");
      await stateCapital(store.id, 45_000, ["hold_stock"]);
      await recordOwnerQuote({
        storeId: store.id, ref: ref("w", "roller-1"),
        minimumOrderUnits: 100, bulkUnitCostInCents: 410,
        shippingPerUnitInCents: 0, leadTimeDays: 14,
        userId: user.id, now: daysAgo(200),
      });

      const stale = await nextMoves(store.id);
      // IT DOES NOT BLOCK. Replacing a slightly old truth with "I don't know"
      // is strictly less true, and the owner loses the recommendation entirely.
      check("the recommendation still stands", stale.moves[0].kind, "deepen");
      check("and is still actionable today", stale.moves[0].outcome.kind, "recommended_now");
      // IT ARRIVES CARRYING ITS OWN AGE.
      assert("but it says how old the figures are",
        stale.moves[0].caveats.some((c) => c.includes("months ago")), stale.moves[0].caveats.join(" | "));
      assert("and whose figures they are",
        stale.moves[0].caveats.some((c) => c.includes("You gave me")), stale.moves[0].caveats.join(" | "));

      // A fresh quote for the same product carries nothing.
      await recordOwnerQuote({
        storeId: store.id, ref: ref("w", "roller-1"),
        minimumOrderUnits: 100, bulkUnitCostInCents: 410,
        shippingPerUnitInCents: 0, leadTimeDays: 14, userId: user.id,
      });
      const fresh = await nextMoves(store.id);
      check("a fresh quote needs no caveat", fresh.moves[0].caveats, []);
      // AND THE TIEBREAK IS A TIEBREAK, not a penalty: same move, higher score.
      assert("a firm figure outranks the same figure gone stale",
        fresh.moves[0].score > stale.moves[0].score, `${stale.moves[0].score} -> ${fresh.moves[0].score}`);
    }

    // =======================================================================
    console.log("\n7. A closed door reopens; a fresh refusal stays shut");
    {
      await reset();
      const { store } = await provenBusiness("unavailable-ageing");
      await recordUnavailable({ storeId: store.id, ref: ref("w", "roller-1") });

      const recent = await nextMoves(store.id);
      check("it still cannot be assessed", recent.moves[0].kind, "unblock");
      assert("and asking the same supplier again is not the ask",
        recent.moves[0].action.includes("another supplier"), recent.moves[0].action);

      // THE ONE PLACE STALENESS CHANGES BEHAVIOUR RATHER THAN WORDING. Past the
      // window, "they wouldn't say" stops being a reason not to ask.
      await prisma.supplierEconomics.updateMany({
        where: { storeId: store.id },
        data: { minimumOrderStatedAt: daysAgo(120), unitCostStatedAt: daysAgo(120) },
      });
      const aged = await nextMoves(store.id);
      check("still a question", aged.moves[0].kind, "unblock");
      assert("but now it is worth asking them again",
        aged.moves[0].action.includes("Worth asking again"), aged.moves[0].action);
      assert("and it says how long it has been",
        aged.moves[0].action.includes("months"), aged.moves[0].action);
    }

    // =======================================================================
    console.log("\n8. Without economics, J4 asks — and says why it matters");
    {
      await reset();
      const { store } = await provenBusiness("ask");

      const asking = await nextMoves(store.id);
      check("the question leads", asking.moves[0].kind, "unblock");
      assert("naming the minimum order",
        asking.moves[0].evidence.some((e) => e.includes("how many the supplier makes you order")),
        asking.moves[0].evidence.join(" | "));
      assert("and why it matters",
        asking.moves[0].evidence.some((e) => e.includes("what buying in bulk would actually cost")),
        asking.moves[0].evidence.join(" | "));
      assert("naming the price too",
        asking.moves[0].evidence.some((e) => e.includes("what they charge per unit")),
        asking.moves[0].evidence.join(" | "));
      assert("asking something answerable",
        asking.moves[0].action.includes("how many"), asking.moves[0].action);

      check("no economics were invented", await supplierEconomics(store.id, ref("w", "roller-1")), null);
    }

    // =======================================================================
    console.log("\n9. THE WHOLE JOURNEY: no capital to owning the best product");
    {
      await reset();
      const user = await makeUser("journey@example.test");
      const store = await makeStore(
        user.id, "iron-gym",
        "A fitness and recovery brand for people who train at home."
      );

      // --- STAGE ONE: nothing. No money, no sales, no stock. ---------------
      check("stated capital: nothing", (await capitalPosture(store.id)).state, "unstated");
      check("stage: exploring", await businessStage(store.id), "exploring");

      await prisma.sourcedProduct.create({
        data: {
          storeId: store.id, sourceKey: "w", externalProductId: "roller-1",
          kind: "WHOLESALE_DROPSHIP", name: "Foam roller for recovery training",
          description: "A recovery and training tool for use at home",
          score: 25, status: "SUGGESTED",
        },
      });

      const step1 = await nextMoves(store.id);
      check("J4 says: start", step1.moves[0].kind, "start");
      assert("with something that costs nothing up front",
        step1.moves[0].evidence.some((e) => e.includes("nothing")), step1.moves[0].evidence.join(" | "));

      // --- STAGE TWO: they sell. Still nothing bought. ---------------------
      const roller = await prisma.product.create({
        data: {
          storeId: store.id, name: "Foam roller for recovery training",
          description: "A recovery and training tool for use at home",
          priceInCents: 1_800, costInCents: 980, sourceKind: "WHOLESALE_DROPSHIP",
          sourceKey: "w", externalProductId: "roller-1", active: true,
        },
      });
      await prisma.sourcedProduct.updateMany({
        where: { storeId: store.id, externalProductId: "roller-1" },
        data: { status: "ADOPTED", adoptedProductId: roller.id },
      });
      for (let i = 0; i < 60; i++) await sell(store.id, roller.id, daysAgo(70 - i));

      check("stage: proven", await businessStage(store.id), "proven");
      const evidence = await productEvidence(store.id, roller.id);
      check("on real units", evidence.unitsSold, 60);
      check("and the product has earned a better way of being bought", earnedRungs(evidence, POLICY), [1]);
      check("capital is still unstated", (await capitalPosture(store.id)).state, "unstated");

      // --- STAGE THREE: better economics exist, but nobody knows them ------
      check("J4 asks the question that would unlock it",
        (await nextMoves(store.id)).moves[0].kind, "unblock");

      // --- STAGE FOUR: the owner finds out ---------------------------------
      await recordOwnerQuote({
        storeId: store.id, ref: ref("w", "roller-1"),
        minimumOrderUnits: 100, bulkUnitCostInCents: 410,
        shippingPerUnitInCents: 0, leadTimeDays: 14,
        userId: user.id, note: "called them",
      });

      const step4 = await nextMoves(store.id);
      check("J4 now recommends owning it", step4.moves[0].kind, "deepen");
      check("but not yet", step4.moves[0].outcome.kind, "not_yet");
      assert("telling them how far away it is",
        step4.moves[0].blockers.length > 0, step4.moves[0].blockers.join(" | "));
      // Every figure was answered, so nothing is qualified.
      check("and nothing about the figures needs qualifying", step4.moves[0].caveats, []);

      // --- STAGE FIVE: they reinvest what they earned ----------------------
      await stateCapital(store.id, 45_000, ["hold_stock"]);

      const step5 = await nextMoves(store.id);
      check("J4 recommends it outright", step5.moves[0].kind, "deepen");
      check("and it is affordable now", step5.moves[0].outcome.kind, "recommended_now");
      assert("with the saving stated", step5.moves[0].unlocks.includes("%"), step5.moves[0].unlocks);

      // --- STAGE SIX: they take it. The product graduates. -----------------
      const opportunity = (await findGraduationOpportunities(store.id))[0];
      await recordProgressionDecision({
        storeId: store.id, productId: roller.id, toKind: opportunity.toKind, decision: "ACCEPTED",
        conditions: conditionsOf(
          opportunity,
          await capitalPosture(store.id),
          bulkTerms(await supplierEconomics(store.id, ref("w", "roller-1")))
        ),
      });
      await prisma.product.update({
        where: { id: roller.id }, data: { sourceKind: "WHOLESALE_STOCKED", costInCents: 410 },
      });

      check("the business is now committing", await businessStage(store.id), "committing");
      check("and that graduation is not offered again",
        (await findGraduationOpportunities(store.id)).length, 0);

      const finalProduct = await prisma.product.findUniqueOrThrow({ where: { id: roller.id } });
      check("the product is theirs now", finalProduct.sourceKind, "WHOLESALE_STOCKED");
      check("at the better cost", finalProduct.costInCents, 410);
      check("and the numbers came from the owner",
        provenanceOf(await supplierEconomics(store.id, ref("w", "roller-1")), "unitCost"), "OWNER");
    }

    // =======================================================================
    console.log("\n10. A decision declined, and what makes it worth asking again");
    {
      await reset();
      const { user, store } = await provenBusiness("reconsider");
      await stateCapital(store.id, 1_000, ["hold_stock"]);
      await recordOwnerQuote({
        storeId: store.id, ref: ref("w", "roller-1"),
        minimumOrderUnits: 500, bulkUnitCostInCents: 410,
        shippingPerUnitInCents: 0, leadTimeDays: 7, userId: user.id,
      });

      const first = (await findGraduationOpportunities(store.id))[0];
      check("it is offered", first.toKind, "WHOLESALE_STOCKED");
      check("and it is out of reach", first.feasibility.kind, "not_yet");
      await recordProgressionDecision({
        storeId: store.id, productId: first.productId, toKind: first.toKind, decision: "DECLINED",
        // THE REAL TERMS, read back the way the engine reads them. A hand-built
        // shape here would snapshot conditions the engine never saw, and the
        // very next pass would read that difference as the world having moved.
        conditions: conditionsOf(
          first,
          await capitalPosture(store.id),
          bulkTerms(await supplierEconomics(store.id, ref("w", "roller-1")))
        ),
      });

      check("declined, so not raised again",
        (await findGraduationOpportunities(store.id)).filter((o) => o.reconsideration !== null).length, 0);

      // THE SUPPLIER MOVES. Not the owner's mind — a fact they declined on.
      await recordOwnerQuote({
        storeId: store.id, ref: ref("w", "roller-1"),
        minimumOrderUnits: 50, bulkUnitCostInCents: 410,
        shippingPerUnitInCents: 0, leadTimeDays: 7, userId: user.id,
      });
      const again = (await findGraduationOpportunities(store.id))[0];
      check("a lower minimum is worth another ask", again?.reconsideration, "minimum_order_lowered");
      const raised = await nextMoves(store.id);
      assert("and the owner is told why they're seeing it again",
        raised.moves[0].reconsideration !== null, JSON.stringify(raised.moves[0].reconsideration));
    }

    // =======================================================================
    console.log("\n11. Two businesses, two sets of terms, no crossing");
    {
      await reset();
      const owner = await makeUser("shared@example.test");
      const gym = await makeStore(owner.id, "gym-terms", "A fitness brand.");
      const coil = await makeStore(owner.id, "coil-terms", "Hand-wound copper.");
      const p = ref("w", "same-product");

      // The SAME supplier product, negotiated differently by each business.
      await recordOwnerQuote({ storeId: gym.id, ref: p, minimumOrderUnits: 100, bulkUnitCostInCents: 410 });
      await recordOwnerQuote({ storeId: coil.id, ref: p, minimumOrderUnits: 500, bulkUnitCostInCents: 250 });

      check("the gym has its own terms", [
        bulkTerms(await supplierEconomics(gym.id, p)).minimumOrderUnits,
        bulkTerms(await supplierEconomics(gym.id, p)).bulkUnitCostInCents,
      ], [100, 410]);
      check("and the other business has its own", [
        bulkTerms(await supplierEconomics(coil.id, p)).minimumOrderUnits,
        bulkTerms(await supplierEconomics(coil.id, p)).bulkUnitCostInCents,
      ], [500, 250]);

      // A sync into one business does not touch the other.
      await ingestFromSupplier({
        storeId: gym.id, sourceKey: "w",
        records: [{ externalProductId: "same-product", minimumOrderUnits: 9, unitCostInCents: 9 }],
      });
      check("and a sync into one leaves the other alone",
        bulkTerms(await supplierEconomics(coil.id, p)).bulkUnitCostInCents, 250);
      // The gym's own row was an OWNER quote, so the sync was refused there too.
      check("while the gym's own quote is preserved",
        bulkTerms(await supplierEconomics(gym.id, p)).bulkUnitCostInCents, 410);

      await prisma.store.delete({ where: { id: coil.id } });
      check("the surviving business keeps its terms",
        bulkTerms(await supplierEconomics(gym.id, p)).bulkUnitCostInCents, 410);
      check("and the deleted one's are gone",
        await prisma.supplierEconomics.count({ where: { storeId: coil.id } }), 0);
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    await db.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
