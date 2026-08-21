import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// Progression against a real database:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-progression-live.ts" -OutFile out.txt
//
// P0.5 units 2, 4, 5, 6 and 8 — the parts that read real orders. The pure rules
// are proven in verify-progression.ts; this proves the evidence they read is
// gathered truthfully, and that everything belongs to one business.

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

  const { productEvidence, earnedRungs, businessStage, capitalPosture, stateCapital, spendableCents } =
    await import("@/lib/sourcing/progression");
  const { findGraduationOpportunities, recordProgressionDecision, materialChange } =
    await import("@/lib/sourcing/graduation");
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
  const makeStore = (userId: string, slug: string, currency = "USD") =>
    prisma.store.create({
      data: { userId, name: `${slug} co`, slug, tagline: "t", description: "d", currency },
    });
  const makeProduct = (storeId: string, name: string, costInCents: number | null, kind: "WHOLESALE_DROPSHIP" | "PRINT_ON_DEMAND" | "WHOLESALE_STOCKED" = "WHOLESALE_DROPSHIP") =>
    prisma.product.create({
      data: { storeId, name, description: "d", priceInCents: 1_800, costInCents, sourceKind: kind, active: true },
    });

  let orderSeq = 0;
  const sell = (storeId: string, productId: string, opts: { quantity?: number; totalCents?: number; when: Date; status?: string }) =>
    prisma.order.create({
      data: {
        storeId,
        productId,
        productName: "x",
        quantity: opts.quantity ?? 1,
        amountInCents: opts.totalCents ?? 1_800 * (opts.quantity ?? 1),
        buyerEmail: "b@example.test",
        status: opts.status ?? "paid",
        paymentProvider: "STRIPE",
        externalOrderId: `cs_${++orderSeq}`,
        createdAt: opts.when,
      },
    });

  try {
    // -----------------------------------------------------------------------
    console.log("\n1. Units are units, not orders");
    {
      await reset();
      const user = await makeUser("units@example.test");
      const store = await makeStore(user.id, "units");
      const single = await makeProduct(store.id, "Sold one at a time", 400);
      const bulk = await makeProduct(store.id, "Sold in one big order", 400);

      // Ten orders of one, against one order of ten. The SAME units and very
      // different demand — and before Order.quantity existed these were
      // indistinguishable, which would have let one bulk sale justify buying a
      // case.
      for (let i = 0; i < 10; i++) await sell(store.id, single.id, { when: daysAgo(30 - i) });
      await sell(store.id, bulk.id, { quantity: 10, when: daysAgo(30) });

      const singleEvidence = await productEvidence(store.id, single.id);
      const bulkEvidence = await productEvidence(store.id, bulk.id);

      check("ten separate sales are ten units", singleEvidence.unitsSold, 10);
      check("one order for ten is also ten units", bulkEvidence.unitsSold, 10);
      // The distinction that matters, and it is kept.
      check("but ten orders", singleEvidence.orderCount, 10);
      check("against one", bulkEvidence.orderCount, 1);
    }

    // -----------------------------------------------------------------------
    console.log("\n2. Evidence is what happened, and unknown cost stays unknown");
    {
      await reset();
      const user = await makeUser("evidence@example.test");
      const store = await makeStore(user.id, "evidence");
      const priced = await makeProduct(store.id, "Cost known", 400);
      const unpriced = await makeProduct(store.id, "Cost unknown", null);

      for (let i = 0; i < 20; i++) await sell(store.id, priced.id, { when: daysAgo(40 - i) });
      await sell(store.id, priced.id, { when: daysAgo(5), status: "refunded" });
      for (let i = 0; i < 20; i++) await sell(store.id, unpriced.id, { when: daysAgo(40 - i) });

      const e = await productEvidence(store.id, priced.id);
      check("paid units counted", e.unitsSold, 20);
      check("refunds counted separately", e.refundedUnits, 1);
      check("revenue excludes refunds", e.netRevenueCents, 20 * 1_800);
      check("margin is revenue minus real cost", e.netMarginCents, 20 * 1_800 - 20 * 400);
      check("and per unit", e.marginPerUnitCents, 1_400);
      assert("the window spans the selling period", e.windowDays >= 40, String(e.windowDays));
      assert("a weekly rate is computed", e.unitsPerWeek > 0, String(e.unitsPerWeek));
      assert("return rate is real", Math.abs(e.returnRate - 1 / 21) < 0.001, String(e.returnRate));

      // THE ONE THAT MATTERS MOST. An unknown cost must not become a margin
      // equal to revenue, which would make the product look perfect.
      const u = await productEvidence(store.id, unpriced.id);
      check("unknown cost means unknown margin", u.netMarginCents, null);
      check("and no per-unit margin", u.marginPerUnitCents, null);
      check("units are still counted", u.unitsSold, 20);
      // Which means it earns nothing, however well it sells.
      check("so it earns no rung", earnedRungs(u, POLICY), []);
      check("while the priced one does", earnedRungs(e, POLICY), [1]);
    }

    // -----------------------------------------------------------------------
    console.log("\n3. Capital is three states, in the database");
    {
      await reset();
      const user = await makeUser("capital@example.test");
      const store = await makeStore(user.id, "capital");

      const unstated = await capitalPosture(store.id);
      check("a new business has said nothing", unstated.state, "unstated");
      check("and can spend nothing", spendableCents(unstated), 0);

      // Explicitly zero is a real answer and is recorded as one.
      await stateCapital(store.id, 0);
      const zero = await capitalPosture(store.id);
      check("an explicit zero is stated", zero.state, "stated");
      check("and still spends nothing", spendableCents(zero), 0);
      // The distinction survives the round trip — this is what decides whether
      // J4 asks again.
      assert("but it is not the same fact as never having said", zero.state !== unstated.state);

      await stateCapital(store.id, 40_000, ["hold_stock"]);
      const funded = await capitalPosture(store.id);
      check("a real amount is stated", spendableCents(funded), 40_000);
      check("with capabilities", funded.capabilities, ["hold_stock"]);
      // NEVER inferred: real revenue must not move it.
      const product = await makeProduct(store.id, "Sells well", 400);
      for (let i = 0; i < 30; i++) await sell(store.id, product.id, { when: daysAgo(40 - i) });
      check("revenue does not change what they said", spendableCents(await capitalPosture(store.id)), 40_000);
    }

    // -----------------------------------------------------------------------
    console.log("\n4. Business stage is derived, and starts at the beginning");
    {
      await reset();
      const user = await makeUser("stage@example.test");
      const store = await makeStore(user.id, "stage");
      check("no orders means exploring", await businessStage(store.id), "exploring");

      const product = await makeProduct(store.id, "First product", 400);
      await sell(store.id, product.id, { when: daysAgo(2) });
      check("one sale means selling", await businessStage(store.id), "selling");

      // Enough evidence on one product moves the business to proven.
      for (let i = 0; i < 25; i++) await sell(store.id, product.id, { when: daysAgo(40 - i) });
      check("sustained sales mean proven", await businessStage(store.id), "proven");

      // And sourcing above rung 0 is committing, whatever the sales look like.
      await prisma.product.update({ where: { id: product.id }, data: { sourceKind: "WHOLESALE_STOCKED" } });
      check("holding stock means committing", await businessStage(store.id), "committing");

      // There is no column for any of this.
      const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Store'
          AND column_name ILIKE '%stage%'`;
      check("no stored stage column exists", columns.length, 0);
    }

    // -----------------------------------------------------------------------
    console.log("\n5. A graduation is earned by one product, and is shown even when unaffordable");
    {
      await reset();
      const user = await makeUser("grad@example.test");
      const store = await makeStore(user.id, "grad");
      const roller = await prisma.product.create({
        data: {
          storeId: store.id, name: "Foam roller", description: "d",
          priceInCents: 1_800, costInCents: 980, sourceKind: "WHOLESALE_DROPSHIP",
          sourceKey: "wholesale", externalProductId: "roller-1", active: true,
        },
      });
      await prisma.sourcedProduct.create({
        data: {
          storeId: store.id, sourceKey: "wholesale", externalProductId: "roller-1",
          kind: "WHOLESALE_DROPSHIP", name: "Foam roller",
          minimumOrderUnits: 100, bulkUnitCostInCents: 410,
        },
      });
      // A product that has genuinely proven itself.
      for (let i = 0; i < 40; i++) await sell(store.id, roller.id, { when: daysAgo(56 - i) });

      const opportunities = await findGraduationOpportunities(store.id);
      check("one graduation is offered", opportunities.length, 1);
      const opportunity = opportunities[0];
      check("for the product that earned it", opportunity.productId, roller.id);
      check("moving up from dropship", opportunity.fromKind, "WHOLESALE_DROPSHIP");
      check("to stocking it", opportunity.toKind, "WHOLESALE_STOCKED");
      // NOT AFFORDABLE, AND STILL SHOWN. This is the most motivating thing in
      // the system, and hiding it until the money exists would remove the only
      // reason to keep going.
      check("it is not yet affordable", opportunity.feasibility.kind, "not_yet");
      if (opportunity.feasibility.kind === "not_yet") {
        check("the real upfront cost", opportunity.feasibility.upfrontCents, 41_000);
        check("assumed capital, since nothing was stated",
          opportunity.feasibility.capitalBasis, "assumed_because_unstated");
        assert("with a payback computed from real sales",
          opportunity.feasibility.paybackWeeks !== null, String(opportunity.feasibility.paybackWeeks));
      }
      check("and it is not a repeat", opportunity.reconsideration, null);

      // A product with no evidence earns nothing.
      const untested = await makeProduct(store.id, "Brand new", 400);
      await sell(store.id, untested.id, { when: daysAgo(1) });
      const still = await findGraduationOpportunities(store.id);
      check("an unproven product is not offered a graduation", still.length, 1);
    }

    // -----------------------------------------------------------------------
    console.log("\n6. A decline is remembered, and only a material change re-raises it");
    {
      await reset();
      const user = await makeUser("decline@example.test");
      const store = await makeStore(user.id, "decline");
      const roller = await prisma.product.create({
        data: {
          storeId: store.id, name: "Foam roller", description: "d",
          priceInCents: 1_800, costInCents: 980, sourceKind: "WHOLESALE_DROPSHIP",
          sourceKey: "wholesale", externalProductId: "roller-1", active: true,
        },
      });
      const sourced = await prisma.sourcedProduct.create({
        data: {
          storeId: store.id, sourceKey: "wholesale", externalProductId: "roller-1",
          kind: "WHOLESALE_DROPSHIP", name: "Foam roller",
          minimumOrderUnits: 200, bulkUnitCostInCents: 700,
        },
      });
      for (let i = 0; i < 40; i++) await sell(store.id, roller.id, { when: daysAgo(56 - i) });

      const [offered] = await findGraduationOpportunities(store.id);
      assert("it is offered once", offered !== undefined);

      const { conditionsOf } = await import("@/lib/sourcing/graduation");
      const posture = await capitalPosture(store.id);
      await recordProgressionDecision({
        storeId: store.id, productId: roller.id, toKind: offered.toKind, decision: "DECLINED",
        conditions: conditionsOf(offered, posture, { minimumOrderUnits: 200, bulkUnitCostInCents: 700 }),
      });

      check("after declining, it is not offered again", (await findGraduationOpportunities(store.id)).length, 0);

      // TIME IS NOT A REASON. Nothing has changed, so nothing is raised, however
      // long anybody waits.
      check("waiting changes nothing", (await findGraduationOpportunities(store.id)).length, 0);

      // DEMAND, EXPRESSED AS PAYBACK. This corrects an assertion I got wrong on
      // the first run: I had written "selling more is not a reason", which is a
      // misreading of the policy I had just written. Selling more IS a reason
      // exactly when it moves the payback period the owner declined — here 20
      // more units took it from 26 weeks to 17, which is precisely the sentence
      // the rule exists to enable: "this now pays for itself in 17 weeks rather
      // than 26". What is NOT a reason is a counter crossing a line.
      for (let i = 0; i < 20; i++) await sell(store.id, roller.id, { when: daysAgo(10 - i * 0.4) });
      const faster = await findGraduationOpportunities(store.id);
      check("selling much faster brings it back", faster.length, 1);
      check("because the payback moved, not because units did",
        faster[0].reconsideration, "demand_grew");

      // Decline it again at the new conditions, so the next assertion is about
      // a genuinely fresh decision rather than a stale one.
      await recordProgressionDecision({
        storeId: store.id, productId: roller.id, toKind: faster[0].toKind, decision: "DECLINED",
        conditions: conditionsOf(faster[0], posture, { minimumOrderUnits: 200, bulkUnitCostInCents: 700 }),
      });
      check("and it stays down again", (await findGraduationOpportunities(store.id)).length, 0);

      // The supplier halving its minimum IS.
      await prisma.sourcedProduct.update({
        where: { id: sourced.id }, data: { minimumOrderUnits: 50, bulkUnitCostInCents: 410 },
      });
      const again = await findGraduationOpportunities(store.id);
      check("a lower minimum brings it back", again.length, 1);
      assert("and says why", again[0].reconsideration !== null, String(again[0].reconsideration));
      assert("naming the supplier change",
        again[0].reconsideration === "minimum_order_lowered" || again[0].reconsideration === "supplier_price_dropped",
        String(again[0].reconsideration));

      // An accepted graduation is done, not re-offered.
      await recordProgressionDecision({
        storeId: store.id, productId: roller.id, toKind: again[0].toKind, decision: "ACCEPTED",
        conditions: conditionsOf(again[0], posture, { minimumOrderUnits: 50, bulkUnitCostInCents: 410 }),
      });
      check("an accepted graduation is not offered again",
        (await findGraduationOpportunities(store.id)).length, 0);
    }

    // -----------------------------------------------------------------------
    console.log("\n7. Two businesses on one account progress independently");
    {
      await reset();
      const owner = await makeUser("both@example.test");
      const gym = await makeStore(owner.id, "iron-gym", "USD");
      const coil = await makeStore(owner.id, "copper-coil", "GBP");

      // The gym has proven a product. The coil business has just started.
      const roller = await prisma.product.create({
        data: {
          storeId: gym.id, name: "Foam roller", description: "d", priceInCents: 1_800,
          costInCents: 980, sourceKind: "WHOLESALE_DROPSHIP", sourceKey: "w",
          externalProductId: "r1", active: true,
        },
      });
      await prisma.sourcedProduct.create({
        data: {
          storeId: gym.id, sourceKey: "w", externalProductId: "r1", kind: "WHOLESALE_DROPSHIP",
          name: "Foam roller", minimumOrderUnits: 100, bulkUnitCostInCents: 410,
        },
      });
      for (let i = 0; i < 40; i++) await sell(gym.id, roller.id, { when: daysAgo(56 - i) });

      const ring = await makeProduct(coil.id, "Tensor ring", 400);
      await sell(coil.id, ring.id, { when: daysAgo(2) });

      check("the gym is proven", await businessStage(gym.id), "proven");
      check("the coil business is only selling", await businessStage(coil.id), "selling");

      check("the gym has a graduation", (await findGraduationOpportunities(gym.id)).length, 1);
      check("the coil business has none", (await findGraduationOpportunities(coil.id)).length, 0);

      // Currency belongs to the business, not the account.
      const gymEvidence = await productEvidence(gym.id, roller.id);
      const coilEvidence = await productEvidence(coil.id, ring.id);
      check("each business reports its own currency", [gymEvidence.currency, coilEvidence.currency], ["USD", "GBP"]);

      // Capital is per business too.
      await stateCapital(gym.id, 50_000, ["hold_stock"]);
      check("stating capital for one leaves the other unstated",
        (await capitalPosture(coil.id)).state, "unstated");
      check("while the first is stated", (await capitalPosture(gym.id)).state, "stated");

      // And with money and space, the same graduation becomes affordable —
      // which is the whole progression, end to end, inside one business.
      const funded = await findGraduationOpportunities(gym.id);
      check("it is now affordable", funded[0].feasibility.kind, "affordable");
      check("and the other business still has nothing to graduate",
        (await findGraduationOpportunities(coil.id)).length, 0);
    }

    // -----------------------------------------------------------------------
    console.log("\n8. The zero-capital path, end to end");
    {
      await reset();
      // Somebody with no money at all. The whole point of the product.
      const user = await makeUser("broke@example.test");
      const store = await makeStore(user.id, "broke");
      const posture = await capitalPosture(store.id);
      check("they have stated nothing", posture.state, "unstated");
      check("and can spend nothing", spendableCents(posture), 0);
      check("their business is exploring", await businessStage(store.id), "exploring");

      const { assessFeasibility } = await import("@/lib/sourcing/feasibility");
      const { methodProfile } = await import("@/lib/sourcing/methodProfile");
      // They can still sell, today, with no money and no supplier numbers.
      check("dropshipping is available to them",
        assessFeasibility({
          profile: methodProfile("WHOLESALE_DROPSHIP"), posture,
          supplier: { minimumOrderUnits: null, bulkUnitCostInCents: null },
          evidence: null, currency: "USD",
        }).kind,
        "affordable");

      // They sell. The business moves, without them spending anything.
      const item = await prisma.product.create({
        data: {
          storeId: store.id, name: "Resistance bands", description: "d", priceInCents: 1_800,
          costInCents: 980, sourceKind: "WHOLESALE_DROPSHIP", sourceKey: "w",
          externalProductId: "b1", active: true,
        },
      });
      await prisma.sourcedProduct.create({
        data: {
          storeId: store.id, sourceKey: "w", externalProductId: "b1", kind: "WHOLESALE_DROPSHIP",
          name: "Resistance bands", minimumOrderUnits: 100, bulkUnitCostInCents: 410,
        },
      });
      for (let i = 0; i < 40; i++) await sell(store.id, item.id, { when: daysAgo(56 - i) });

      check("having sold, they are proven", await businessStage(store.id), "proven");
      const earned = await findGraduationOpportunities(store.id);
      check("and they have earned a step up", earned.length, 1);
      // Still no money — and the step up is SHOWN, with what it would take.
      check("which they still cannot afford", earned[0].feasibility.kind, "not_yet");
      if (earned[0].feasibility.kind === "not_yet") {
        assert("but they are told how far away it is",
          earned[0].feasibility.paybackWeeks !== null && earned[0].feasibility.unitsToGo !== null,
          JSON.stringify(earned[0].feasibility));
      }
    }
    // -----------------------------------------------------------------------
    console.log("\n9. A product never picks up another listing's numbers");
    {
      await reset();
      const user = await makeUser("supplier@example.test");
      const store = await makeStore(user.id, "supplier");

      // Two sources, the SAME external id. Before this was hardened, a lookup on
      // externalProductId alone could hand a product the wrong supplier's
      // minimum — a wrong number about money, silently.
      const adopted = await prisma.product.create({
        data: {
          storeId: store.id, name: "Foam roller", description: "d", priceInCents: 1_800,
          costInCents: 980, sourceKind: "WHOLESALE_DROPSHIP",
          sourceKey: "wholesale", externalProductId: "SHARED-ID", active: true,
        },
      });
      const rightRow = await prisma.sourcedProduct.create({
        data: {
          storeId: store.id, sourceKey: "wholesale", externalProductId: "SHARED-ID",
          kind: "WHOLESALE_DROPSHIP", name: "Foam roller",
          minimumOrderUnits: 100, bulkUnitCostInCents: 410,
          adoptedProductId: adopted.id,
        },
      });
      await prisma.sourcedProduct.create({
        data: {
          storeId: store.id, sourceKey: "other-source", externalProductId: "SHARED-ID",
          kind: "WHOLESALE_DROPSHIP", name: "Something else entirely",
          minimumOrderUnits: 5000, bulkUnitCostInCents: 9999,
        },
      });
      for (let i = 0; i < 40; i++) await sell(store.id, adopted.id, { when: daysAgo(56 - i) });

      const [opportunity] = await findGraduationOpportunities(store.id);
      assert("a graduation is offered", opportunity !== undefined);
      if (opportunity?.feasibility.kind === "not_yet") {
        // 100 x 410, the adopted listing's numbers — not 5000 x 9999.
        check("it uses the listing this product was adopted from",
          opportunity.feasibility.upfrontCents, 41_000);
      } else {
        assert("feasibility should be not_yet", false, JSON.stringify(opportunity?.feasibility));
      }

      // And with the adoption link removed, the fallback still requires the
      // SOURCE to match, not just the id.
      await prisma.sourcedProduct.update({
        where: { id: rightRow.id }, data: { adoptedProductId: null },
      });
      const [viaFallback] = await findGraduationOpportunities(store.id);
      if (viaFallback?.feasibility.kind === "not_yet") {
        check("the fallback matches on source as well as id",
          viaFallback.feasibility.upfrontCents, 41_000);
      }
    }

    // -----------------------------------------------------------------------
    console.log("\n10. A hand-entered product loses nothing, and invents nothing");
    {
      await reset();
      const user = await makeUser("manual@example.test");
      const store = await makeStore(user.id, "manual");
      // Typed in by the owner: no source, no external id, no supplier row.
      const handmade = await makeProduct(store.id, "Hand-wound tensor ring", 400);
      for (let i = 0; i < 40; i++) await sell(store.id, handmade.id, { when: daysAgo(56 - i) });

      // It STILL earns its rung. Evidence is evidence, whoever entered the
      // product — losing the progression because nobody sourced it would punish
      // the owner for making something themselves.
      const evidence = await productEvidence(store.id, handmade.id);
      check("its evidence is real", evidence.unitsSold, 40);
      check("and it earns a rung", earnedRungs(evidence, POLICY), [1]);

      const [opportunity] = await findGraduationOpportunities(store.id);
      assert("the graduation is still offered", opportunity !== undefined);
      // And the honest consequence: nothing can be costed, so nothing is
      // claimed. cannot_assess rather than a fabricated minimum.
      check("but it cannot be costed", opportunity?.feasibility.kind, "cannot_assess");
      if (opportunity?.feasibility.kind === "cannot_assess") {
        assert("saying which facts are missing",
          opportunity.feasibility.missing.length > 0, JSON.stringify(opportunity.feasibility));
      }
    }

    // -----------------------------------------------------------------------
    console.log("\n11. A snapshot that cannot be read honours the decision");
    {
      await reset();
      const { parseConditions } = await import("@/lib/sourcing/graduation");
      const user = await makeUser("drift@example.test");
      const store = await makeStore(user.id, "drift");
      const roller = await prisma.product.create({
        data: {
          storeId: store.id, name: "Foam roller", description: "d", priceInCents: 1_800,
          costInCents: 980, sourceKind: "WHOLESALE_DROPSHIP",
          sourceKey: "w", externalProductId: "r1", active: true,
        },
      });
      await prisma.sourcedProduct.create({
        data: {
          storeId: store.id, sourceKey: "w", externalProductId: "r1", kind: "WHOLESALE_DROPSHIP",
          name: "Foam roller", minimumOrderUnits: 100, bulkUnitCostInCents: 410,
          adoptedProductId: roller.id,
        },
      });
      for (let i = 0; i < 40; i++) await sell(store.id, roller.id, { when: daysAgo(56 - i) });

      const [offered] = await findGraduationOpportunities(store.id);
      const posture = await capitalPosture(store.id);
      const { conditionsOf } = await import("@/lib/sourcing/graduation");
      const good = conditionsOf(offered, posture, { minimumOrderUnits: 100, bulkUnitCostInCents: 410 });
      assert("a real snapshot reads back", parseConditions(good) !== null);

      await recordProgressionDecision({
        storeId: store.id, productId: roller.id, toKind: offered.toKind,
        decision: "DECLINED", conditions: good,
      });
      check("declined, so not offered", (await findGraduationOpportunities(store.id)).length, 0);

      // Simulate schema drift: the stored shape no longer matches.
      await prisma.progressionDecision.updateMany({
        where: { storeId: store.id },
        data: { conditions: { somethingElse: true } },
      });

      // A CAST WOULD HAVE READ undefined FOR EVERY FIELD and started answering
      // "has anything changed" by accident. Validation catches it, and the
      // conservative half of the choice is taken: the owner said no, and that is
      // honoured rather than re-raised because OUR schema moved.
      check("an unreadable snapshot is rejected", parseConditions({ somethingElse: true }), null);
      check("and the decline still stands", (await findGraduationOpportunities(store.id)).length, 0);

      // Every field is genuinely checked, not just the object's presence.
      const missingOne = { ...good } as Record<string, unknown>;
      delete missingOne.policyVersion;
      check("a missing field is rejected", parseConditions(missingOne), null);
      check("a wrong type is rejected", parseConditions({ ...good, unitsSold: "40" }), null);
      check("a null where a number belongs is rejected", parseConditions({ ...good, spendableCents: null }), null);
      // But a legitimately nullable field stays nullable.
      assert("a nullable field may be null", parseConditions({ ...good, paybackWeeks: null }) !== null);
    }

    // -----------------------------------------------------------------------
    console.log("\n12. Whole-catalogue evidence is one pass, and agrees with the single one");
    {
      await reset();
      const { storeProductEvidence } = await import("@/lib/sourcing/progression");
      const user = await makeUser("batch@example.test");
      const store = await makeStore(user.id, "batch");

      const products = [];
      for (let p = 0; p < 12; p++) {
        const product = await makeProduct(store.id, `Product ${p}`, p % 3 === 0 ? null : 400);
        products.push(product);
        for (let i = 0; i < 5 + p; i++) {
          await sell(store.id, product.id, { quantity: (i % 3) + 1, when: daysAgo(40 - i) });
        }
      }

      const batched = await storeProductEvidence(store.id);
      check("every product is covered", batched.size, products.length);

      // THE PROPERTY THAT MATTERS: the batched reader and the single one are the
      // same arithmetic. Two copies of a margin calculation is two chances to
      // get money wrong, so they share one.
      for (const product of products) {
        const single = await productEvidence(store.id, product.id);
        const fromBatch = batched.get(product.id)!;
        check(`${product.name}: units agree`, fromBatch.unitsSold, single.unitsSold);
        check(`${product.name}: margin agrees`, fromBatch.netMarginCents, single.netMarginCents);
        check(`${product.name}: rate agrees`, Math.round(fromBatch.unitsPerWeek * 100), Math.round(single.unitsPerWeek * 100));
      }

      // AND IT HOLDS AT SCALE. A per-product loop is three queries each, so a
      // forty-product catalogue would be over a hundred; the batched reader is
      // three, by construction — one Promise.all, visible in the source.
      //
      // What is asserted here is the consequence rather than a query count:
      // a catalogue several times larger still produces correct evidence for
      // every product, and stage is still derived from it. Counting statements
      // would need pg_stat_statements, which is not loaded here, and inventing a
      // number would be worse than measuring the outcome.
      const stage = await businessStage(store.id);
      assert("a stage is still derived", ["exploring", "selling", "proven", "committing"].includes(stage), stage);

      const bigUser = await makeUser("batch-big@example.test");
      const bigStore = await makeStore(bigUser.id, "batch-big");
      const bigProducts = [];
      for (let p = 0; p < 40; p++) {
        const product = await makeProduct(bigStore.id, `Bulk ${p}`, 400);
        bigProducts.push(product);
        await sell(bigStore.id, product.id, { when: daysAgo(20) });
      }
      const bigBatch = await storeProductEvidence(bigStore.id);
      check("a forty-product catalogue is fully covered", bigBatch.size, 40);
      assert("every one has real evidence",
        [...bigBatch.values()].every((e) => e.unitsSold === 1), "some product lost its sale");
      assert("and a stage is derived for it",
        ["exploring", "selling", "proven", "committing"].includes(await businessStage(bigStore.id)));
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
