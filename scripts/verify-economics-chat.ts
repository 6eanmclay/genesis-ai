import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// ANSWERING J4 IN CONVERSATION, end to end against real Postgres:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-economics-chat.ts" -OutFile out.txt
//
// The answer path existed and was callable; a person could not walk it. This is
// the conversational end: J4 asks, the owner types the answer, the fact persists
// through the SAME recordOwnerQuote the card path uses, the progression
// re-evaluates, and what J4 says next changes.
//
// The model itself is not exercised here and deliberately so — what is verified
// is everything downstream of the tool call, which is where an owner's money is
// actually decided. Section 2 is the one that matters most: the model never
// supplies a supplier identity, so a wrong or absent product name resolves to a
// question rather than to somebody else's terms.

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
    applyChatEconomicsAnswer, chatAnswerFrom, outstandingEconomicsQuestions,
    describeOutstandingForJ4,
  } = await import("@/lib/sourcing/economicsChat");
  const { raiseEconomicsQuestions, economicsDedupeKey, ECONOMICS_TASK_SOURCE } =
    await import("@/lib/sourcing/economicsQuestions");
  const { supplierEconomics, bulkTerms, provenanceOf } = await import("@/lib/sourcing/economics");
  const { nextMoves } = await import("@/lib/sourcing/nextMoves");
  const { stateCapital } = await import("@/lib/sourcing/progression");
  const {
    STORE_CHAT_UNIFIED_TOOL_NAMES, buildStoreChatUnifiedTools,
    AnswerSupplierEconomicsToolInputSchema,
  } = await import("@/lib/execution/genesisTools");
  const { GENESIS_ACTIONS } = await import("@/lib/execution/genesisActions");
  const { answerSupplierEconomicsExecutable } = await import("@/lib/execution/executables/answerSupplierEconomics");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  // execute() resolves permission from a live session, which does not exist in a
  // script — the same constraint verify-orders-live.ts records. The executable
  // is driven with an explicit ctx: the SAME ctx execute() would build once
  // requireStorePermission has approved, plus its own verify() and the honest
  // FAILED-not-thrown contract, so everything the conversational path depends on
  // downstream of the engine's front door is genuinely exercised.
  let execSeq = 0;
  const asOwner = (storeId: string) => async (input: {
    sourceKey: string;
    externalProductId: string;
    externalVariantId?: string | null;
    answer: Parameters<typeof answerSupplierEconomicsExecutable.run>[0]["answer"];
  }) => {
    const owner = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { userId: true } });
    const ctx = { storeId, userId: owner.userId, actorType: "USER" as const, executionId: `test_${++execSeq}` };
    {
      const ran = await answerSupplierEconomicsExecutable.run(input, ctx);
      const checked = await answerSupplierEconomicsExecutable.verify!(input, ctx);
      await prisma.executionLog.create({
        data: {
          executionId: ctx.executionId, storeId, action: "answer_supplier_economics",
          status: checked.ok ? "SUCCESS" : "FAILED", verified: checked.ok,
          message: ran.message, retryable: false, actorType: "USER", actorId: owner.userId,
          metadata: {},
        },
      });
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
    }
  };

  /** What the model would emit, as the tool's own flat shape. */
  const toolInput = (over: Partial<{
    productName: string | null;
    outcome: "quoted" | "supplier_would_not_say" | "dont_know_yet";
    minimumOrderUnits: number | null;
    bulkUnitCostInCents: number | null;
    shippingPerUnitInCents: number | null;
    leadTimeDays: number | null;
    note: string | null;
  }> = {}) => ({
    productName: "Foam roller",
    outcome: "quoted" as const,
    minimumOrderUnits: null,
    bulkUnitCostInCents: null,
    shippingPerUnitInCents: null,
    leadTimeDays: null,
    note: null,
    ...over,
  });

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

  /** A business with a proven dropship product and J4's question already asked. */
  async function businessWithOpenQuestion(slug: string, productName = "Foam roller") {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    const store = await prisma.store.create({
      data: {
        userId: user.id, name: `${slug} co`, slug, tagline: "t",
        description: "A fitness and recovery brand for people who train at home.",
        brandPositioning: "minimalist", currency: "USD",
      },
    });
    const product = await prisma.product.create({
      data: {
        storeId: store.id, name: productName, description: "recovery training",
        priceInCents: 1_800, costInCents: 980, sourceKind: "WHOLESALE_DROPSHIP",
        sourceKey: "w", externalProductId: "roller-1", active: true,
      },
    });
    await prisma.sourcedProduct.create({
      data: {
        storeId: store.id, sourceKey: "w", externalProductId: "roller-1",
        kind: "WHOLESALE_DROPSHIP", name: productName,
        adoptedProductId: product.id, status: "ADOPTED",
      },
    });
    for (let i = 0; i < 60; i++) await sell(store.id, product.id, daysAgo(70 - i));
    await raiseEconomicsQuestions(store.id);
    return { user, store, product };
  }

  const ROLLER = { sourceKey: "w", externalProductId: "roller-1", externalVariantId: null };

  try {
    // =======================================================================
    console.log("\n1. The tool is really wired into the conversation");
    {
      assert("it is in the unified tool list",
        (STORE_CHAT_UNIFIED_TOOL_NAMES as readonly string[]).includes("answer_supplier_economics"));
      const tools = buildStoreChatUnifiedTools();
      const tool = tools.find((t) => t.name === "answer_supplier_economics");
      assert("and is really offered to the model", tool !== undefined);
      // THE MODEL IS NEVER ASKED FOR AN IDENTITY. A hallucinated sourceKey
      // deciding whose terms an answer lands on is the failure the four-part
      // key exists to prevent, and the schema is where that is made impossible.
      const properties = Object.keys(
        (tool?.input_schema as { properties?: Record<string, unknown> }).properties ?? {}
      );
      check("and cannot name a supplier",
        properties.filter((k) => k.startsWith("source") || k.startsWith("external")), []);
      assert("it asks for the product in the owner's words", properties.includes("productName"));
      // Every figure nullable, so half an answer is expressible.
      for (const field of ["minimumOrderUnits", "bulkUnitCostInCents"]) {
        assert(`${field} may be null`,
          AnswerSupplierEconomicsToolInputSchema.safeParse(toolInput({ [field]: null } as never)).success);
      }
      // And the action it reaches is still the locked one.
      check("the action behind it can never be delegated",
        GENESIS_ACTIONS.answer_supplier_economics.maxAuthorityTier, "always_ask");
    }

    // =======================================================================
    console.log("\n2. J4 is told what it is waiting for");
    {
      await reset();
      const { store } = await businessWithOpenQuestion("context");

      const open = await outstandingEconomicsQuestions(store.id);
      check("the open question is visible to chat", open.length, 1);
      check("with both halves missing", open[0].gaps, ["minimum_order", "bulk_price"]);
      check("and a real identity resolved server-side",
        [open[0].sourceKey, open[0].externalProductId], ["w", "roller-1"]);

      const line = describeOutstandingForJ4(open);
      assert("the model is told a question is outstanding",
        line?.includes("still waiting") === true, line ?? "none");
      assert("which product it concerns",
        line?.includes("Foam roller") === true, line ?? "none");
      assert("what is missing",
        line?.includes("the minimum order") === true && line?.includes("the bulk price") === true, line ?? "none");
      // The instruction that keeps a model from filling in the blank.
      assert("and never to invent a figure",
        line?.includes("never fill in a figure they did not say") === true, line ?? "none");

      check("a business with nothing outstanding says nothing", describeOutstandingForJ4([]), null);
    }

    // =======================================================================
    console.log("\n3. The owner answers in chat, and the recommendation changes");
    {
      await reset();
      const { store } = await businessWithOpenQuestion("answers-in-chat");
      await stateCapital(store.id, 45_000, ["hold_stock"]);

      check("before: J4 is asking", (await nextMoves(store.id)).moves[0].kind, "unblock");

      const outcome = await applyChatEconomicsAnswer({
        storeId: store.id,
        runAction: asOwner(store.id),
        answer: chatAnswerFrom(toolInput({
          minimumOrderUnits: 100, bulkUnitCostInCents: 410,
          shippingPerUnitInCents: 0, leadTimeDays: 14, note: "rang them this morning",
        })),
      });

      check("the answer was applied", outcome.status, "applied");
      if (outcome.status !== "applied") throw new Error("expected applied");

      // THE SAME PERSISTENCE PATH AS THE CARD. Provenance proves it.
      const stored = await supplierEconomics(store.id, ROLLER);
      check("recorded as the owner's own", [provenanceOf(stored, "minimumOrder"), provenanceOf(stored, "unitCost")], ["OWNER", "OWNER"]);
      check("with the figures they gave",
        [bulkTerms(stored).minimumOrderUnits, bulkTerms(stored).bulkUnitCostInCents], [100, 410]);
      check("and their words kept", stored?.note, "rang them this morning");

      // Through the engine, so it is a recorded execution like every other change.
      const log = await prisma.executionLog.findFirst({
        where: { storeId: store.id, action: "answer_supplier_economics" },
        orderBy: { createdAt: "desc" },
      });
      assert("it went through the execution engine", log !== null);
      check("and succeeded", log?.status, "SUCCESS");
      check("verified independently", log?.verified, true);

      check("the progression re-evaluated", outcome.result.reevaluated, true);
      check("nothing is outstanding now", outcome.result.stillMissing, []);
      check("after: a real move", (await nextMoves(store.id)).moves[0].kind, "deepen");

      // THE REPLY SAYS WHAT WAS LEARNED.
      assert("the reply names what it learned",
        outcome.reply.includes("how many you have to order") && outcome.reply.includes("what they charge per unit"),
        outcome.reply);
      assert("and what it now recommends", outcome.reply.includes("worth doing"), outcome.reply);
      assert("without claiming anything is still missing",
        !outcome.reply.includes("I still don't know"), outcome.reply);

      // And the card J4 raised is closed.
      const task = await prisma.task.findUnique({
        where: { storeId_dedupeKey: { storeId: store.id, dedupeKey: economicsDedupeKey(ROLLER) } },
      });
      check("the question is answered", task?.status, "COMPLETED");
    }

    // =======================================================================
    console.log("\n4. Half an answer is kept, and the reply says what is missing");
    {
      await reset();
      const { store } = await businessWithOpenQuestion("half-in-chat");

      // ONLY THE MINIMUM. This is the case a both-or-nothing schema would lose.
      const first = await applyChatEconomicsAnswer({
        storeId: store.id,
        runAction: asOwner(store.id),
        answer: chatAnswerFrom(toolInput({ minimumOrderUnits: 100 })),
      });
      check("it was applied", first.status, "applied");
      if (first.status !== "applied") throw new Error("expected applied");

      check("the minimum is on file", bulkTerms(await supplierEconomics(store.id, ROLLER)).minimumOrderUnits, 100);
      check("the price is still unknown", bulkTerms(await supplierEconomics(store.id, ROLLER)).bulkUnitCostInCents, null);
      check("and it is named as outstanding", first.result.stillMissing, ["bulk_price"]);

      // THE HALF-TRUTH THAT SOUNDS LIKE ALL OF IT. A reply that reported the
      // fact without the gap is how an owner comes away thinking the question
      // is closed when it is not.
      assert("the reply says what it learned",
        first.reply.includes("how many you have to order"), first.reply);
      assert("AND what it still does not know",
        first.reply.includes("I still don't know what they charge per unit"), first.reply);

      check("the card stays open",
        (await prisma.task.findUnique({
          where: { storeId_dedupeKey: { storeId: store.id, dedupeKey: economicsDedupeKey(ROLLER) } },
        }))?.status, "OPEN");

      // And the next ask is for the other half only.
      await raiseEconomicsQuestions(store.id);
      check("only the price is asked for now",
        (await outstandingEconomicsQuestions(store.id))[0].gaps, ["bulk_price"]);
      assert("and the context line reflects that",
        describeOutstandingForJ4(await outstandingEconomicsQuestions(store.id))
          ?.includes("still missing: the bulk price per unit") === true,
        describeOutstandingForJ4(await outstandingEconomicsQuestions(store.id)) ?? "");

      // Then the other half, in a second message.
      const second = await applyChatEconomicsAnswer({
        storeId: store.id,
        runAction: asOwner(store.id),
        answer: chatAnswerFrom(toolInput({ bulkUnitCostInCents: 410 })),
      });
      check("the second half is applied", second.status, "applied");
      if (second.status !== "applied") throw new Error("expected applied");
      check("both figures are now on file",
        [bulkTerms(await supplierEconomics(store.id, ROLLER)).minimumOrderUnits,
         bulkTerms(await supplierEconomics(store.id, ROLLER)).bulkUnitCostInCents], [100, 410]);
      check("nothing outstanding", second.result.stillMissing, []);
      check("and the question closes",
        (await prisma.task.findUnique({
          where: { storeId_dedupeKey: { storeId: store.id, dedupeKey: economicsDedupeKey(ROLLER) } },
        }))?.status, "COMPLETED");
    }

    // =======================================================================
    console.log("\n5. The four states stay four states");
    {
      // Known minimum only.
      await reset();
      let store = (await businessWithOpenQuestion("state-min")).store;
      await applyChatEconomicsAnswer({
        storeId: store.id,
        runAction: asOwner(store.id), answer: chatAnswerFrom(toolInput({ minimumOrderUnits: 100 })),
      });
      check("minimum known, price unknown",
        [bulkTerms(await supplierEconomics(store.id, ROLLER)).minimumOrderUnits,
         bulkTerms(await supplierEconomics(store.id, ROLLER)).bulkUnitCostInCents], [100, null]);

      // Known unit cost only.
      await reset();
      store = (await businessWithOpenQuestion("state-price")).store;
      await applyChatEconomicsAnswer({
        storeId: store.id,
        runAction: asOwner(store.id), answer: chatAnswerFrom(toolInput({ bulkUnitCostInCents: 410 })),
      });
      check("price known, minimum unknown",
        [bulkTerms(await supplierEconomics(store.id, ROLLER)).minimumOrderUnits,
         bulkTerms(await supplierEconomics(store.id, ROLLER)).bulkUnitCostInCents], [null, 410]);

      // Both.
      await reset();
      store = (await businessWithOpenQuestion("state-both")).store;
      await applyChatEconomicsAnswer({
        storeId: store.id,
        runAction: asOwner(store.id),
        answer: chatAnswerFrom(toolInput({ minimumOrderUnits: 100, bulkUnitCostInCents: 410 })),
      });
      check("both known",
        [bulkTerms(await supplierEconomics(store.id, ROLLER)).minimumOrderUnits,
         bulkTerms(await supplierEconomics(store.id, ROLLER)).bulkUnitCostInCents], [100, 410]);

      // The supplier refused — a real answer, and it is "no".
      await reset();
      store = (await businessWithOpenQuestion("state-refused")).store;
      const refused = await applyChatEconomicsAnswer({
        storeId: store.id,
        runAction: asOwner(store.id),
        answer: chatAnswerFrom(toolInput({ outcome: "supplier_would_not_say", note: "wouldn't quote under 1000" })),
      });
      check("recorded as unavailable", provenanceOf(await supplierEconomics(store.id, ROLLER), "unitCost"), "UNAVAILABLE");
      check("and quotes nothing", bulkTerms(await supplierEconomics(store.id, ROLLER)).bulkUnitCostInCents, null);
      assert("the reply says they wouldn't quote",
        refused.reply.includes("wouldn't quote you"), refused.reply);

      // THE OWNER HASN'T FOUND OUT. Nothing is written, and it is emphatically
      // not recorded as a refusal — that would be Genesis claiming somebody
      // asked, which is a different fact and a false one.
      await reset();
      store = (await businessWithOpenQuestion("state-unknown")).store;
      const unknown = await applyChatEconomicsAnswer({
        storeId: store.id,
        runAction: asOwner(store.id),
        answer: chatAnswerFrom(toolInput({ outcome: "dont_know_yet", note: "will ring them tomorrow" })),
      });
      check("nothing was written at all",
        await prisma.supplierEconomics.count({ where: { storeId: store.id } }), 0);
      check("no row exists", await supplierEconomics(store.id, ROLLER), null);
      check("nothing was re-evaluated",
        unknown.status === "applied" ? unknown.result.reevaluated : null, false);
      assert("the reply says the question stays open",
        unknown.reply.includes("keep the question open"), unknown.reply);
      assert("and still names both gaps",
        unknown.reply.includes("how many you have to order at once") &&
          unknown.reply.includes("what they charge per unit"), unknown.reply);
      check("the card is still open",
        (await prisma.task.findUnique({
          where: { storeId_dedupeKey: { storeId: store.id, dedupeKey: economicsDedupeKey(ROLLER) } },
        }))?.status, "OPEN");
      check("and J4 is still asking", (await nextMoves(store.id)).moves[0].kind, "unblock");
    }

    // =======================================================================
    console.log("\n6. An answer that cannot be placed writes nothing");
    {
      await reset();
      const { store } = await businessWithOpenQuestion("ambiguous");

      // A product name that matches nothing outstanding. The tempting move is
      // "there's only one open question, use it" — and that is exactly how a
      // supplier's terms land on the wrong product.
      const wrong = await applyChatEconomicsAnswer({
        storeId: store.id,
        runAction: asOwner(store.id),
        answer: chatAnswerFrom(toolInput({ productName: "Resistance bands", minimumOrderUnits: 100, bulkUnitCostInCents: 410 })),
      });
      check("it is not applied", wrong.status, "unresolved");
      check("and nothing was written",
        await prisma.supplierEconomics.count({ where: { storeId: store.id } }), 0);
      assert("J4 asks which product instead",
        wrong.reply.includes("which one") || wrong.reply.includes("not sure which"), wrong.reply);

      // Two open questions and no name given is also unresolvable.
      const second = await prisma.product.create({
        data: {
          storeId: store.id, name: "Resistance bands", description: "recovery training",
          priceInCents: 1_800, costInCents: 980, sourceKind: "WHOLESALE_DROPSHIP",
          sourceKey: "w", externalProductId: "bands-1", active: true,
        },
      });
      await prisma.sourcedProduct.create({
        data: {
          storeId: store.id, sourceKey: "w", externalProductId: "bands-1",
          kind: "WHOLESALE_DROPSHIP", name: "Resistance bands",
          adoptedProductId: second.id, status: "ADOPTED",
        },
      });
      for (let i = 0; i < 60; i++) await sell(store.id, second.id, daysAgo(70 - i));
      await raiseEconomicsQuestions(store.id);
      check("two questions are open", (await outstandingEconomicsQuestions(store.id)).length, 2);

      const nameless = await applyChatEconomicsAnswer({
        storeId: store.id,
        runAction: asOwner(store.id),
        answer: chatAnswerFrom(toolInput({ productName: null, minimumOrderUnits: 100, bulkUnitCostInCents: 410 })),
      });
      check("an unnamed answer with two questions is unresolved", nameless.status, "unresolved");
      check("and still nothing written",
        await prisma.supplierEconomics.count({ where: { storeId: store.id } }), 0);
      assert("J4 names both so the owner can pick",
        nameless.reply.includes("Foam roller") && nameless.reply.includes("Resistance bands"), nameless.reply);

      // Named, it lands on exactly the one named.
      const named = await applyChatEconomicsAnswer({
        storeId: store.id,
        runAction: asOwner(store.id),
        answer: chatAnswerFrom(toolInput({ productName: "resistance bands", minimumOrderUnits: 250, bulkUnitCostInCents: 300 })),
      });
      check("the named product is answered", named.status, "applied");
      check("its terms are recorded",
        bulkTerms(await supplierEconomics(store.id, { sourceKey: "w", externalProductId: "bands-1", externalVariantId: null }))
          .minimumOrderUnits, 250);
      check("and the other product is untouched",
        await supplierEconomics(store.id, ROLLER), null);
    }

    // =======================================================================
    console.log("\n7. Nothing outstanding means nothing to file against");
    {
      await reset();
      const user = await prisma.user.create({ data: { email: "quiet@example.test" } });
      const store = await prisma.store.create({
        data: {
          userId: user.id, name: "quiet", slug: "quiet", tagline: "t",
          description: "A fitness brand.", brandPositioning: "minimalist", currency: "USD",
        },
      });

      const outcome = await applyChatEconomicsAnswer({
        storeId: store.id,
        runAction: asOwner(store.id),
        answer: chatAnswerFrom(toolInput({ minimumOrderUnits: 100, bulkUnitCostInCents: 410 })),
      });
      check("it is unresolved", outcome.status, "unresolved");
      check("and nothing was written",
        await prisma.supplierEconomics.count({ where: { storeId: store.id } }), 0);
      assert("J4 says so plainly",
        outcome.reply.includes("don't have an outstanding supplier question"), outcome.reply);
    }

    // =======================================================================
    console.log("\n8. A chat answer cannot reach another business");
    {
      await reset();
      const gym = (await businessWithOpenQuestion("gym-chat")).store;
      const coil = (await businessWithOpenQuestion("coil-chat")).store;

      await applyChatEconomicsAnswer({
        storeId: gym.id,
        runAction: asOwner(gym.id),
        answer: chatAnswerFrom(toolInput({ minimumOrderUnits: 100, bulkUnitCostInCents: 410 })),
      });

      check("the answering business has it",
        bulkTerms(await supplierEconomics(gym.id, ROLLER)).minimumOrderUnits, 100);
      check("the other business has nothing", await supplierEconomics(coil.id, ROLLER), null);
      check("and its question is still open",
        (await prisma.task.count({
          where: { storeId: coil.id, source: ECONOMICS_TASK_SOURCE, status: "OPEN" },
        })), 1);
      check("while the gym's closed",
        (await prisma.task.count({
          where: { storeId: gym.id, source: ECONOMICS_TASK_SOURCE, status: "COMPLETED" },
        })), 1);
    }

    // =======================================================================
    console.log("\n9. A restatement is honest about having changed nothing");
    {
      await reset();
      const { store } = await businessWithOpenQuestion("restated-chat");
      // Half an answer, so the question stays open and there is still something
      // for a second message to attach to. Once a question is CLOSED there is
      // deliberately nothing to answer — proven in section 7.
      await applyChatEconomicsAnswer({
        storeId: store.id,
        runAction: asOwner(store.id),
        answer: chatAnswerFrom(toolInput({ minimumOrderUnits: 100 })),
      });

      const again = await applyChatEconomicsAnswer({
        storeId: store.id,
        runAction: asOwner(store.id),
        answer: chatAnswerFrom(toolInput({ minimumOrderUnits: 100 })),
      });
      check("still applied", again.status, "applied");
      if (again.status !== "applied") throw new Error("expected applied");
      check("but nothing moved", again.result.changes, []);
      check("so nothing was recomputed", again.result.reevaluated, false);
      assert("and the owner is told that plainly, not congratulated",
        again.reply.includes("matches what I already had"), again.reply);
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
