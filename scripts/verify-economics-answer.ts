import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// THE WHOLE LOOP: J4 asks, the owner answers, the progression moves.
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-economics-answer.ts" -OutFile out.txt
//
// The economics layer could store what a supplier charges and reason about it.
// Nothing could OBTAIN it: J4 produced the right question and there was nowhere
// for an answer to go, so in production the sentence had no destination.
//
// This proves the destination exists, end to end and against real Postgres —
// including the three things it would be easy to get quietly wrong: an owner who
// does not know must write nothing, an answer that changes nothing must
// re-evaluate nothing, and an answer must never land on another supplier's
// product or another business.

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

  const { raiseEconomicsQuestions, economicsDedupeKey, ECONOMICS_TASK_SOURCE } =
    await import("@/lib/sourcing/economicsQuestions");
  const { answerEconomicsQuestion, settleEconomicsQuestion, economicChanges } =
    await import("@/lib/sourcing/economicsAnswer");
  const { supplierEconomics, bulkTerms, provenanceOf, NO_TERMS } = await import("@/lib/sourcing/economics");
  const { ingestFromSupplier } = await import("@/lib/sourcing/economicsIngest");
  const { nextMoves } = await import("@/lib/sourcing/nextMoves");
  const { stateCapital } = await import("@/lib/sourcing/progression");
  const { assessFeasibility } = await import("@/lib/sourcing/feasibility");
  const { methodProfile } = await import("@/lib/sourcing/methodProfile");
  const { GENESIS_ACTIONS } = await import("@/lib/execution/genesisActions");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

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

  let seq = 0;
  const sell = (storeId: string, productId: string, when: Date) =>
    prisma.order.create({
      data: {
        storeId, productId, productName: "x", quantity: 1,
        amountInCents: 1_800, buyerEmail: "b@example.test", status: "paid",
        paymentProvider: "STRIPE", externalOrderId: `cs_${++seq}`, createdAt: when,
      },
    });

  /** A business with one dropship product that has genuinely earned rung 1. */
  async function provenBusiness(slug: string, currency = "USD") {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    const store = await prisma.store.create({
      data: {
        userId: user.id, name: `${slug} co`, slug, tagline: "t",
        description: "A fitness and recovery brand for people who train at home.",
        brandPositioning: "minimalist", currency,
      },
    });
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

  const ROLLER = { sourceKey: "w", externalProductId: "roller-1", externalVariantId: null };
  const taskFor = (storeId: string) =>
    prisma.task.findUnique({
      where: { storeId_dedupeKey: { storeId, dedupeKey: economicsDedupeKey(ROLLER) } },
    });

  try {
    // =======================================================================
    console.log("\n1. The question becomes something an owner can answer");
    {
      await reset();
      const { store } = await provenBusiness("asks");

      check("J4 has a question", (await nextMoves(store.id)).moves[0].kind, "unblock");

      const raised = await raiseEconomicsQuestions(store.id);
      check("one question, about one product", raised.length, 1);
      check("and it knows what is missing", raised[0].gaps, ["minimum_order", "bulk_price"]);

      const task = await taskFor(store.id);
      assert("a real Task exists", task !== null);
      check("bound to the action that answers it", task?.actionType, "answer_supplier_economics");
      check("under its own source", task?.source, ECONOMICS_TASK_SOURCE);
      check("pointing at the product", task?.relatedRecordId, raised[0].productId);
      check("open", task?.status, "OPEN");
      // NOT a fabricated authority. A question is a question.
      check("and J4 is not permitted to answer it itself", task?.trustLevel, "recommend");

      // THE COLUMN THAT HAD NEVER BEEN WRITTEN.
      const required = task?.requiredInput as { gaps: string[]; asks: string[] } | null;
      check("requiredInput names both gaps", required?.gaps, ["minimum_order", "bulk_price"]);
      assert("and says why each one matters",
        required?.asks.some((a) => a.includes("what buying in bulk would actually cost")) === true,
        JSON.stringify(required?.asks));

      // Asking twice is still one question.
      await raiseEconomicsQuestions(store.id);
      check("re-detection does not duplicate it",
        await prisma.task.count({ where: { storeId: store.id, source: ECONOMICS_TASK_SOURCE } }), 1);

      // AND THE ACTION IT NAMES REALLY EXISTS, at the tier it should.
      const action = GENESIS_ACTIONS.answer_supplier_economics;
      assert("the action is registered", action !== undefined);
      check("and can never be delegated", action.maxAuthorityTier, "always_ask");
      check("nor auto-executed today", action.authorizationTier, "always_ask");
    }

    // =======================================================================
    console.log("\n2. Only the half that is missing is asked for");
    {
      await reset();
      const { store } = await provenBusiness("half");

      // A catalogue that published a price and no minimum.
      await ingestFromSupplier({
        storeId: store.id, sourceKey: "w",
        records: [{ externalProductId: "roller-1", unitCostInCents: 410 }],
      });

      const raised = await raiseEconomicsQuestions(store.id);
      check("only the minimum is outstanding", raised[0].gaps, ["minimum_order"]);
      const task = await taskFor(store.id);
      assert("and the question asks for that alone",
        task?.title.includes("How many") === true, task?.title ?? "");
      assert("saying what is already known",
        task?.summary.includes("I know what your supplier charges") === true, task?.summary ?? "");
      check("with requiredInput narrowed too",
        (task?.requiredInput as { gaps: string[] }).gaps, ["minimum_order"]);
    }

    // =======================================================================
    console.log("\n3. The owner answers, and the recommendation changes");
    {
      await reset();
      const { user, store, product } = await provenBusiness("answers");
      await stateCapital(store.id, 45_000, ["hold_stock"]);
      await raiseEconomicsQuestions(store.id);

      const before = await nextMoves(store.id);
      check("before: a question", before.moves[0].kind, "unblock");

      const result = await answerEconomicsQuestion({
        storeId: store.id, ref: ROLLER, userId: user.id,
        answer: {
          kind: "quoted", minimumOrderUnits: 100, bulkUnitCostInCents: 410,
          shippingPerUnitInCents: 0, leadTimeDays: 14, note: "rang them",
        },
      });

      check("it was recorded", result.recorded?.status, "recorded");
      check("as something newly known",
        result.changes, ["minimum_order_became_known", "bulk_price_became_known", "shipping_became_known", "lead_time_became_known"]);
      check("which earned a re-evaluation", result.reevaluated, true);
      check("and closed the question", result.question, "closed");
      assert("with what J4 would now say", result.nowRecommends !== null, result.nowRecommends ?? "none");

      // PROVENANCE SURVIVES. This is the owner's fact, not a supplier's.
      const stored = await supplierEconomics(store.id, ROLLER);
      check("recorded as the owner's", [provenanceOf(stored, "minimumOrder"), provenanceOf(stored, "unitCost")], ["OWNER", "OWNER"]);
      check("attributed to them", stored?.attribution.unitCost.statedByUserId ?? null, user.id);
      check("with their note", stored?.note, "rang them");
      check("in their currency, stated", stored?.currency, "USD");

      const after = await nextMoves(store.id);
      check("after: a real move", after.moves[0].kind, "deepen");
      check("recommended outright", after.moves[0].outcome.kind, "recommended_now");
      check("about the right product", after.moves[0].productId, product.id);

      // THE CARD IS SETTLED FROM THE RESULT.
      await settleEconomicsQuestion(store.id, ROLLER, result);
      check("the question is answered", (await taskFor(store.id))?.status, "COMPLETED");
      // And the sweep agrees, independently.
      await raiseEconomicsQuestions(store.id);
      check("and is not raised again",
        (await taskFor(store.id))?.status, "COMPLETED");
    }

    // =======================================================================
    console.log("\n4. 'I don't know yet' writes nothing at all");
    {
      await reset();
      const { user, store } = await provenBusiness("unknown");
      await raiseEconomicsQuestions(store.id);

      const result = await answerEconomicsQuestion({
        storeId: store.id, ref: ROLLER, userId: user.id,
        answer: { kind: "dont_know_yet", note: "will ask next week" },
      });

      // THE WHOLE POINT. An owner who has not found out has not told us
      // anything about the supplier, and there is nowhere honest to put that.
      check("nothing was recorded", result.recorded, null);
      check("no row exists", await supplierEconomics(store.id, ROLLER), null);
      check("nothing is quoted", bulkTerms(null), NO_TERMS);
      // Specifically NOT recorded as UNAVAILABLE, which would be Genesis
      // claiming somebody asked and was refused — a different fact, and a
      // false one.
      check("and certainly not as a refusal",
        await prisma.supplierEconomics.count({ where: { storeId: store.id } }), 0);

      check("nothing was re-evaluated", result.reevaluated, false);
      check("the question stands", result.question, "still_open");
      await settleEconomicsQuestion(store.id, ROLLER, result);
      check("and the card is still open", (await taskFor(store.id))?.status, "OPEN");
      check("J4 is still asking", (await nextMoves(store.id)).moves[0].kind, "unblock");
    }

    // =======================================================================
    console.log("\n5. 'They wouldn't tell me' is a different answer");
    {
      await reset();
      const { user, store } = await provenBusiness("refused");
      await raiseEconomicsQuestions(store.id);

      const result = await answerEconomicsQuestion({
        storeId: store.id, ref: ROLLER, userId: user.id,
        answer: { kind: "supplier_would_not_say", note: "wouldn't quote under 1000" },
      });

      check("it was recorded", result.recorded?.status, "recorded");
      check("as a refusal on both figures",
        [provenanceOf(await supplierEconomics(store.id, ROLLER), "minimumOrder"),
         provenanceOf(await supplierEconomics(store.id, ROLLER), "unitCost")], ["UNAVAILABLE", "UNAVAILABLE"]);
      check("which is material", result.changes, ["supplier_refused"]);
      check("and was re-evaluated", result.reevaluated, true);
      // Still nothing is known, so the question does not close — but J4 stops
      // asking the same thing.
      check("the question is not closed", result.question, "still_open");
      check("still nothing quoted", bulkTerms(await supplierEconomics(store.id, ROLLER)).bulkUnitCostInCents, null);
      const moves = await nextMoves(store.id);
      assert("and J4 now suggests looking elsewhere",
        moves.moves[0].action.includes("another supplier"), moves.moves[0].action);
    }

    // =======================================================================
    console.log("\n6. An answer that changes nothing re-evaluates nothing");
    {
      await reset();
      const { user, store } = await provenBusiness("restated");
      await stateCapital(store.id, 45_000, ["hold_stock"]);

      await answerEconomicsQuestion({
        storeId: store.id, ref: ROLLER, userId: user.id,
        answer: { kind: "quoted", minimumOrderUnits: 100, bulkUnitCostInCents: 410, shippingPerUnitInCents: 0, leadTimeDays: 14 },
      });

      // The same figures again. Real information about our data, none about
      // their business.
      const same = await answerEconomicsQuestion({
        storeId: store.id, ref: ROLLER, userId: user.id,
        answer: { kind: "quoted", minimumOrderUnits: 100, bulkUnitCostInCents: 410, shippingPerUnitInCents: 0, leadTimeDays: 14 },
      });
      check("it was still recorded", same.recorded?.status, "recorded");
      check("but nothing moved", same.changes, []);
      check("so nothing was recomputed", same.reevaluated, false);
      check("and there is nothing new to say", same.nowRecommends, null);

      // A WORSE figure is not material either — it does not unblock anything
      // that was blocked, and the owner is not owed another interruption.
      const worse = await answerEconomicsQuestion({
        storeId: store.id, ref: ROLLER, userId: user.id,
        answer: { kind: "quoted", minimumOrderUnits: 500, bulkUnitCostInCents: 900, shippingPerUnitInCents: 0, leadTimeDays: 14 },
      });
      check("a worse quote is recorded", worse.recorded?.status, "recorded");
      check("and is not treated as an improvement", worse.changes, []);
      check("nor recomputed", worse.reevaluated, false);
      // It IS stored, though — the next decision uses the truth, not the
      // convenient old number.
      check("while the figures themselves are current",
        bulkTerms(await supplierEconomics(store.id, ROLLER)).bulkUnitCostInCents, 900);

      // A better one is.
      const better = await answerEconomicsQuestion({
        storeId: store.id, ref: ROLLER, userId: user.id,
        answer: { kind: "quoted", minimumOrderUnits: 50, bulkUnitCostInCents: 380, shippingPerUnitInCents: 0, leadTimeDays: 14 },
      });
      check("a better one is material",
        better.changes, ["minimum_order_lowered", "supplier_price_dropped"]);
      check("and is recomputed", better.reevaluated, true);
    }

    // =======================================================================
    console.log("\n7. Half an answer is kept, and the rest is asked for");
    {
      await reset();
      const { user, store } = await provenBusiness("partial");
      await raiseEconomicsQuestions(store.id);

      const half = await answerEconomicsQuestion({
        storeId: store.id, ref: ROLLER, userId: user.id,
        answer: { kind: "quoted", minimumOrderUnits: 100 },
      });
      // KEPT, not discarded. They rang their supplier and came back with
      // something real; demanding both would throw it away.
      check("the half they have is recorded", half.recorded?.status, "recorded");
      check("as theirs", provenanceOf(await supplierEconomics(store.id, ROLLER), "minimumOrder"), "OWNER");
      check("and it counts as material", half.changes, ["minimum_order_became_known"]);
      check("the question is narrowed, not closed", half.question, "narrowed");

      await settleEconomicsQuestion(store.id, ROLLER, half);
      check("so the card stays open", (await taskFor(store.id))?.status, "OPEN");

      // And the next ask is for the other half only.
      const raised = await raiseEconomicsQuestions(store.id);
      check("only the price is outstanding now", raised[0].gaps, ["bulk_price"]);
      assert("and that is what is asked",
        (await taskFor(store.id))?.title.includes("cost you in bulk") === true,
        (await taskFor(store.id))?.title ?? "");

      // NEITHER half is not a quote.
      const empty = await answerEconomicsQuestion({
        storeId: store.id, ref: ROLLER, userId: user.id, answer: { kind: "quoted" },
      });
      check("an empty quote is refused", empty.recorded?.status, "rejected");
      check("and the minimum they did give survives",
        bulkTerms(await supplierEconomics(store.id, ROLLER)).minimumOrderUnits, 100);
    }

    // =======================================================================
    console.log("\n8. Currency is stated, and never converted");
    {
      await reset();
      const { user, store } = await provenBusiness("currency", "GBP");
      await answerEconomicsQuestion({
        storeId: store.id, ref: ROLLER, userId: user.id,
        answer: { kind: "quoted", minimumOrderUnits: 100, bulkUnitCostInCents: 410 },
      });
      check("the figures are stored in the business's own currency",
        (await supplierEconomics(store.id, ROLLER))?.currency, "GBP");

      // And a mismatch REFUSES rather than converting. Nothing in this codebase
      // has an exchange rate, and inventing one would turn a real quote into a
      // fabricated figure that looks just as trustworthy.
      const mismatched = assessFeasibility({
        profile: methodProfile("WHOLESALE_STOCKED"),
        posture: { state: "stated", investableCents: 500_000, capabilities: ["hold_stock"], currency: "USD", statedAt: new Date() },
        supplier: { ...NO_TERMS, minimumOrderUnits: 100, bulkUnitCostInCents: 410, currency: "EUR" },
        evidence: null,
        currency: "USD",
      });
      check("a foreign quote cannot be assessed", mismatched.kind, "cannot_assess");
      assert("and says so rather than guessing a rate",
        mismatched.kind === "cannot_assess" && mismatched.missing.includes("matching_currency"),
        JSON.stringify(mismatched));

      // The same figures in the same currency are fine.
      const matched = assessFeasibility({
        profile: methodProfile("WHOLESALE_STOCKED"),
        posture: { state: "stated", investableCents: 500_000, capabilities: ["hold_stock"], currency: "USD", statedAt: new Date() },
        supplier: { ...NO_TERMS, minimumOrderUnits: 100, bulkUnitCostInCents: 410, currency: "USD" },
        evidence: null,
        currency: "USD",
      });
      check("matching currency is assessed normally", matched.kind, "affordable");
    }

    // =======================================================================
    console.log("\n9. An answer cannot cross a supplier or a business");
    {
      await reset();
      const owner = await prisma.user.create({ data: { email: "two@example.test" } });
      const gym = await prisma.store.create({
        data: {
          userId: owner.id, name: "gym", slug: "gym-answer", tagline: "t",
          description: "A fitness brand.", brandPositioning: "minimalist", currency: "USD",
        },
      });
      const coil = await prisma.store.create({
        data: {
          userId: owner.id, name: "coil", slug: "coil-answer", tagline: "t",
          description: "Hand-wound copper.", brandPositioning: "minimalist", currency: "USD",
        },
      });

      // Two suppliers listing the same external id, in one business.
      await answerEconomicsQuestion({
        storeId: gym.id, userId: owner.id,
        ref: { sourceKey: "supplier-a", externalProductId: "SHARED", externalVariantId: null },
        answer: { kind: "quoted", minimumOrderUnits: 50, bulkUnitCostInCents: 410 },
      });
      await answerEconomicsQuestion({
        storeId: gym.id, userId: owner.id,
        ref: { sourceKey: "supplier-b", externalProductId: "SHARED", externalVariantId: null },
        answer: { kind: "quoted", minimumOrderUnits: 5000, bulkUnitCostInCents: 9999 },
      });
      check("each supplier keeps its own answer", [
        (await supplierEconomics(gym.id, { sourceKey: "supplier-a", externalProductId: "SHARED", externalVariantId: null }))?.minimumOrderUnits,
        (await supplierEconomics(gym.id, { sourceKey: "supplier-b", externalProductId: "SHARED", externalVariantId: null }))?.minimumOrderUnits,
      ], [50, 5000]);

      // And the same answer in another business does not reach this one.
      await answerEconomicsQuestion({
        storeId: coil.id, userId: owner.id,
        ref: { sourceKey: "supplier-a", externalProductId: "SHARED", externalVariantId: null },
        answer: { kind: "quoted", minimumOrderUnits: 1, bulkUnitCostInCents: 1 },
      });
      check("the other business is untouched",
        (await supplierEconomics(gym.id, { sourceKey: "supplier-a", externalProductId: "SHARED", externalVariantId: null }))?.minimumOrderUnits, 50);
      check("and questions belong to one business",
        await prisma.task.count({ where: { storeId: coil.id, source: ECONOMICS_TASK_SOURCE } }), 0);
    }

    // =======================================================================
    console.log("\n10. The change vocabulary, on its own");
    {
      const none = { ...NO_TERMS };
      const known = { ...NO_TERMS, minimumOrderUnits: 100, bulkUnitCostInCents: 410 };
      check("becoming known counts",
        economicChanges(none, known), ["minimum_order_became_known", "bulk_price_became_known"]);
      check("no movement counts for nothing", economicChanges(known, known), []);
      check("worse is not material",
        economicChanges(known, { ...known, minimumOrderUnits: 500, bulkUnitCostInCents: 900 }), []);
      check("cheaper is",
        economicChanges(known, { ...known, bulkUnitCostInCents: 300 }), ["supplier_price_dropped"]);
      check("and price breaks becoming readable is",
        economicChanges({ ...known, integrity: { ok: false, problem: "x" } }, known),
        ["price_breaks_became_usable"]);
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
