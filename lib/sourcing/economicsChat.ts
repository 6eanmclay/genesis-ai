import { prisma } from "@/lib/prisma";
import { execute } from "@/lib/execution/engine";
import type { ExecutionResult } from "@/lib/execution/types";
import {
  answerSupplierEconomicsExecutable,
  type AnswerSupplierEconomicsInput,
  type AnswerSupplierEconomicsMetadata,
} from "@/lib/execution/executables/answerSupplierEconomics";
import { ECONOMICS_GAP_EXPLANATION, type EconomicsGap } from "./economics";
import { ECONOMICS_TASK_SOURCE } from "./economicsQuestions";
import type { AnswerResult, EconomicsAnswer } from "./economicsAnswer";

// ANSWERING J4'S SUPPLIER QUESTION BY TYPING THE ANSWER.
//
// The conversational end of the loop. J4 already raises the question as a Task;
// this is what lets an owner reply "they said 100 minimum at $4.10" in chat
// instead of finding a form.
//
// THE MODEL NEVER SUPPLIES AN IDENTITY, and that is the whole design of this
// file. A supplier product is identified by four parts — business, source,
// external id, variant — and a language model cannot know any of the last three.
// Letting it emit a `sourceKey` would mean a hallucinated string deciding which
// supplier's terms an owner's answer lands on, which is the exact wrong-number-
// about-money failure the identity key was built to make impossible.
//
// So the model supplies a PRODUCT NAME, in the owner's own words, and the
// identity is resolved here from the open question. If it cannot be resolved to
// exactly one, nothing is written and J4 asks which one — an ambiguous answer is
// not a reason to pick.

export interface OutstandingQuestion {
  /** The Task's own identity, so a card can answer exactly what it asked. */
  dedupeKey: string;
  productId: string;
  productName: string;
  sourceKey: string;
  externalProductId: string;
  externalVariantId: string | null;
  gaps: EconomicsGap[];
}

interface QuestionContext {
  productId?: unknown;
  sourceKey?: unknown;
  externalProductId?: unknown;
  externalVariantId?: unknown;
  gaps?: unknown;
}

function readContext(value: unknown): Required<QuestionContext> | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as QuestionContext;
  if (typeof raw.productId !== "string") return null;
  if (typeof raw.sourceKey !== "string") return null;
  if (typeof raw.externalProductId !== "string") return null;
  if (!Array.isArray(raw.gaps)) return null;
  return {
    productId: raw.productId,
    sourceKey: raw.sourceKey,
    externalProductId: raw.externalProductId,
    externalVariantId: typeof raw.externalVariantId === "string" ? raw.externalVariantId : null,
    gaps: raw.gaps,
  } as Required<QuestionContext>;
}

/**
 * The supplier questions this business currently has open.
 *
 * Read from the Task rows `raiseEconomicsQuestions` writes — the same inbox the
 * attention cards render, so chat and the dashboard can never be asking about
 * different things.
 */
export async function outstandingEconomicsQuestions(storeId: string): Promise<OutstandingQuestion[]> {
  const tasks = await prisma.task.findMany({
    where: { storeId, source: ECONOMICS_TASK_SOURCE, status: { in: ["OPEN", "IN_PROGRESS", "AWAITING_INPUT"] } },
    orderBy: { createdAt: "asc" },
  });

  const questions: OutstandingQuestion[] = [];
  for (const task of tasks) {
    const context = readContext(task.context);
    // A row whose snapshot cannot be read is skipped rather than guessed at.
    // Everything downstream of it decides where somebody's money goes.
    if (!context) continue;

    const product = await prisma.product.findFirst({
      where: { id: context.productId as string, storeId },
      select: { id: true, name: true },
    });
    if (!product) continue;

    questions.push({
      dedupeKey: task.dedupeKey,
      productId: product.id,
      productName: product.name,
      sourceKey: context.sourceKey as string,
      externalProductId: context.externalProductId as string,
      externalVariantId: (context.externalVariantId as string | null) || null,
      gaps: (context.gaps as EconomicsGap[]).filter(
        (gap): gap is EconomicsGap => gap in ECONOMICS_GAP_EXPLANATION
      ),
    });
  }
  return questions;
}

/**
 * The line J4 is given so it knows a question is outstanding.
 *
 * Same shape and purpose as the "Awaiting your decision" line the approval loop
 * already uses: without it the model has no way to know there is something real
 * to answer, and an owner replying "100 minimum, four ten each" to a question
 * asked yesterday reads as a non-sequitur.
 */
export function describeOutstandingForJ4(questions: OutstandingQuestion[]): string | null {
  if (questions.length === 0) return null;

  const each = questions.map((q) => {
    const missing = q.gaps.map((gap) => (gap === "minimum_order" ? "the minimum order" : gap === "bulk_price" ? "the bulk price per unit" : "usable price breaks"));
    return `"${q.productName}" (still missing: ${missing.join(" and ")})`;
  });

  return (
    `(You have asked the merchant what these products cost from their supplier and are still waiting: ${each.join(", ")}. ` +
    `If they now tell you any of it — a minimum order, a per-unit bulk price, that the supplier refused to quote, or that they haven't found out yet — ` +
    `call answer_supplier_economics. Give whichever facts they actually stated and leave the rest null; never fill in a figure they did not say.)`
  );
}

/** What a caller is allowed to say about an answer. Identity is not on the list. */
export interface ChatEconomicsAnswer {
  /** The product in the owner's words, matched against the open questions here. */
  productName: string | null;
  /**
   * The exact question being answered, when the caller genuinely knows it.
   *
   * The card does — the owner clicked a specific question — and the chat does
   * not, because a sentence names a product rather than a row. One resolution
   * function serves both so a card and a conversation cannot disagree about
   * which supplier an answer belongs to.
   */
  dedupeKey?: string | null;
  answer: EconomicsAnswer;
}

/**
 * The tool's flat shape, turned into the union the domain already speaks.
 *
 * Shared by both chat entry points — the streaming route and the Server Action
 * fallback run the same classification and must translate it identically, or the
 * same sentence would mean two different things depending on which path served
 * it.
 */
export function chatAnswerFrom(input: {
  productName: string | null;
  outcome: "quoted" | "supplier_would_not_say" | "dont_know_yet";
  minimumOrderUnits: number | null;
  bulkUnitCostInCents: number | null;
  shippingPerUnitInCents: number | null;
  leadTimeDays: number | null;
  note: string | null;
}): ChatEconomicsAnswer {
  if (input.outcome === "supplier_would_not_say") {
    return { productName: input.productName, answer: { kind: "supplier_would_not_say", note: input.note } };
  }
  if (input.outcome === "dont_know_yet") {
    return { productName: input.productName, answer: { kind: "dont_know_yet", note: input.note } };
  }
  return {
    productName: input.productName,
    answer: {
      kind: "quoted",
      // Passed through exactly as stated, nulls included. Nothing here supplies
      // a figure the merchant did not give.
      minimumOrderUnits: input.minimumOrderUnits,
      bulkUnitCostInCents: input.bulkUnitCostInCents,
      shippingPerUnitInCents: input.shippingPerUnitInCents,
      leadTimeDays: input.leadTimeDays,
      note: input.note,
    },
  };
}

/**
 * What the owner typed into the card, turned into an answer.
 *
 * PURE, AND SEPARATE FROM THE SERVER ACTION ON PURPOSE. Parsing is the one place
 * in the card path where a figure about somebody's money could be invented — a
 * blank field read as 0, a fraction of a unit rounded into existence — so it is
 * a function with a test rather than a few lines inside a form handler.
 *
 * An empty field is a field the owner did not fill in. It is left out of the
 * answer entirely rather than sent as 0, and `recordOwnerQuote` keeps whatever
 * was already known about the fact nobody typed into.
 */
export function parseCardEconomicsAnswer(input: {
  outcome: string;
  minimumOrderUnits?: string | null;
  bulkUnitCost?: string | null;
}): EconomicsAnswer {
  if (input.outcome === "supplier_would_not_say") return { kind: "supplier_would_not_say", note: null };
  if (input.outcome === "dont_know_yet") return { kind: "dont_know_yet", note: null };

  // A whole number of units, or nothing. Never 0, never a fraction — neither is
  // a quantity anybody can order, and both would read as an answer.
  const rawUnits = (input.minimumOrderUnits ?? "").trim();
  const units = rawUnits === "" ? null : Number(rawUnits);
  const minimumOrderUnits = units !== null && Number.isInteger(units) && units > 0 ? units : null;

  // Money as a person types it — "4.10", "$4.10" — turned into cents exactly
  // once. Anything that is not a non-negative number is not a price.
  const rawCost = (input.bulkUnitCost ?? "").trim().replace(/[^0-9.]/g, "");
  const cost = rawCost === "" ? null : Number(rawCost);
  const bulkUnitCostInCents =
    cost !== null && Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 100) : null;

  // A "quoted" submission with neither field filled in is not a quote. It is
  // somebody who has not found out yet, and saying so keeps the question open
  // instead of recording an empty answer as though it were one.
  if (minimumOrderUnits === null && bulkUnitCostInCents === null) {
    return { kind: "dont_know_yet", note: null };
  }

  return {
    kind: "quoted",
    minimumOrderUnits,
    bulkUnitCostInCents,
    shippingPerUnitInCents: null,
    leadTimeDays: null,
    note: null,
  };
}

export type ChatAnswerOutcome =
  | { status: "applied"; question: OutstandingQuestion; result: AnswerResult; reply: string }
  /** Nothing was written, and the reply says why. */
  | { status: "unresolved"; reply: string };

const GAP_PHRASE: Record<EconomicsGap, string> = {
  minimum_order: "how many you have to order at once",
  bulk_price: "what they charge per unit at that quantity",
  unusable_tiers: "what their price breaks actually are",
};

/**
 * What J4 says back — built in code, never by the model.
 *
 * Two things, always, and the second is the one a generated reply would drop:
 * what was learned, and what is still unknown. A reply that reports the fact it
 * just recorded without saying the other half is still missing is the part of
 * the truth that sounds like all of it, and it is how an owner comes away
 * thinking the question is closed when it is not.
 */
export function replyFor(question: OutstandingQuestion, result: AnswerResult): string {
  const remaining =
    result.stillMissing.length > 0
      ? ` I still don't know ${result.stillMissing.map((gap) => GAP_PHRASE[gap]).join(", or ")}.`
      : "";

  if (result.recorded === null) {
    return `No problem — I haven't written anything down for ${question.productName}, so I'll keep the question open until you find out.${remaining}`;
  }
  if (result.recorded.status === "rejected") {
    // NAMES THE PRODUCT, like every other branch here (2026-08-21). It was the
    // one reply that did not, and describeOutstandingForJ4 can legitimately have
    // several questions open at once — so "I couldn't record that: that price is
    // lower than their own bulk tier" left an owner who had just answered three
    // of them with no way to tell which one had failed.
    return `I couldn't record that for ${question.productName}: ${result.recorded.problem}.${remaining}`;
  }
  if (result.recorded.status === "preserved") {
    return `I've kept what you told me before about ${question.productName} — ${result.recorded.reason}.${remaining}`;
  }

  if (result.changes.includes("supplier_refused")) {
    return (
      `Noted — they wouldn't quote you on ${question.productName}. I'll stop asking about that one for now and look at whether ` +
      `another supplier is worth trying instead.`
    );
  }

  const learned: string[] = [];
  if (result.changes.includes("minimum_order_became_known")) learned.push("how many you have to order");
  if (result.changes.includes("minimum_order_lowered")) learned.push("that the minimum has come down");
  if (result.changes.includes("bulk_price_became_known")) learned.push("what they charge per unit");
  if (result.changes.includes("supplier_price_dropped")) learned.push("that the price has come down");
  if (result.changes.includes("shipping_became_known")) learned.push("what delivery costs");
  if (result.changes.includes("lead_time_became_known")) learned.push("how long they take");

  if (learned.length === 0) {
    // Recorded, but it matched what was already on file. Worth saying plainly:
    // the owner spent effort finding out and deserves to know it landed, and
    // deserves not to be told something changed when nothing did.
    return `Thanks — that matches what I already had for ${question.productName}, so nothing's changed.${remaining}`;
  }

  const opening = `Got it — that's ${learned.join(", and ")} for ${question.productName}.`;
  if (result.nowRecommends) {
    return `${opening}${remaining} That's enough to say what's worth doing: ${result.nowRecommends}`;
  }
  return `${opening}${remaining}`;
}

/**
 * Apply an answer the owner gave — typed in conversation, or filled into the
 * card J4 raised.
 *
 * Resolves the identity HERE, from the open question, then runs the existing
 * `answer_supplier_economics` action through the engine — so this path gets the
 * same permission check, ExecutionLog row and actor as every other real change,
 * and writes through `recordOwnerQuote` like everything else. There is no second
 * persistence route and nothing here touches the table directly.
 */
export async function applyEconomicsAnswer(input: {
  storeId: string;
  answer: ChatEconomicsAnswer;
  /**
   * How the action is run. Defaults to the real engine and nothing in the
   * application passes anything else.
   *
   * It exists because `execute()` resolves permission from a live session,
   * which a verification script does not have — the same constraint
   * verify-orders-live.ts records, and it solves it the same way: the suite
   * drives the executable with the exact ctx `execute()` would have built once
   * `requireStorePermission` approved. Without this the conversational path
   * could only be proven as far as the engine's front door, and everything that
   * decides where an owner's money goes is behind it.
   */
  runAction?: (
    input: AnswerSupplierEconomicsInput
  ) => Promise<ExecutionResult<AnswerSupplierEconomicsMetadata>>;
}): Promise<ChatAnswerOutcome> {
  const open = await outstandingEconomicsQuestions(input.storeId);

  if (open.length === 0) {
    return {
      status: "unresolved",
      reply: "I don't have an outstanding supplier question right now, so there's nothing for me to file that against.",
    };
  }

  // AN EXACT QUESTION BEATS A NAME. The card knows which question the owner
  // clicked; a sentence only names a product. When the caller genuinely knows,
  // nothing is matched by string at all.
  const byKey = input.answer.dedupeKey
    ? open.filter((q) => q.dedupeKey === input.answer.dedupeKey)
    : null;

  const named = input.answer.productName?.trim().toLowerCase() ?? "";
  const matched =
    byKey ??
    (named
      ? open.filter(
          (q) =>
            q.productName.toLowerCase() === named ||
            q.productName.toLowerCase().includes(named) ||
            named.includes(q.productName.toLowerCase())
        )
      : open);

  // ONE QUESTION, OR NONE. An answer that could belong to two products is not
  // an answer to either, and picking the likelier one would put a supplier's
  // terms on the wrong product silently.
  if (matched.length !== 1) {
    const names = open.map((q) => `"${q.productName}"`).join(" or ");
    return {
      status: "unresolved",
      reply:
        matched.length === 0
          ? `I'm not sure which product you mean — I'm waiting on supplier figures for ${names}. Which one is that for?`
          : `That could be ${names} — which one did they quote you on?`,
    };
  }

  const question = matched[0];

  // THE IDENTITY COMES FROM THE QUESTION, never from the reply. Everything the
  // model said about which product this is has already been reduced to "which
  // of the questions we asked", above.
  const actionInput: AnswerSupplierEconomicsInput = {
    sourceKey: question.sourceKey,
    externalProductId: question.externalProductId,
    externalVariantId: question.externalVariantId,
    answer: input.answer.answer,
  };

  const run =
    input.runAction ??
    ((actual: AnswerSupplierEconomicsInput) =>
      execute(answerSupplierEconomicsExecutable, actual, {
        storeId: input.storeId,
        actorType: "USER",
        actionType: "answer_supplier_economics",
      }));

  const outcome = await run(actionInput);

  // execute() returns a FAILED result rather than throwing. Reporting success
  // here would tell an owner their supplier's terms are on file when they are
  // not, and the next thing they would see is J4 asking the same question again.
  if (outcome.status === "FAILED") {
    return {
      status: "unresolved",
      reply: `I couldn't record that just then, so nothing's changed. Tell me again in a moment and I'll get it down.`,
    };
  }

  const result = outcome.metadata?.result;
  if (!result) {
    return {
      status: "unresolved",
      reply: `I recorded that, but I can't tell you what it changed just now — ask me about ${question.productName} and I'll take another look.`,
    };
  }

  return { status: "applied", question, result, reply: replyFor(question, result) };
}
