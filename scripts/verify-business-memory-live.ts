import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// BUSINESS MEMORY, AGAINST A REAL DATABASE:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-business-memory-live.ts" -OutFile out.txt
//
// The BI Engine's nine milestones were all proved at the logic level and none
// against a database — `BI_ENGINE.md` says so itself. This is the consolidated
// live pass, focused on the property the whole layer turns on rather than on
// re-testing seven suites' worth of arithmetic that is already pure and proved:
//
//   facts -> events -> insights -> recommendations -> observations -> beliefs
//
// Belief is the PERSISTENT UNDERSTANDING LAYER, never a second source of truth.
// A price lives in SupplierEconomics and nowhere else; a belief is a pattern
// ACROSS what happened, grounded by real evidence ids, and every section here
// exists to hold one of those two sentences.

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

  const { recordExecutionEvent, mapExecutionToEvent } = await import("@/lib/intelligence/executionEvents");
  const { distillBeliefs, getBeliefs } = await import("@/lib/intelligence/learn");
  const { adoptSourcedProduct } = await import("@/lib/sourcing/adopt");
  const { answerEconomicsQuestion } = await import("@/lib/sourcing/economicsAnswer");
  const { recordOwnerQuote } = await import("@/lib/sourcing/economicsIngest");
  const { supplierEconomics, bulkTerms } = await import("@/lib/sourcing/economics");
  const { internalItemId } = await import("@/lib/businessModel/internalMapper");
  const { getEntityHistory } = await import("@/lib/businessModel/reasoning");
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

  let n = 0;
  async function business(slug: string) {
    const user = await prisma.user.create({ data: { email: `${slug}-${++n}@example.test` } });
    const store = await prisma.store.create({
      data: {
        userId: user.id, name: slug, slug, tagline: "t",
        description: "A fitness and recovery brand for people who train at home.",
        brandPositioning: "minimalist", currency: "USD",
      },
    });
    const product = await prisma.product.create({
      data: {
        storeId: store.id, name: "Foam roller", description: "recovery training",
        priceInCents: 1_800, costInCents: 980, sourceKind: "WHOLESALE_DROPSHIP",
        sourceKey: "printful", externalProductId: "roller-1", active: true,
      },
    });
    await prisma.sourcedProduct.create({
      data: {
        storeId: store.id, sourceKey: "printful", externalProductId: "roller-1",
        kind: "WHOLESALE_DROPSHIP", name: "Foam roller",
        adoptedProductId: product.id, status: "ADOPTED",
      },
    });
    return { user, store, product };
  }

  const REF = { sourceKey: "printful", externalProductId: "roller-1", externalVariantId: null };

  const answerInput = (kind: "quoted" | "supplier_would_not_say" | "dont_know_yet") => ({
    sourceKey: REF.sourceKey,
    externalProductId: REF.externalProductId,
    externalVariantId: null,
    answer:
      kind === "quoted"
        ? { kind, minimumOrderUnits: 100, bulkUnitCostInCents: 410 }
        : { kind },
  });

  try {
    // =======================================================================
    console.log("\n1. An owner's answer becomes something that happened");
    {
      await reset();
      const { store, product } = await business("answered");

      await recordExecutionEvent({
        storeId: store.id,
        executionId: "exec-1",
        actionType: "answer_supplier_economics",
        input: answerInput("quoted"),
        status: "SUCCESS",
        metadata: { result: { productId: product.id } },
      });

      const events = await prisma.businessEvent.findMany({ where: { storeId: store.id } });
      check("exactly one event", events.length, 1);
      check("naming what happened", events[0].eventType, "supplier.terms_answered");
      // POINTED AT THE RECORD UNDERSTANDING KNOWS, not at a supplier reference
      // nothing else in the model recognises.
      check("about the owned product", events[0].recordId, internalItemId(product.id));
      check("as an item", events[0].entityType, "item");
      check("written as first-party", events[0].sourceProvider, "internal");

      // NO PRICE IN THE EVENT. SupplierEconomics is the system of record, and a
      // figure copied here would be a second one that could disagree with it.
      const payload = JSON.stringify(events[0].data);
      assert("no figure was copied into the event",
        !payload.includes("410") && !payload.includes("100"), payload);
      assert("only enough to trace it back",
        payload.includes("printful") && payload.includes("roller-1"), payload);
    }

    // =======================================================================
    console.log("\n2. Idempotent per execution");
    {
      await reset();
      const { store, product } = await business("idempotent");
      const call = () =>
        recordExecutionEvent({
          storeId: store.id,
          executionId: "exec-same",
          actionType: "answer_supplier_economics",
          input: answerInput("quoted"),
          status: "SUCCESS",
          metadata: { result: { productId: product.id } },
        });

      // A retried execution, a replayed queue, a double click — one event.
      await call();
      await call();
      await call();
      check("three calls, one event", await prisma.businessEvent.count({ where: { storeId: store.id } }), 1);

      // A DIFFERENT execution is a different thing that happened.
      await recordExecutionEvent({
        storeId: store.id,
        executionId: "exec-other",
        actionType: "answer_supplier_economics",
        input: answerInput("supplier_would_not_say"),
        status: "SUCCESS",
        metadata: { result: { productId: product.id } },
      });
      check("a second execution is a second event",
        await prisma.businessEvent.count({ where: { storeId: store.id } }), 2);
    }

    // =======================================================================
    console.log("\n3. The three answers stay three different facts");
    {
      // Pure, and asserted directly: what an owner said is not collapsed into
      // "they replied". "They wouldn't quote me" and "I haven't found out" are
      // different things to remember.
      const kinds = ["quoted", "supplier_would_not_say", "dont_know_yet"] as const;
      const types = kinds.map(
        (k) =>
          mapExecutionToEvent({
            actionType: "answer_supplier_economics",
            input: answerInput(k),
            status: "SUCCESS",
            executionId: "x",
          })?.eventType
      );
      check("three answers, three event types", types,
        ["supplier.terms_answered", "supplier.terms_refused", "supplier.terms_unknown"]);

      // A FAILED execution is not something that happened.
      check("a failure records nothing",
        mapExecutionToEvent({
          actionType: "answer_supplier_economics",
          input: answerInput("quoted"),
          status: "FAILED",
          executionId: "x",
        }), null);

      // An answer about a candidate nobody adopted concerns no owned record,
      // and null is the honest result rather than a fabricated id.
      const orphan = mapExecutionToEvent({
        actionType: "answer_supplier_economics",
        input: answerInput("quoted"),
        status: "SUCCESS",
        executionId: "x",
      });
      check("no product, no record link", orphan?.recordId, null);
    }

    // =======================================================================
    console.log("\n4. Adoption reaches the pipeline too");
    {
      await reset();
      const user = await prisma.user.create({ data: { email: "adopting@example.test" } });
      const store = await prisma.store.create({
        data: {
          userId: user.id, name: "adopting", slug: "adopting", tagline: "t",
          description: "A fitness and recovery brand.", brandPositioning: "minimalist", currency: "USD",
        },
      });
      const candidate = await prisma.sourcedProduct.create({
        data: {
          storeId: store.id, sourceKey: "printful", externalProductId: "band-1",
          kind: "WHOLESALE_DROPSHIP", name: "Resistance bands",
          status: "SUGGESTED", score: 20, suggestedRetailInCents: 1_800,
        },
      });

      const adopted = await adoptSourcedProduct({ storeId: store.id, sourcedProductId: candidate.id });
      assert("it was adopted", adopted.ok, JSON.stringify(adopted));

      const events = await prisma.businessEvent.findMany({ where: { storeId: store.id } });
      check("adopting produced an event", events.length, 1);
      check("as an item being created", events[0].eventType, "item.created");
      check("about the real product",
        events[0].recordId, adopted.ok ? internalItemId(adopted.productId) : null);

      // IDEMPOTENT BY THE SAME ROUTE ADOPTION ALREADY WAS. Adopting twice is a
      // no-op, so it cannot produce a second event either.
      await adoptSourcedProduct({ storeId: store.id, sourcedProductId: candidate.id });
      check("adopting twice is still one event",
        await prisma.businessEvent.count({ where: { storeId: store.id } }), 1);
    }

    // =======================================================================
    console.log("\n5. Repeated evidence becomes a belief, grounded in it");
    {
      await reset();
      const { store, product } = await business("remembers");
      const recordId = internalItemId(product.id);

      // The same thing happening across two separate weeks is what the
      // detector's own threshold is. Written directly as events, because what
      // is under test is the DISTILLATION, not how the events got there.
      const ids: string[] = [];
      for (const [i, when] of [daysAgo(20), daysAgo(6)].entries()) {
        const row = await prisma.businessEvent.create({
          data: {
            storeId: store.id, sequence: BigInt(i + 1), sourceProvider: "internal",
            recordId, entityType: "item",
            eventType: "supplier.terms_unknown",
            summary: "The owner has not found out what their supplier charges.",
            occurredAt: when,
            data: { executionId: `e${i}` },
          },
        });
        ids.push(row.id);
      }

      await distillBeliefs(store.id);

      const beliefs = await getBeliefs(store.id);
      const learned = beliefs.find((b) => b.topicKey.startsWith("event_recurrence:supplier.terms_unknown"));
      assert("a belief was formed", learned !== undefined, JSON.stringify(beliefs.map((b) => b.topicKey)));

      // GENUINE EVIDENCE, not a count. Every id has to be a real BusinessEvent
      // row — a belief that cannot be traced back is not allowed to exist.
      const row = await prisma.belief.findFirstOrThrow({
        where: { storeId: store.id, topicKey: learned!.topicKey },
      });
      check("grounded in both events", [...row.evidenceRefs].sort(), [...ids].sort());
      const grounding = await prisma.businessEvent.findMany({ where: { id: { in: row.evidenceRefs } } });
      check("and every reference is a real row", grounding.length, ids.length);

      // THE RECORD LINK. `create` set it and `update` dropped it, so a belief
      // re-derived on the next pass — which is every pass — lost the identity
      // the per-record read was built to use.
      check("it knows which record it is about", row.recordId, recordId);
      check("and what kind", row.entityType, "item");

      await distillBeliefs(store.id);
      const afterSecondPass = await prisma.belief.findFirstOrThrow({
        where: { storeId: store.id, topicKey: learned!.topicKey },
      });
      check("re-derivation keeps the record link", afterSecondPass.recordId, recordId);
      check("and does not duplicate the belief",
        await prisma.belief.count({ where: { storeId: store.id, topicKey: learned!.topicKey } }), 1);

      // READ BACK BY THE PATH BUILT FOR IT. reasoning.ts has had this read since
      // Learn's Phase 2 and it returned nothing, because nothing populated it.
      const history = await getEntityHistory(store.id, "item", recordId);
      check("reasoning.ts can see it", history.beliefs.length, 1);
      assert("with the claim it made",
        history.beliefs[0].claim.includes("supplier.terms_unknown"),
        history.beliefs[0].claim);
    }

    // =======================================================================
    console.log("\n6. No ungrounded belief can exist");
    {
      await reset();
      const { store, product } = await business("ungrounded");
      const recordId = internalItemId(product.id);

      // ONE occurrence, in one week. Real, but not a pattern.
      await prisma.businessEvent.create({
        data: {
          storeId: store.id, sequence: BigInt(1), sourceProvider: "internal",
          recordId, entityType: "item",
          eventType: "supplier.terms_unknown", summary: "s", occurredAt: daysAgo(1),
        },
      });
      await distillBeliefs(store.id);
      check("one occurrence is not a belief", await prisma.belief.count({ where: { storeId: store.id } }), 0);

      // And with no events at all there is nothing to believe.
      await reset();
      const quiet = await business("silent");
      await distillBeliefs(quiet.store.id);
      check("no evidence, no belief", await prisma.belief.count({ where: { storeId: quiet.store.id } }), 0);

      // EVERY belief that does exist carries references. Asserted over the whole
      // table rather than one row, because the invariant is about all of them.
      await reset();
      const busy = await business("busy");
      const busyRecord = internalItemId(busy.product.id);
      for (const [i, when] of [daysAgo(20), daysAgo(6), daysAgo(2)].entries()) {
        await prisma.businessEvent.create({
          data: {
            storeId: busy.store.id, sequence: BigInt(i + 1), sourceProvider: "internal",
            recordId: busyRecord, entityType: "item",
            eventType: "supplier.terms_refused", summary: "s", occurredAt: when,
          },
        });
      }
      await distillBeliefs(busy.store.id);
      const all = await prisma.belief.findMany({ where: { storeId: busy.store.id } });
      assert("at least one belief formed", all.length > 0);
      assert("and not one of them is ungrounded",
        all.every((b) => b.evidenceRefs.length > 0), JSON.stringify(all.map((b) => b.evidenceRefs.length)));
    }

    // =======================================================================
    console.log("\n7. Economics stays the system of record");
    {
      await reset();
      const { user, store, product } = await business("record-of-truth");

      await recordOwnerQuote({
        storeId: store.id, ref: REF, minimumOrderUnits: 100, bulkUnitCostInCents: 410, userId: user.id,
      });
      const result = await answerEconomicsQuestion({
        storeId: store.id, ref: REF, userId: user.id,
        answer: { kind: "quoted", minimumOrderUnits: 50, bulkUnitCostInCents: 380 },
      });
      check("the answer names its product", result.productId, product.id);

      // THE FIGURES LIVE IN ONE PLACE.
      const terms = bulkTerms(await supplierEconomics(store.id, REF));
      check("economics holds them", [terms.minimumOrderUnits, terms.bulkUnitCostInCents], [50, 380]);

      // Now let a belief form from the events, and prove no figure followed it.
      const recordId = internalItemId(product.id);
      for (const [i, when] of [daysAgo(20), daysAgo(6)].entries()) {
        await prisma.businessEvent.create({
          data: {
            storeId: store.id, sequence: BigInt(i + 10), sourceProvider: "internal",
            recordId, entityType: "item",
            eventType: "supplier.terms_answered", summary: "The owner answered.", occurredAt: when,
          },
        });
      }
      await distillBeliefs(store.id);

      const beliefs = await prisma.belief.findMany({ where: { storeId: store.id } });
      assert("a belief exists", beliefs.length > 0);
      const serialised = JSON.stringify(beliefs);
      // NOT A SECOND SOURCE OF TRUTH. If a price ever appears in a belief, two
      // tables can disagree about what something costs and nothing says which
      // to believe.
      assert("no supplier figure reached any belief",
        !serialised.includes("380") && !serialised.includes("410") && !serialised.includes('"50"'),
        serialised.slice(0, 300));
      // What a belief IS allowed to hold: a pattern, and what grounds it.
      assert("what it holds is a pattern and its evidence",
        beliefs.every((b) => b.evidenceRefs.length > 0 && b.claim.length > 0));
    }

    // =======================================================================
    console.log("\n8. The cycle still does what it did");
    {
      await reset();
      const { store, product } = await business("cycle");
      const { runIntelligenceCycle } = await import("@/lib/intelligence/cycle");
      const { computeInsights } = await import("@/lib/intelligence/insights");

      const recordId = internalItemId(product.id);
      for (const [i, when] of [daysAgo(20), daysAgo(6)].entries()) {
        await prisma.businessEvent.create({
          data: {
            storeId: store.id, sequence: BigInt(i + 1), sourceProvider: "internal",
            recordId, entityType: "item",
            eventType: "supplier.terms_unknown", summary: "s", occurredAt: when,
          },
        });
      }

      // THE WHOLE PASS, against a real database, for the first time — and it
      // cannot complete here, for a reason worth recording rather than hiding.
      //
      // runIntelligenceCycle ends with the recommendation stage, which is the
      // one AI call in the engine. A harness has no provider credentials, so the
      // pass throws at that point. That is an external boundary, exactly like
      // the Printful one, and not something to paper over with a fake key.
      //
      // WHAT IT PROVES ANYWAY, and it is the property that matters: Learn runs
      // BEFORE Reason and unconditionally, so a business's memory does not
      // depend on an AI provider being reachable. The beliefs below were
      // distilled during a pass that then failed.
      let cycleError: unknown = null;
      try {
        await runIntelligenceCycle(store.id);
      } catch (error) {
        cycleError = error;
      }

      assert("Learn ran even though the pass could not finish",
        (await prisma.belief.count({ where: { storeId: store.id } })) > 0,
        String(cycleError).slice(0, 120));
      assert("and the only thing that stopped it was the AI provider",
        cycleError === null || String(cycleError).includes("authentication") ||
          String(cycleError).includes("unexpected problem generating"),
        String(cycleError).slice(0, 200));

      // The deterministic half is idempotent, which is what makes a retried pass
      // safe. Asserted against the two stages that actually run unattended.
      const before = await prisma.belief.count({ where: { storeId: store.id } });
      await computeInsights(store.id);
      await distillBeliefs(store.id);
      check("a second deterministic pass changes nothing",
        await prisma.belief.count({ where: { storeId: store.id } }), before);
    }

    // =======================================================================
    console.log("\n9. One business never learns another's lesson");
    {
      await reset();
      const a = await business("aaa");
      const b = await business("bbb");

      const recordA = internalItemId(a.product.id);
      for (const [i, when] of [daysAgo(20), daysAgo(6)].entries()) {
        await prisma.businessEvent.create({
          data: {
            storeId: a.store.id, sequence: BigInt(i + 1), sourceProvider: "internal",
            recordId: recordA, entityType: "item",
            eventType: "supplier.terms_unknown", summary: "s", occurredAt: when,
          },
        });
      }

      await distillBeliefs(a.store.id);
      await distillBeliefs(b.store.id);

      check("the one with evidence learned", (await prisma.belief.count({ where: { storeId: a.store.id } })) > 0, true);
      check("the one without did not", await prisma.belief.count({ where: { storeId: b.store.id } }), 0);
      check("and nothing crossed",
        (await prisma.belief.findMany()).every((x) => x.storeId === a.store.id), true);
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
