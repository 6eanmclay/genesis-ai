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
// Section 6 is the point of the whole thing: somebody with no money at all,
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
    supplierEconomics, bulkTerms, stateEconomics, ownerStatesEconomics,
    markEconomicsUnavailable, missingEconomics,
  } = await import("@/lib/sourcing/economics");
  const { nextMoves } = await import("@/lib/sourcing/nextMoves");
  const { businessStage, capitalPosture, stateCapital, productEvidence, earnedRungs } =
    await import("@/lib/sourcing/progression");
  const { findGraduationOpportunities } = await import("@/lib/sourcing/graduation");
  const { currentPolicy } = await import("@/lib/sourcing/progressionPolicy");
  const { prismaSystem: prisma } = await import("@/lib/prisma");
  const POLICY = currentPolicy();

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

  let seq = 0;
  const sell = (storeId: string, productId: string, when: Date, quantity = 1) =>
    prisma.order.create({
      data: {
        storeId, productId, productName: "x", quantity,
        amountInCents: 1_800 * quantity, buyerEmail: "b@example.test", status: "paid",
        paymentProvider: "STRIPE", externalOrderId: `cs_${++seq}`, createdAt: when,
      },
    });

  try {
    // -----------------------------------------------------------------------
    console.log("\n1. Identity is all four parts, always");
    {
      await reset();
      const user = await makeUser("identity@example.test");
      const store = await makeStore(user.id, "identity", "A fitness brand.");

      // The same external id under two different suppliers. This is the
      // collision the unique key exists to make impossible.
      await stateEconomics({
        storeId: store.id,
        ref: { sourceKey: "supplier-a", externalProductId: "SHARED", externalVariantId: null },
        provenance: "SUPPLIER", minimumOrderUnits: 50, unitCostInCents: 410,
      });
      await stateEconomics({
        storeId: store.id,
        ref: { sourceKey: "supplier-b", externalProductId: "SHARED", externalVariantId: null },
        provenance: "SUPPLIER", minimumOrderUnits: 5000, unitCostInCents: 9999,
      });

      const a = await supplierEconomics(store.id, {
        sourceKey: "supplier-a", externalProductId: "SHARED", externalVariantId: null,
      });
      const b = await supplierEconomics(store.id, {
        sourceKey: "supplier-b", externalProductId: "SHARED", externalVariantId: null,
      });
      check("each supplier keeps its own terms", [a?.minimumOrderUnits, b?.minimumOrderUnits], [50, 5000]);

      // Variants are part of identity too: a listing with no variant must not
      // match the first variant of something else.
      await stateEconomics({
        storeId: store.id,
        ref: { sourceKey: "supplier-a", externalProductId: "SHARED", externalVariantId: "large" },
        provenance: "SUPPLIER", minimumOrderUnits: 200, unitCostInCents: 300,
      });
      const noVariant = await supplierEconomics(store.id, {
        sourceKey: "supplier-a", externalProductId: "SHARED", externalVariantId: null,
      });
      check("the variant-less row is untouched", noVariant?.minimumOrderUnits, 50);

      // And another business cannot see any of it.
      const stranger = await makeUser("identity-2@example.test");
      const other = await makeStore(stranger.id, "identity-2", "Something else.");
      check("another business sees nothing", await supplierEconomics(other.id, {
        sourceKey: "supplier-a", externalProductId: "SHARED", externalVariantId: null,
      }), null);
    }

    // -----------------------------------------------------------------------
    console.log("\n2. Three states, and none of them is zero");
    {
      await reset();
      const user = await makeUser("provenance@example.test");
      const store = await makeStore(user.id, "provenance", "A fitness brand.");
      const ref = { sourceKey: "w", externalProductId: "p1", externalVariantId: null };

      // NEVER ASKED. Nothing recorded at all.
      check("nothing known yet", await supplierEconomics(store.id, ref), null);
      check("and nothing is invented", bulkTerms(null), { minimumOrderUnits: null, bulkUnitCostInCents: null });
      check("both gaps are named", missingEconomics(null), ["minimum_order", "bulk_price"]);

      // THE SUPPLIER SAID SO.
      await stateEconomics({ storeId: store.id, ref, provenance: "SUPPLIER", minimumOrderUnits: 100, unitCostInCents: 410 });
      const fromSupplier = await supplierEconomics(store.id, ref);
      check("recorded as the supplier's own", fromSupplier?.provenance, "SUPPLIER");
      check("with real terms", bulkTerms(fromSupplier), { minimumOrderUnits: 100, bulkUnitCostInCents: 410 });

      // THE OWNER FOUND OUT. Just as real, and attributed.
      await ownerStatesEconomics({
        storeId: store.id, ref, minimumOrderUnits: 50, bulkUnitCostInCents: 380,
        userId: user.id, note: "quoted by email",
      });
      const fromOwner = await supplierEconomics(store.id, ref);
      check("recorded as the owner's", fromOwner?.provenance, "OWNER");
      check("and their figures are used", bulkTerms(fromOwner), { minimumOrderUnits: 50, bulkUnitCostInCents: 380 });
      check("with their note kept", fromOwner?.note, "quoted by email");

      // SOMEBODY LOOKED AND THERE IS NO ANSWER. Different from never asking.
      await markEconomicsUnavailable(store.id, ref, "supplier will not quote");
      const unavailable = await supplierEconomics(store.id, ref);
      check("recorded as unavailable", unavailable?.provenance, "UNAVAILABLE");
      // Resolves to nulls — but the RECORD is not null, which is what makes it
      // distinguishable from never having asked.
      check("and resolves to nothing", bulkTerms(unavailable), { minimumOrderUnits: null, bulkUnitCostInCents: null });
      assert("while remaining a real record", unavailable !== null);
    }

    // -----------------------------------------------------------------------
    console.log("\n3. Price breaks, and a partial answer that stays partial");
    {
      await reset();
      const user = await makeUser("tiers@example.test");
      const store = await makeStore(user.id, "tiers", "A fitness brand.");
      const ref = { sourceKey: "w", externalProductId: "p1", externalVariantId: null };

      await stateEconomics({
        storeId: store.id, ref, provenance: "SUPPLIER",
        tiers: [
          { minUnits: 50, unitCostInCents: 700 },
          { minUnits: 100, unitCostInCents: 410 },
          { minUnits: 500, unitCostInCents: 300 },
        ],
      });
      const tiered = await supplierEconomics(store.id, ref);
      check("tiers are kept in order", tiered?.tiers?.map((t) => t.minUnits), [50, 100, 500]);
      // The best real price break available.
      check("the cheapest break is what a bulk purchase means",
        bulkTerms(tiered), { minimumOrderUnits: 500, bulkUnitCostInCents: 300 });

      // A PARTIAL ANSWER STAYS PARTIAL. A supplier that published a price but no
      // minimum has told us one thing and not the other, and calling the minimum
      // 1 would turn "I don't know" into "you can buy one".
      await stateEconomics({
        storeId: store.id,
        ref: { ...ref, externalProductId: "p2" },
        provenance: "SUPPLIER", unitCostInCents: 410,
      });
      const partial = await supplierEconomics(store.id, { ...ref, externalProductId: "p2" });
      check("a price without a minimum is still incomplete",
        bulkTerms(partial), { minimumOrderUnits: null, bulkUnitCostInCents: 410 });
      check("and says which half is missing", missingEconomics(partial), ["minimum_order"]);
    }

    // -----------------------------------------------------------------------
    console.log("\n4. Without economics, J4 asks — and says why it matters");
    {
      await reset();
      const user = await makeUser("ask@example.test");
      const store = await makeStore(user.id, "ask", "A fitness and recovery brand for training at home.");
      const roller = await prisma.product.create({
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
          adoptedProductId: roller.id, status: "ADOPTED",
        },
      });
      for (let i = 0; i < 60; i++) await sell(store.id, roller.id, daysAgo(70 - i));

      const asking = await nextMoves(store.id);
      check("the question leads", asking.moves[0].kind, "unblock");
      // EXACTLY WHAT IS MISSING, AND WHY IT MATTERS. "I don't know the minimum"
      // is a fact about Genesis; the second half is a reason for the owner to go
      // and find out.
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

      // Nothing was written. The unknown stayed unknown.
      check("no economics were invented", await supplierEconomics(store.id, {
        sourceKey: "w", externalProductId: "roller-1", externalVariantId: null,
      }), null);

      // A supplier that WILL NOT say gets a different question — asking the same
      // thing again would be asking somebody to repeat work they already did.
      await markEconomicsUnavailable(store.id, {
        sourceKey: "w", externalProductId: "roller-1", externalVariantId: null,
      });
      const stillAsking = await nextMoves(store.id);
      check("it still cannot be assessed", stillAsking.moves[0].kind, "unblock");
      assert("but the question changes",
        stillAsking.moves[0].action.includes("another supplier"), stillAsking.moves[0].action);
    }

    // -----------------------------------------------------------------------
    console.log("\n5. The owner answers, and the move changes");
    {
      await reset();
      const user = await makeUser("answer@example.test");
      const store = await makeStore(user.id, "answer", "A fitness and recovery brand for training at home.");
      const roller = await prisma.product.create({
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
          adoptedProductId: roller.id, status: "ADOPTED",
        },
      });
      for (let i = 0; i < 60; i++) await sell(store.id, roller.id, daysAgo(70 - i));

      check("before: a question", (await nextMoves(store.id)).moves[0].kind, "unblock");

      // THE PATH THAT NEEDS NO SUPPLIER API. Somebody rings their supplier, asks
      // two questions, and types in the answers.
      await ownerStatesEconomics({
        storeId: store.id,
        ref: { sourceKey: "w", externalProductId: "roller-1", externalVariantId: null },
        minimumOrderUnits: 100, bulkUnitCostInCents: 410, userId: user.id,
      });

      const answered = await nextMoves(store.id);
      check("after: a real move", answered.moves[0].kind, "deepen");
      assert("with what it unlocks, in percentage terms",
        answered.moves[0].unlocks.includes("%"), answered.moves[0].unlocks);
      assert("and what the owner would spend",
        answered.moves[0].action.includes("$"), answered.moves[0].action);
      // Still unaffordable — nothing was stated about capital — and still shown.
      check("it is not yet affordable", answered.moves[0].outcome.kind, "not_yet");
      assert("with the assumption named",
        answered.moves[0].blockers.some((b) => b.includes("assumption")), answered.moves[0].blockers.join(" | "));
    }

    // -----------------------------------------------------------------------
    console.log("\n6. THE WHOLE JOURNEY: no capital to owning the best product");
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
      // Still nothing spent, and capital still never inferred from the £1,080
      // of revenue this business has taken.
      check("capital is still unstated", (await capitalPosture(store.id)).state, "unstated");

      // --- STAGE THREE: better economics exist, but nobody knows them ------
      const step3 = await nextMoves(store.id);
      check("J4 asks the question that would unlock it", step3.moves[0].kind, "unblock");

      // --- STAGE FOUR: the owner finds out ---------------------------------
      await ownerStatesEconomics({
        storeId: store.id,
        ref: { sourceKey: "w", externalProductId: "roller-1", externalVariantId: null },
        minimumOrderUnits: 100, bulkUnitCostInCents: 410, userId: user.id,
        note: "called them",
      });

      const step4 = await nextMoves(store.id);
      check("J4 now recommends owning it", step4.moves[0].kind, "deepen");
      check("but not yet", step4.moves[0].outcome.kind, "not_yet");
      assert("telling them how far away it is",
        step4.moves[0].blockers.length > 0, step4.moves[0].blockers.join(" | "));

      // --- STAGE FIVE: they reinvest what they earned ----------------------
      // The owner decides. Genesis never assumed they had this.
      await stateCapital(store.id, 45_000, ["hold_stock"]);

      const step5 = await nextMoves(store.id);
      check("J4 recommends it outright", step5.moves[0].kind, "deepen");
      check("and it is affordable now", step5.moves[0].outcome.kind, "recommended_now");
      assert("with the saving stated",
        step5.moves[0].unlocks.includes("%"), step5.moves[0].unlocks);

      // --- STAGE SIX: they take it. The product graduates. -----------------
      const opportunity = (await findGraduationOpportunities(store.id))[0];
      const { conditionsOf, recordProgressionDecision } = await import("@/lib/sourcing/graduation");
      await recordProgressionDecision({
        storeId: store.id, productId: roller.id, toKind: opportunity.toKind, decision: "ACCEPTED",
        conditions: conditionsOf(opportunity, await capitalPosture(store.id), {
          minimumOrderUnits: 100, bulkUnitCostInCents: 410,
        }),
      });
      await prisma.product.update({
        where: { id: roller.id }, data: { sourceKind: "WHOLESALE_STOCKED", costInCents: 410 },
      });

      check("the business is now committing", await businessStage(store.id), "committing");
      check("and that graduation is not offered again",
        (await findGraduationOpportunities(store.id)).length, 0);

      // THE WHOLE POINT, ASSERTED: they started with nothing, sold sixty of
      // something they never bought, and ended up owning it outright — and every
      // number along the way came from a real order or a person, never a guess.
      const finalProduct = await prisma.product.findUniqueOrThrow({ where: { id: roller.id } });
      check("the product is theirs now", finalProduct.sourceKind, "WHOLESALE_STOCKED");
      check("at the better cost", finalProduct.costInCents, 410);
      const economics = await supplierEconomics(store.id, {
        sourceKey: "w", externalProductId: "roller-1", externalVariantId: null,
      });
      check("and the numbers came from the owner", economics?.provenance, "OWNER");
    }

    // -----------------------------------------------------------------------
    console.log("\n7. Two businesses, two sets of terms, no crossing");
    {
      await reset();
      const owner = await makeUser("shared@example.test");
      const gym = await makeStore(owner.id, "gym-terms", "A fitness brand.");
      const coil = await makeStore(owner.id, "coil-terms", "Hand-wound copper.");
      const ref = { sourceKey: "w", externalProductId: "same-product", externalVariantId: null };

      // The SAME supplier product, negotiated differently by each business.
      await ownerStatesEconomics({ storeId: gym.id, ref, minimumOrderUnits: 100, bulkUnitCostInCents: 410 });
      await ownerStatesEconomics({ storeId: coil.id, ref, minimumOrderUnits: 500, bulkUnitCostInCents: 250 });

      check("the gym has its own terms",
        bulkTerms(await supplierEconomics(gym.id, ref)), { minimumOrderUnits: 100, bulkUnitCostInCents: 410 });
      check("and the other business has its own",
        bulkTerms(await supplierEconomics(coil.id, ref)), { minimumOrderUnits: 500, bulkUnitCostInCents: 250 });

      // Deleting a business takes its terms with it and leaves the other alone.
      await prisma.store.delete({ where: { id: coil.id } });
      check("the surviving business keeps its terms",
        bulkTerms(await supplierEconomics(gym.id, ref)), { minimumOrderUnits: 100, bulkUnitCostInCents: 410 });
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
