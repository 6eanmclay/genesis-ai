import type { Executable } from "../executable";
import { verified, type VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import type { EconomicsFact } from "@/lib/sourcing/economics";
import {
  answerEconomicsQuestion,
  settleEconomicsQuestion,
  type AnswerResult,
  type EconomicsAnswer,
} from "@/lib/sourcing/economicsAnswer";

// THE OWNER'S ANSWER, AS A REAL EXECUTION.
//
// Routed through the engine rather than written straight to the table, because
// this is a mutation on somebody's business made on somebody's behalf, and the
// engine is where those get a permission check, an ExecutionLog row and an
// actor. A supplier's terms decide whether Genesis tells a person to spend
// thousands of pounds; "who told us this, and when" has to be answerable
// afterwards, and `statedByUserId` alone would only ever name the last writer.
//
// TIERED always_ask AND LOCKED THERE. Every other action in the registry is
// something Genesis could in principle do for the owner. This one is not: it is
// a fact only they can obtain, from a conversation only they can have. An
// autonomous tier here would not be a convenience, it would be Genesis filling
// in a number about somebody's money — the exact thing the whole economics layer
// exists to make impossible.

export interface AnswerSupplierEconomicsInput {
  /** All four identity parts, so an answer can never land on another supplier's product. */
  sourceKey: string;
  externalProductId: string;
  externalVariantId?: string | null;

  answer: EconomicsAnswer;
}

export interface AnswerSupplierEconomicsMetadata {
  result: AnswerResult;
}

/** What the owner reads back, which must never overstate what was learned. */
function describe(result: AnswerResult): string {
  if (result.recorded === null) {
    return "Noted — I haven't written anything down, so I'll keep this one open until you find out.";
  }
  if (result.recorded.status === "rejected") {
    return `I couldn't record that: ${result.recorded.problem}`;
  }
  if (result.recorded.status === "preserved") {
    return `I've left what you told me before in place — ${result.recorded.reason}`;
  }

  if (result.changes.includes("supplier_refused")) {
    return "Recorded that they wouldn't quote you. I'll stop asking for a while, and suggest looking elsewhere instead.";
  }
  if (!result.reevaluated) {
    return "That matches what I already had, so nothing's changed — but thanks for confirming it.";
  }
  if (result.question === "narrowed") {
    return "Got it. That's half of what I need — I'll ask about the rest.";
  }
  return result.nowRecommends
    ? `Got it. That changes things: ${result.nowRecommends}`
    : "Got it — I've updated what I know about this product.";
}

export const answerSupplierEconomicsExecutable: Executable<
  AnswerSupplierEconomicsInput,
  AnswerSupplierEconomicsMetadata
> = {
  action: "answer_supplier_economics",
  // PRODUCTS_MANAGE, not PAYMENTS_MANAGE. This changes what Genesis believes a
  // product costs — a fact about the catalogue — and an employee who rings the
  // supplier is exactly the person likely to have the answer. It moves no money
  // and reaches no payment provider.
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,

  async run(input, ctx) {
    const ref = {
      sourceKey: input.sourceKey,
      externalProductId: input.externalProductId,
      externalVariantId: input.externalVariantId ?? null,
    };

    const result = await answerEconomicsQuestion({
      storeId: ctx.storeId,
      ref,
      answer: input.answer,
      userId: ctx.userId,
    });

    // The card is settled from the RESULT, never from the fact that somebody
    // replied. A question is only closed when what it asked for is actually
    // known — an owner who says "I don't know yet" has replied and answered
    // nothing, and the card has to survive that.
    await settleEconomicsQuestion(ctx.storeId, ref, result);

    return { message: describe(result), metadata: { result } };
  },

  /**
   * Did the fact actually land?
   *
   * Worth an independent check rather than trusting the write, because the two
   * outcomes that write nothing — a refused quote and a preserved owner
   * statement — are indistinguishable from success at the call site unless
   * somebody looks. A `dont_know_yet` verifies as fine having written nothing,
   * which is exactly what it promised to do.
   */
  async verify(input, ctx) {
    // "I don't know yet" records no economics, so there is nothing to read
    // back and nothing that could have failed to land.
    if (input.answer.kind === "dont_know_yet") return verified();

    const { supplierEconomics } = await import("@/lib/sourcing/economics");
    const stated = await supplierEconomics(ctx.storeId, {
      sourceKey: input.sourceKey,
      externalProductId: input.externalProductId,
      externalVariantId: input.externalVariantId ?? null,
    });

    if (!stated) return { state: "failed", mismatches: ["nothing was recorded for that product"] };

    // PER FACT, because the write is. An owner who gave only the minimum has
    // stated one thing, and demanding that the price also carry their name would
    // fail a write that did exactly what it promised.
    const expected = input.answer.kind === "supplier_would_not_say" ? "UNAVAILABLE" : "OWNER";
    const facts: EconomicsFact[] =
      input.answer.kind === "supplier_would_not_say"
        ? ["minimumOrder", "unitCost"]
        : [
            ...(input.answer.minimumOrderUnits !== null && input.answer.minimumOrderUnits !== undefined
              ? (["minimumOrder"] as EconomicsFact[])
              : []),
            ...(input.answer.bulkUnitCostInCents !== null && input.answer.bulkUnitCostInCents !== undefined
              ? (["unitCost"] as EconomicsFact[])
              : []),
          ];

    // A refusal that found an owner's figure already on file is preserved rather
    // than applied, which is correct and is not a failed write.
    const landed = facts.filter((fact) => stated.attribution[fact].provenance === expected);
    const kept = facts.filter((fact) => stated.attribution[fact].provenance === "OWNER");
    if (landed.length === 0 && kept.length === 0) {
      return { state: "failed", mismatches: [`nothing was recorded as ${expected}`] };
    }
    return verified();
  },
};
