import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
// TYPE ONLY — a value import from lib/ at module scope loads Prisma before
// DATABASE_URL points at the harness.
import type { EconomicsProducer, EconomicsStatement } from "@/lib/sourcing/economicsProducer";

// THE THREE THINGS THAT STOOD BETWEEN THE ECONOMICS LAYER AND PRODUCTION:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-economics-producer.ts" -OutFile out.txt
//
//   1. The question had no production caller — nothing ran the detection.
//   3. A future connector had no contract and no door to come through.
//   4. Nobody had decided what a supplier CHANGING a price should do.
//
// (2, per-field provenance, is proven in verify-economics-ingest.ts, which is
// where the write rules live.)
//
// Section 4 is the one with a decision in it rather than a mechanism, and the
// decision is written down in PRODUCT_PROGRESSION.md §C7 as well as here.

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

  const { runTaskDetection } = await import("@/lib/dashboard/taskDetectors");
  const { ECONOMICS_TASK_SOURCE, economicsDedupeKey } = await import("@/lib/sourcing/economicsQuestions");
  const { runEconomicsProducer, producerReadiness } = await import("@/lib/sourcing/economicsProducer");
  const { recordOwnerQuote } = await import("@/lib/sourcing/economicsIngest");
  const { supplierEconomics, bulkTerms, provenanceOf, missingEconomics } =
    await import("@/lib/sourcing/economics");
  const { getProductSources } = await import("@/lib/sourcing/registry");
  const { findGraduationOpportunities } = await import("@/lib/sourcing/graduation");
  const { nextMoves } = await import("@/lib/sourcing/nextMoves");
  const { stateCapital } = await import("@/lib/sourcing/progression");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  const SOURCE = getProductSources()[0].key;

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

  /** A business whose product has genuinely earned a better way of being bought. */
  async function provenBusiness(slug: string, opts: { sourced?: boolean } = {}) {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    const store = await prisma.store.create({
      data: {
        userId: user.id, name: `${slug} co`, slug, tagline: "t",
        description: "A fitness and recovery brand for people who train at home.",
        brandPositioning: "minimalist", currency: "USD",
        blueprint: { marketingAssets: { seoTitle: "t", seoMetaDescription: "d" } },
        logoUrl: "https://example.test/logo.png",
      },
    });
    const sourced = opts.sourced ?? true;
    const product = await prisma.product.create({
      data: {
        storeId: store.id, name: "Foam roller", description: "recovery training",
        priceInCents: 1_800, costInCents: 980, sourceKind: "WHOLESALE_DROPSHIP",
        sourceKey: sourced ? SOURCE : null,
        externalProductId: sourced ? "roller-1" : null,
        active: true,
      },
    });
    if (sourced) {
      await prisma.sourcedProduct.create({
        data: {
          storeId: store.id, sourceKey: SOURCE, externalProductId: "roller-1",
          kind: "WHOLESALE_DROPSHIP", name: "Foam roller",
          adoptedProductId: product.id, status: "ADOPTED",
        },
      });
    }
    for (let i = 0; i < 60; i++) await sell(store.id, product.id, daysAgo(70 - i));
    return { user, store, product };
  }

  const ROLLER = { sourceKey: SOURCE, externalProductId: "roller-1", externalVariantId: null };

  /** A producer standing in for a connector nobody has written yet. */
  const producerOf = (
    statements: EconomicsStatement[],
    over: Partial<EconomicsProducer> = {}
  ): EconomicsProducer => ({
    sourceKey: SOURCE,
    currency: "USD",
    blockedOn: [],
    statements: async () => statements,
    ...over,
  });

  async function provenProduct(storeId: string) {
    return prisma.product.findFirstOrThrow({ where: { storeId, active: true } });
  }

  const detectionParams = {
    hasActiveProducts: true,
    logoUrl: "https://example.test/logo.png",
    blueprint: { marketingAssets: { seoTitle: "t", seoMetaDescription: "d" } },
  };

  const economicsTasks = (storeId: string) =>
    prisma.task.count({ where: { storeId, source: ECONOMICS_TASK_SOURCE, status: "OPEN" } });

  try {
    // =======================================================================
    console.log("\n1. The question appears without anybody running a script");
    {
      await reset();
      const { store } = await provenBusiness("detected");

      check("nothing has asked yet", await economicsTasks(store.id), 0);

      // THE REAL PRODUCTION CALLER. runTaskDetection is what Home awaits on
      // every load; this is the same call with the same arguments, and no test
      // helper is involved in raising the question.
      await runTaskDetection(store.id, detectionParams);

      check("the detection pass raised it", await economicsTasks(store.id), 1);
      const task = await prisma.task.findUnique({
        where: { storeId_dedupeKey: { storeId: store.id, dedupeKey: economicsDedupeKey(ROLLER) } },
      });
      assert("about the right product", task?.relatedRecordId !== null);
      check("bound to the action that answers it", task?.actionType, "answer_supplier_economics");

      // Running it again is still one question, and does not disturb the
      // detectors that share the pass.
      await runTaskDetection(store.id, detectionParams);
      check("running twice raises one question", await economicsTasks(store.id), 1);
      check("and the other detectors are unaffected",
        await prisma.task.count({ where: { storeId: store.id, source: { not: ECONOMICS_TASK_SOURCE } } }), 0);
    }

    // =======================================================================
    console.log("\n2. The gate is exact, not a guess");
    {
      await reset();
      // A product with no supplier listing cannot produce an answerable
      // question — there is nobody to ring. The pass must skip the whole
      // progression engine rather than run it and find nothing.
      const { store } = await provenBusiness("ungated", { sourced: false });
      await runTaskDetection(store.id, detectionParams);
      check("a store with no sourced product asks nothing", await economicsTasks(store.id), 0);

      // And a store with one does.
      const sourcedStore = (await provenBusiness("gated")).store;
      await runTaskDetection(sourcedStore.id, detectionParams);
      check("a store with one does ask", await economicsTasks(sourcedStore.id), 1);
    }

    // =======================================================================
    console.log("\n3. A producer writes only through the ingest contract");
    {
      await reset();
      const { store } = await provenBusiness("producer");

      // AN UNREGISTERED SOURCE IS NOT RUN. Without this a caller could invent a
      // key and write terms no product will ever match — or match a real key
      // and put one supplier's prices on another's products.
      const stranger = await runEconomicsProducer(
        producerOf([{ externalProductId: "roller-1", unitCostInCents: 410 }], { sourceKey: "not-a-real-source" }),
        { storeId: store.id }
      );
      check("an unregistered source is refused", stranger.status, "not_run");
      assert("and says why", stranger.status === "not_run" && stranger.reason.includes("not a registered"),
        stranger.status === "not_run" ? stranger.reason : "");
      check("nothing was written",
        await prisma.supplierEconomics.count({ where: { storeId: store.id } }), 0);

      // A PRODUCER THAT IS NOT READY IS NAMED, NOT SILENTLY SKIPPED.
      const blocked = await runEconomicsProducer(
        producerOf([{ externalProductId: "roller-1", unitCostInCents: 410 }], { blockedOn: ["no API key"] }),
        { storeId: store.id }
      );
      check("a blocked producer does not run", blocked.status, "not_run");
      assert("and its reason is the one it declared",
        blocked.status === "not_run" && blocked.reason.includes("no API key"),
        blocked.status === "not_run" ? blocked.reason : "");
      check("readiness is answerable without running it",
        producerReadiness(producerOf([], { blockedOn: ["no API key"] })).ready, false);
      check("a producer with no currency is not ready",
        producerReadiness(producerOf([], { currency: "" })).blockedOn.some((b) => b.includes("currency")), true);

      // A GOOD RUN LANDS, AND IS THE SUPPLIER'S.
      const ran = await runEconomicsProducer(
        producerOf([
          { externalProductId: "roller-1", minimumOrderUnits: 100, unitCostInCents: 410, leadTimeDays: 21 },
        ]),
        { storeId: store.id }
      );
      check("it ran", ran.status, "ran");
      const stored = await supplierEconomics(store.id, ROLLER);
      check("and every fact is the supplier's", [
        provenanceOf(stored, "minimumOrder"),
        provenanceOf(stored, "unitCost"),
        provenanceOf(stored, "handling"),
      ], ["SUPPLIER", "SUPPLIER", "SUPPLIER"]);
      check("with the figures it stated",
        [stored?.minimumOrderUnits, stored?.unitCostInCents, stored?.leadTimeDays], [100, 410, 21]);

      // MALFORMED DATA IS DATA. One bad statement does not lose the rest, and
      // nothing partial is written for the one that failed.
      const mixed = await runEconomicsProducer(
        producerOf([
          { externalProductId: "roller-1", unitCostInCents: 380 },
          { externalProductId: "bad", minimumOrderUnits: 0 },
          { externalProductId: "also-good", unitCostInCents: 250 },
        ]),
        { storeId: store.id }
      );
      assert("the batch ran", mixed.status === "ran");
      if (mixed.status === "ran") {
        check("the good statements landed", mixed.report.recorded, 2);
        check("the bad one did not", mixed.report.rejected, 1);
      }
      check("and nothing exists for the bad one",
        await supplierEconomics(store.id, { ...ROLLER, externalProductId: "bad" }), null);

      // THE SUPPLIER'S OWN MONEY, CARRIED RATHER THAN ASSUMED.
      const foreign = (await provenBusiness("foreign")).store;
      await runEconomicsProducer(
        producerOf([{ externalProductId: "roller-1", minimumOrderUnits: 100, unitCostInCents: 410 }], { currency: "EUR" }),
        { storeId: foreign.id }
      );
      check("the figures are stored in the supplier's currency",
        (await supplierEconomics(foreign.id, ROLLER))?.currency, "EUR");
      // The business sells in USD, so the engine refuses rather than converting.
      const moves = await nextMoves(foreign.id);
      check("and a foreign quote cannot be assessed", moves.moves[0].kind, "unblock");
      assert("saying it will not guess a rate",
        JSON.stringify(moves.moves[0]).includes("exchange rate"), JSON.stringify(moves.moves[0].evidence));
    }

    // =======================================================================
    console.log("\n4. A supplier changing its own price asks nobody");
    {
      await reset();
      const { store } = await provenBusiness("changes");
      await stateCapital(store.id, 45_000, ["hold_stock"]);

      await runEconomicsProducer(
        producerOf([{ externalProductId: "roller-1", minimumOrderUnits: 100, unitCostInCents: 410, shippingPerUnitInCents: 0, leadTimeDays: 7 }]),
        { storeId: store.id }
      );
      await runTaskDetection(store.id, detectionParams);
      check("nothing is outstanding", await economicsTasks(store.id), 0);
      check("and J4 has a real move", (await nextMoves(store.id)).moves[0].kind, "deepen");

      // THE DECISION (PRODUCT_PROGRESSION.md §C7): a supplier's own fact is
      // theirs to change. It updates in place, silently, because asking an owner
      // to approve a price they do not control is asking them to approve the
      // weather.
      await runEconomicsProducer(
        producerOf([{ externalProductId: "roller-1", minimumOrderUnits: 100, unitCostInCents: 300, shippingPerUnitInCents: 0, leadTimeDays: 7 }]),
        { storeId: store.id }
      );
      check("the new price is simply the price",
        bulkTerms(await supplierEconomics(store.id, ROLLER)).bulkUnitCostInCents, 300);
      await runTaskDetection(store.id, detectionParams);
      check("and it raises NO question", await economicsTasks(store.id), 0);

      // NOR DOES IT DECIDE ANYTHING. A cheaper price is a better recommendation,
      // never an accepted one — nothing here graduates a product.
      const after = await nextMoves(store.id);
      check("it is still only a recommendation", after.moves[0].kind, "deepen");
      check("nothing was decided on the owner's behalf",
        await prisma.progressionDecision.count({ where: { storeId: store.id } }), 0);
      check("and the product is unchanged",
        (await prisma.product.findUniqueOrThrow({ where: { id: (await provenProduct(store.id)).id } })).sourceKind,
        "WHOLESALE_DROPSHIP");

      // A PRICE RISE IS ALSO JUST A PRICE. No question, no alarm — Genesis does
      // not model reordering, so there is no decision to revisit, and inventing
      // an interruption would be inventing a mechanism.
      await runEconomicsProducer(
        producerOf([{ externalProductId: "roller-1", minimumOrderUnits: 100, unitCostInCents: 900, shippingPerUnitInCents: 0, leadTimeDays: 7 }]),
        { storeId: store.id }
      );
      await runTaskDetection(store.id, detectionParams);
      check("a rise raises no question either", await economicsTasks(store.id), 0);
      check("while the figure itself is current",
        bulkTerms(await supplierEconomics(store.id, ROLLER)).bulkUnitCostInCents, 900);
    }

    // =======================================================================
    console.log("\n5. A supplier WITHDRAWING a figure does ask");
    {
      await reset();
      const { store } = await provenBusiness("withdrawn");

      await runEconomicsProducer(
        producerOf([{ externalProductId: "roller-1", minimumOrderUnits: 100, unitCostInCents: 410 }]),
        { storeId: store.id }
      );
      await runTaskDetection(store.id, detectionParams);
      check("nothing outstanding while both are known", await economicsTasks(store.id), 0);

      // The catalogue stops publishing the price. That is not a change in the
      // price — it is Genesis no longer knowing it, and the honest response is
      // the same one it gives when nobody ever said: ask.
      await runEconomicsProducer(
        producerOf([{ externalProductId: "roller-1", minimumOrderUnits: 100 }]),
        { storeId: store.id }
      );
      check("the price is unknown again",
        bulkTerms(await supplierEconomics(store.id, ROLLER)).bulkUnitCostInCents, null);
      check("and it is named as the gap",
        missingEconomics(await supplierEconomics(store.id, ROLLER)), ["bulk_price"]);

      await runTaskDetection(store.id, detectionParams);
      check("so the question comes back", await economicsTasks(store.id), 1);
      const task = await prisma.task.findUnique({
        where: { storeId_dedupeKey: { storeId: store.id, dedupeKey: economicsDedupeKey(ROLLER) } },
      });
      assert("asking only for the half that vanished",
        task?.title.includes("cost you in bulk") === true, task?.title ?? "");
    }

    // =======================================================================
    console.log("\n6. A supplier change never touches what a person said");
    {
      await reset();
      const { user, store } = await provenBusiness("owner-held");

      await recordOwnerQuote({
        storeId: store.id, ref: ROLLER, minimumOrderUnits: 50, bulkUnitCostInCents: 380, userId: user.id,
      });

      // The catalogue now says something different about both. It may say it
      // about neither: these are the owner's answers.
      const sync = await runEconomicsProducer(
        producerOf([{ externalProductId: "roller-1", minimumOrderUnits: 500, unitCostInCents: 900 }]),
        { storeId: store.id }
      );
      assert("the sync ran", sync.status === "ran");
      const held = await supplierEconomics(store.id, ROLLER);
      check("the owner's figures stand", [held?.minimumOrderUnits, held?.unitCostInCents], [50, 380]);
      check("and are still theirs",
        [provenanceOf(held, "minimumOrder"), provenanceOf(held, "unitCost")], ["OWNER", "OWNER"]);

      // AND A WITHDRAWAL CANNOT ERASE THEM EITHER. A catalogue that stops
      // listing a price has said nothing about what a person was told.
      await runEconomicsProducer(producerOf([{ externalProductId: "roller-1" }]), { storeId: store.id });
      const survived = await supplierEconomics(store.id, ROLLER);
      check("the owner's price survives a withdrawal",
        [survived?.minimumOrderUnits, survived?.unitCostInCents], [50, 380]);
      await runTaskDetection(store.id, detectionParams);
      check("and no question is raised", await economicsTasks(store.id), 0);
    }

    // =======================================================================
    console.log("\n7. A better price reopens a decision the owner declined");
    {
      await reset();
      const { store } = await provenBusiness("reconsidered");
      await stateCapital(store.id, 1_000, ["hold_stock"]);

      await runEconomicsProducer(
        producerOf([{ externalProductId: "roller-1", minimumOrderUnits: 500, unitCostInCents: 410, shippingPerUnitInCents: 0, leadTimeDays: 7 }]),
        { storeId: store.id }
      );

      const { conditionsOf, recordProgressionDecision } = await import("@/lib/sourcing/graduation");
      const { capitalPosture } = await import("@/lib/sourcing/progression");
      const offered = (await findGraduationOpportunities(store.id))[0];
      await recordProgressionDecision({
        storeId: store.id, productId: offered.productId, toKind: offered.toKind, decision: "DECLINED",
        conditions: conditionsOf(
          offered,
          await capitalPosture(store.id),
          bulkTerms(await supplierEconomics(store.id, ROLLER))
        ),
      });
      check("declined, so not raised again",
        (await findGraduationOpportunities(store.id)).filter((o) => o.reconsideration !== null).length, 0);

      // THE ONLY ROUTE BY WHICH A PRICE CHANGE REACHES THE OWNER: it changed a
      // decision they actually made. Not a catalogue feed, not an alert — the
      // reconsideration mechanism that already existed.
      await runEconomicsProducer(
        producerOf([{ externalProductId: "roller-1", minimumOrderUnits: 50, unitCostInCents: 410, shippingPerUnitInCents: 0, leadTimeDays: 7 }]),
        { storeId: store.id }
      );
      const again = (await findGraduationOpportunities(store.id))[0];
      check("a lower minimum is worth another ask", again?.reconsideration, "minimum_order_lowered");
      // And still no separate question — the move itself carries it.
      await runTaskDetection(store.id, detectionParams);
      check("with no question raised alongside it", await economicsTasks(store.id), 0);
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
