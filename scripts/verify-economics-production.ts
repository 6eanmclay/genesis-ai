import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import type { ProductSource, SourceEconomicsResult, SourceSearchResult } from "@/lib/sourcing/types";

// THE LAST THREE THINGS BEFORE THE CATALOG:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-economics-production.ts" -OutFile out.txt
//
//   1. The owner answering from the card J4 raised, not only in chat.
//   2. The first real producer, and the whole path behind it.
//   3. Whether nextMoves' sequential reads are actually a problem — measured
//      rather than assumed, and the measurement is in section 5.
//
// Printful is the reference producer and it needs live credentials, so what is
// proven here is everything on this side of the network: that it declares and
// implements the contract, and that a source implementing the SAME contract
// carries real supplier facts all the way to what J4 says.

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
  const { buildAttentionCards } = await import("@/lib/dashboard/attentionCards");
  const { getOpenTasks } = await import("@/lib/dashboard/tasks");
  const { applyEconomicsAnswer, parseCardEconomicsAnswer, outstandingEconomicsQuestions } =
    await import("@/lib/sourcing/economicsChat");
  const { producerFromSource, runEconomicsProducer } = await import("@/lib/sourcing/economicsProducer");
  const { supplierEconomics, bulkTerms, provenanceOf } = await import("@/lib/sourcing/economics");
  const { getProductSource } = await import("@/lib/sourcing/registry");
  const { nextMoves } = await import("@/lib/sourcing/nextMoves");
  const { stateCapital } = await import("@/lib/sourcing/progression");
  const { answerSupplierEconomicsExecutable } = await import("@/lib/execution/executables/answerSupplierEconomics");
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

  const SOURCE = "printful";

  async function business(slug: string, currency = "USD") {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    const store = await prisma.store.create({
      data: {
        userId: user.id, name: `${slug} co`, slug, tagline: "t",
        description: "A fitness and recovery brand for people who train at home.",
        brandPositioning: "minimalist", currency,
        blueprint: { marketingAssets: { seoTitle: "t", seoMetaDescription: "d" } },
        logoUrl: "https://example.test/logo.png",
      },
    });
    const product = await prisma.product.create({
      data: {
        storeId: store.id, name: "Foam roller", description: "recovery training",
        priceInCents: 1_800, costInCents: 980, sourceKind: "WHOLESALE_DROPSHIP",
        sourceKey: SOURCE, externalProductId: "roller-1", active: true,
      },
    });
    await prisma.sourcedProduct.create({
      data: {
        storeId: store.id, sourceKey: SOURCE, externalProductId: "roller-1",
        kind: "WHOLESALE_DROPSHIP", name: "Foam roller",
        adoptedProductId: product.id, status: "ADOPTED",
      },
    });
    for (let i = 0; i < 60; i++) await sell(store.id, product.id, daysAgo(70 - i));
    return { user, store, product };
  }

  const ROLLER = { sourceKey: SOURCE, externalProductId: "roller-1", externalVariantId: null };
  const detectionParams = {
    hasActiveProducts: true,
    logoUrl: "https://example.test/logo.png",
    blueprint: { marketingAssets: { seoTitle: "t", seoMetaDescription: "d" } },
  };

  /** A source implementing the same contract Printful does, without a network. */
  function economicsSource(result: SourceEconomicsResult): ProductSource {
    return {
      key: SOURCE,
      displayName: "Printful",
      kind: "PRINT_ON_DEMAND",
      capabilities: {
        customization: true, createsListings: true, shipsDirect: true,
        quotesCost: true, statesEconomics: true,
      },
      fulfillmentProvider: "PRINTFUL",
      blockedOn: [],
      async search(): Promise<SourceSearchResult> {
        return { ok: true, candidates: [] };
      },
      async economics() {
        return result;
      },
    };
  }

  // execute() resolves permission from a live session, which a script does not
  // have — the constraint verify-orders-live.ts records. The executable is
  // driven with the exact ctx execute() would build once requireStorePermission
  // approved, so everything the card path depends on behind the engine's front
  // door is genuinely exercised.
  let execSeq = 0;
  const asOwner = (storeId: string) => async (input: {
    sourceKey: string;
    externalProductId: string;
    externalVariantId?: string | null;
    answer: Parameters<typeof answerSupplierEconomicsExecutable.run>[0]["answer"];
  }) => {
    const owner = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { userId: true } });
    const ctx = { storeId, userId: owner.userId, actorType: "USER" as const, executionId: `test_${++execSeq}` };
    const ran = await answerSupplierEconomicsExecutable.run(input, ctx);
    const checked = await answerSupplierEconomicsExecutable.verify!(input, ctx);
    return {
      schemaVersion: 1 as const,
      timestamp: new Date(),
      executionId: ctx.executionId,
      action: "answer_supplier_economics",
      status: (checked.ok ? "SUCCESS" : "FAILED") as "SUCCESS" | "FAILED",
      verified: checked.ok,
      message: ran.message,
      retryable: false,
      actorType: "USER" as const,
      actorId: owner.userId,
      storeId,
      storeDraftId: null,
      metadata: ran.metadata!,
    };
  };

  const cardsFor = async (storeId: string, currency = "USD") => {
    const tasks = await getOpenTasks(storeId);
    return buildAttentionCards({ basePath: LEGACY_BUSINESS_BASE,
      issues: [], pendingApprovals: [], nextRecommendation: null, discoveryItems: [],
      tasks: tasks.map((t) => ({
        id: t.id, title: t.title, summary: t.summary,
        source: t.source, dedupeKey: t.dedupeKey, requiredInput: t.requiredInput,
      })),
      currency,
    }).cards;
  };

  try {
    // =======================================================================
    console.log("\n1. The card J4 raised is a form, and it asks for what is missing");
    {
      await reset();
      const { store } = await business("card");
      await runTaskDetection(store.id, detectionParams);

      const card = (await cardsFor(store.id)).find((c) => c.kind === "task");
      assert("the question renders as a task card", card !== undefined);
      if (card?.kind !== "task") throw new Error("expected a task card");
      assert("with an economics form on it", card.economics !== null, JSON.stringify(card));
      check("asking for both halves", card.economics?.gaps, ["minimum_order", "bulk_price"]);
      check("and labelled in the business's own money", card.economics?.currency, "USD");
      // The identity the form submits is the QUESTION's, not the row id — the
      // same key the chat path resolves against.
      check("carrying the question's own identity",
        card.economics?.dedupeKey,
        (await outstandingEconomicsQuestions(store.id))[0].dedupeKey);

      // ONE HALF ANSWERED, AND THE CARD NARROWS.
      await applyEconomicsAnswer({
        storeId: store.id,
        answer: {
          productName: null,
          dedupeKey: card.economics!.dedupeKey,
          answer: parseCardEconomicsAnswer({ outcome: "quoted", minimumOrderUnits: "100", bulkUnitCost: "" }),
        },
        runAction: asOwner(store.id),
      });
      await runTaskDetection(store.id, detectionParams);
      const narrowed = (await cardsFor(store.id)).find((c) => c.kind === "task");
      check("the form now asks only for the price",
        narrowed?.kind === "task" ? narrowed.economics?.gaps : null, ["bulk_price"]);
      check("and the minimum is theirs",
        provenanceOf(await supplierEconomics(store.id, ROLLER), "minimumOrder"), "OWNER");
    }

    // =======================================================================
    console.log("\n2. What the form can and cannot turn into a number");
    {
      // PARSING IS WHERE A FIGURE ABOUT MONEY GETS INVENTED. Pure, so it is
      // asserted directly rather than through a form post.
      check("money is converted exactly once",
        parseCardEconomicsAnswer({ outcome: "quoted", minimumOrderUnits: "100", bulkUnitCost: "4.10" }),
        { kind: "quoted", minimumOrderUnits: 100, bulkUnitCostInCents: 410, shippingPerUnitInCents: null, leadTimeDays: null, note: null });
      check("a currency symbol is not a price",
        parseCardEconomicsAnswer({ outcome: "quoted", minimumOrderUnits: "", bulkUnitCost: "$4.10" }).kind === "quoted"
          ? (parseCardEconomicsAnswer({ outcome: "quoted", minimumOrderUnits: "", bulkUnitCost: "$4.10" }) as { bulkUnitCostInCents: number }).bulkUnitCostInCents
          : null,
        410);
      // AN EMPTY FIELD IS NOT A ZERO.
      const halfOnly = parseCardEconomicsAnswer({ outcome: "quoted", minimumOrderUnits: "", bulkUnitCost: "4.10" });
      check("an empty minimum stays absent",
        halfOnly.kind === "quoted" ? halfOnly.minimumOrderUnits : "wrong kind", null);
      // A fraction of a unit is not a quantity anybody can order.
      const fractional = parseCardEconomicsAnswer({ outcome: "quoted", minimumOrderUnits: "10.5", bulkUnitCost: "4.10" });
      check("a fractional minimum is refused, not rounded",
        fractional.kind === "quoted" ? fractional.minimumOrderUnits : "wrong kind", null);
      // BOTH BLANK IS NOT A QUOTE — it is somebody who has not found out.
      check("an empty submission is not an answer",
        parseCardEconomicsAnswer({ outcome: "quoted", minimumOrderUnits: "", bulkUnitCost: "" }).kind,
        "dont_know_yet");
      // The two ways of not answering stay different facts.
      check("a refusal is a refusal",
        parseCardEconomicsAnswer({ outcome: "supplier_would_not_say" }).kind, "supplier_would_not_say");
      check("and not-yet is not-yet",
        parseCardEconomicsAnswer({ outcome: "dont_know_yet" }).kind, "dont_know_yet");
    }

    // =======================================================================
    console.log("\n3. 'I'll find out' from the card writes nothing");
    {
      await reset();
      const { store } = await business("unknown-card");
      await runTaskDetection(store.id, detectionParams);
      const card = (await cardsFor(store.id)).find((c) => c.kind === "task");
      if (card?.kind !== "task") throw new Error("expected a task card");

      await applyEconomicsAnswer({
        storeId: store.id,
        answer: {
          productName: null,
          dedupeKey: card.economics!.dedupeKey,
          answer: parseCardEconomicsAnswer({ outcome: "dont_know_yet" }),
        },
        runAction: asOwner(store.id),
      });
      check("nothing was recorded",
        await prisma.supplierEconomics.count({ where: { storeId: store.id } }), 0);
      check("and the card is still asking", (await cardsFor(store.id)).filter((c) => c.kind === "task").length, 1);

      // "They wouldn't say" IS an answer, and a different one.
      await applyEconomicsAnswer({
        storeId: store.id,
        answer: {
          productName: null,
          dedupeKey: card.economics!.dedupeKey,
          answer: parseCardEconomicsAnswer({ outcome: "supplier_would_not_say" }),
        },
        runAction: asOwner(store.id),
      });
      check("a refusal is recorded as one",
        provenanceOf(await supplierEconomics(store.id, ROLLER), "unitCost"), "UNAVAILABLE");
    }

    // =======================================================================
    console.log("\n4. A real source, all the way to what J4 says");
    {
      // THE REFERENCE IMPLEMENTATION IS REGISTERED AND REAL.
      const printful = getProductSource("printful");
      assert("Printful declares it states economics",
        printful?.capabilities.statesEconomics === true);
      assert("and implements it", typeof printful?.economics === "function");
      const aliexpress = getProductSource("aliexpress");
      check("a source that cannot does not claim to",
        aliexpress?.capabilities.statesEconomics, false);
      check("and has nothing behind it", typeof aliexpress?.economics, "undefined");

      await reset();
      const { store } = await business("real-path");
      await stateCapital(store.id, 45_000, ["hold_stock"]);

      // supplier source -> producer -> ingest -> SupplierEconomics
      const source = economicsSource({
        ok: true,
        currency: "USD",
        statements: [
          {
            externalProductId: "roller-1", externalVariantId: null,
            unitCostInCents: 410, minimumOrderUnits: 100,
            shippingPerUnitInCents: 0, tiers: [], leadTimeDays: 14,
          },
        ],
      });
      const outcome = await runEconomicsProducer(producerFromSource(source), { storeId: store.id });
      check("the producer ran", outcome.status, "ran");

      const stored = await supplierEconomics(store.id, ROLLER);
      check("in the supplier's stated currency", stored?.currency, "USD");
      check("with every fact the supplier's", [
        provenanceOf(stored, "minimumOrder"), provenanceOf(stored, "unitCost"),
        provenanceOf(stored, "tiers"), provenanceOf(stored, "shipping"), provenanceOf(stored, "handling"),
      ], ["SUPPLIER", "SUPPLIER", "SUPPLIER", "SUPPLIER", "SUPPLIER"]);
      // Freshness is stamped at ingest, per fact, and is fresh right now.
      check("and freshly stated", stored?.attribution.unitCost.freshness?.state, "fresh");
      // An empty tier array is "no price breaks", which is not null.
      check("no price breaks is a statement", stored?.tiers, []);

      // -> progression -> J4 reasoning
      const moves = await nextMoves(store.id);
      check("J4 has a real move", moves.moves[0].kind, "deepen");
      check("and it is actionable", moves.moves[0].outcome.kind, "recommended_now");
      await runTaskDetection(store.id, detectionParams);
      check("with nothing left to ask", (await cardsFor(store.id)).filter((c) => c.kind === "task").length, 0);

      // THE WHOLE POINT: the owner's fact and the supplier's, side by side.
      // Straight through recordOwnerQuote, not the answer path: there is no
      // question outstanding any more, and the answer path correctly refuses to
      // file against nothing (proven in verify-economics-chat.ts). An owner
      // correcting a figure they already know is not answering a question.
      const { recordOwnerQuote } = await import("@/lib/sourcing/economicsIngest");
      await recordOwnerQuote({ storeId: store.id, ref: ROLLER, minimumOrderUnits: 50 });
      const mixed = await supplierEconomics(store.id, ROLLER);
      check("the owner's minimum is theirs",
        [provenanceOf(mixed, "minimumOrder"), mixed?.minimumOrderUnits], ["OWNER", 50]);
      check("the supplier's price is still the supplier's",
        [provenanceOf(mixed, "unitCost"), mixed?.unitCostInCents], ["SUPPLIER", 410]);
      check("and the decision uses both",
        [bulkTerms(mixed).minimumOrderUnits, bulkTerms(mixed).bulkUnitCostInCents], [50, 410]);

      // A LATER SYNC REFRESHES ITS OWN AND LEAVES THEIRS.
      await runEconomicsProducer(
        producerFromSource(economicsSource({
          ok: true, currency: "USD",
          statements: [{
            externalProductId: "roller-1", externalVariantId: null,
            unitCostInCents: 300, minimumOrderUnits: 500,
            shippingPerUnitInCents: 0, tiers: [], leadTimeDays: 14,
          }],
        })),
        { storeId: store.id }
      );
      const after = await supplierEconomics(store.id, ROLLER);
      check("the supplier's price moved", after?.unitCostInCents, 300);
      check("and the owner's minimum did not",
        [provenanceOf(after, "minimumOrder"), after?.minimumOrderUnits], ["OWNER", 50]);
    }

    // =======================================================================
    console.log("\n5. Tenant isolation, foreign money, and a supplier that fails");
    {
      await reset();
      const gym = (await business("gym-prod")).store;
      const coil = (await business("coil-prod")).store;

      await runEconomicsProducer(
        producerFromSource(economicsSource({
          ok: true, currency: "USD",
          statements: [{ externalProductId: "roller-1", externalVariantId: null, unitCostInCents: 410, minimumOrderUnits: 100 }],
        })),
        { storeId: gym.id }
      );
      check("the business that ran it has terms",
        bulkTerms(await supplierEconomics(gym.id, ROLLER)).bulkUnitCostInCents, 410);
      check("the other has none", await supplierEconomics(coil.id, ROLLER), null);

      // FOREIGN MONEY IS STORED AS FOREIGN MONEY, and refuses rather than converts.
      const euro = (await business("euro-prod", "USD")).store;
      await runEconomicsProducer(
        producerFromSource(economicsSource({
          ok: true, currency: "EUR",
          statements: [{ externalProductId: "roller-1", externalVariantId: null, unitCostInCents: 410, minimumOrderUnits: 100 }],
        })),
        { storeId: euro.id }
      );
      check("stored in the supplier's currency", (await supplierEconomics(euro.id, ROLLER))?.currency, "EUR");
      const euroMoves = await nextMoves(euro.id);
      check("and it cannot be assessed", euroMoves.moves[0].kind, "unblock");

      // MALFORMED STATEMENTS ARE REJECTED INDIVIDUALLY.
      const messy = (await business("messy-prod")).store;
      const report = await runEconomicsProducer(
        producerFromSource(economicsSource({
          ok: true, currency: "USD",
          statements: [
            { externalProductId: "roller-1", externalVariantId: null, unitCostInCents: 410, minimumOrderUnits: 100 },
            { externalProductId: "bad", externalVariantId: null, minimumOrderUnits: 0 },
            { externalProductId: "worse", externalVariantId: null, tiers: [{ minUnits: 5, unitCostInCents: 1 }, { minUnits: 5, unitCostInCents: 2 }] },
          ],
        })),
        { storeId: messy.id }
      );
      assert("the batch ran", report.status === "ran");
      if (report.status === "ran") {
        check("the good statement landed", report.report.recorded, 1);
        check("the two bad ones did not", report.report.rejected, 2);
      }

      // A SUPPLIER THAT CANNOT ANSWER IS NAMED, and writes nothing.
      const down = (await business("down-prod")).store;
      const unavailable = await runEconomicsProducer(
        producerFromSource(economicsSource({ ok: false, reason: "provider_error", detail: "Printful is unreachable" })),
        { storeId: down.id }
      );
      check("it did not run", unavailable.status, "not_run");
      assert("and says why", unavailable.status === "not_run" && unavailable.reason.includes("unreachable"),
        unavailable.status === "not_run" ? unavailable.reason : "");
      check("with nothing written",
        await prisma.supplierEconomics.count({ where: { storeId: down.id } }), 0);
    }

    // =======================================================================
    console.log("\n6. How many round trips nextMoves actually makes");
    {
      await reset();
      const { store, product } = await business("measured");
      await stateCapital(store.id, 45_000, ["hold_stock"]);

      // A realistic ceiling: nextMoves takes 25 candidates, and this store has a
      // graduation as well. This is the shape a real Home load hits.
      for (let i = 0; i < 25; i++) {
        await prisma.sourcedProduct.create({
          data: {
            storeId: store.id, sourceKey: SOURCE, externalProductId: `cand-${i}`,
            kind: "WHOLESALE_DROPSHIP", name: `Recovery item ${i}`,
            description: "A recovery and training tool for use at home",
            score: 20, status: "SUGGESTED",
          },
        });
      }
      await runEconomicsProducer(
        producerFromSource(economicsSource({
          ok: true, currency: "USD",
          statements: [{ externalProductId: "roller-1", externalVariantId: null, unitCostInCents: 410, minimumOrderUnits: 100, shippingPerUnitInCents: 0, leadTimeDays: 7 }],
        })),
        { storeId: store.id }
      );

      // MEASURED, AND BY SOMETHING THAT ACTUALLY MEASURES IT.
      //
      // The first attempt counted `pg_stat_database.xact_commit` and produced
      // 394, which was nonsense: reads do not commit, so the number was mostly
      // autovacuum working through the rows this fixture had just inserted. It
      // is recorded here because a plausible number from a broken instrument is
      // worse than no number, and this one nearly bought an optimisation of
      // entirely the wrong thing.
      //
      // `pg_stat_all_tables` counts scans of ONE table, which is exactly the
      // question: how many separate times does resolving a page's worth of
      // candidates go and look at SupplierEconomics?
      const { resetEconomicsReadCount, economicsReadCount } = await import("@/lib/sourcing/economics");

      resetEconomicsReadCount();
      const startedAt = Date.now();
      const before = await nextMoves(store.id);
      const elapsed = Date.now() - startedAt;
      const lookups = economicsReadCount();

      const candidates = await prisma.sourcedProduct.count({
        where: { storeId: store.id, status: "SUGGESTED" },
      });

      console.log(`        ${candidates} candidates + 1 graduation`);
      console.log(`        nextMoves read SupplierEconomics ${lookups} times, ${elapsed}ms locally`);

      // THE ANSWER TO THE QUESTION THAT WAS ASKED. One read per candidate was
      // the pattern; one read for all of them is what it is now. The bar is the
      // SHAPE rather than a timing: a count that grows with the candidate list
      // means the sequential pattern has come back.
      assert(`lookups do not grow with the candidate list (${lookups} for ${candidates})`,
        lookups < candidates, `${lookups} vs ${candidates}`);

      assert("it still returns three moves", before.moves.length === 3, String(before.moves.length));

      // IDENTICAL DECISIONS, ASSERTED RATHER THAN ASSUMED. If batching had
      // resolved one candidate's economics onto another, the outcome would move
      // — a candidate that suddenly "has" a minimum it never had is exactly what
      // a keying mistake looks like from the outside. Nothing about ranking,
      // fit or feasibility was touched, and this is what says so.
      check("the same three moves, in the same order",
        before.moves.map((m) => `${m.kind}:${m.outcome.kind}`),
        ["deepen:recommended_now", "widen:recommended_now", "widen:recommended_now"]);
      check("about the proven product first", before.moves[0].productId, product.id);
      // Every candidate was considered, not just the ones that happened to have
      // a row in the batch.
      check("and everything was considered", before.consideredCount, candidates + 1);
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
