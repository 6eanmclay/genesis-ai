import { prisma } from "@/lib/prisma";
import {
  bulkTerms,
  gapsInTerms,
  supplierEconomics,
  type EconomicsGap,
  type SupplierProductRef,
  type SupplierTerms,
} from "./economics";
import { recordOwnerQuote, recordUnavailable, type IngestOutcome } from "./economicsIngest";
import { economicsDedupeKey, ECONOMICS_TASK_SOURCE } from "./economicsQuestions";
import { findGraduationOpportunities } from "./graduation";
import { nextMoves } from "./nextMoves";

// THE OWNER ANSWERS, AND SOMETHING CHANGES.
//
// The last link. J4 asks (economicsQuestions.ts), the owner replies, and this is
// what turns the reply into a fact and works out whether the fact was worth
// anything.
//
// THREE ANSWERS, AND ONE OF THEM WRITES NOTHING.
//
//   quoted                 — they asked and were told. -> recordOwnerQuote
//   supplier_would_not_say — they asked and were refused. -> recordUnavailable
//   dont_know_yet          — they have not found out. -> NOTHING IS WRITTEN.
//
// The third is the one that matters and the one a system like this usually gets
// wrong. "I don't know" is not an answer about the supplier, it is the absence
// of one, and there is nowhere honest to put it: recording UNAVAILABLE would be
// Genesis claiming somebody asked and was refused, which is a different fact and
// a false one. So the question stays open, nothing is written, and the owner is
// not asked to repeat themselves — they were the one who said they'd find out.
//
// RE-EVALUATION IS EARNED, NOT AUTOMATIC. An answer that restates what Genesis
// already knew moves nothing, and rerunning the whole progression to arrive at
// the same three moves would be work with a result nobody can tell apart from no
// work at all. What counts as material reuses the vocabulary `materialChange`
// already established for reconsidering a declined graduation, so "worth acting
// on" means the same thing in both places.

export type EconomicsAnswer =
  | {
      kind: "quoted";
      /** Either may be absent. Both absent is not a quote and is rejected. */
      minimumOrderUnits?: number | null;
      bulkUnitCostInCents?: number | null;
      shippingPerUnitInCents?: number | null;
      leadTimeDays?: number | null;
      note?: string | null;
    }
  | { kind: "supplier_would_not_say"; note?: string | null }
  | { kind: "dont_know_yet"; note?: string | null };

/** What moved, in the same words `materialChange` uses for a declined decision. */
export type EconomicChange =
  | "minimum_order_became_known"
  | "minimum_order_lowered"
  | "bulk_price_became_known"
  | "supplier_price_dropped"
  | "shipping_became_known"
  | "lead_time_became_known"
  | "price_breaks_became_usable"
  | "supplier_refused";

export interface AnswerResult {
  /** What was written, if anything. Null for `dont_know_yet`. */
  recorded: IngestOutcome | null;
  /** Empty when nothing economically material moved. */
  changes: EconomicChange[];
  /**
   * Whether the progression was recomputed.
   *
   * False is a real, common outcome: an owner confirming the figures Genesis
   * already had has told us something useful about our data and nothing new
   * about their business.
   */
  reevaluated: boolean;
  /** The question's own state afterwards. */
  question: "closed" | "still_open" | "narrowed";
  /**
   * What Genesis STILL does not know about this product.
   *
   * Carried on the result rather than recomputed by whoever reports back,
   * because a reply that says what was learned without saying what is still
   * missing is the half of the truth that sounds like all of it.
   */
  stillMissing: EconomicsGap[];
  /** Present only when `reevaluated`. What the owner would now be told. */
  nowRecommends: string | null;
}

/**
 * Everything that would change a decision, compared before and after.
 *
 * BECOMING KNOWN COUNTS AS MUCH AS IMPROVING, which is the same rule
 * `materialChange` applies: an unknown blocked the recommendation outright, so
 * learning it is the change, even when the number turns out to be worse than
 * anybody hoped.
 */
export function economicChanges(before: SupplierTerms, after: SupplierTerms): EconomicChange[] {
  const changes: EconomicChange[] = [];

  if (after.minimumOrderUnits !== null) {
    if (before.minimumOrderUnits === null) changes.push("minimum_order_became_known");
    else if (after.minimumOrderUnits < before.minimumOrderUnits) changes.push("minimum_order_lowered");
  }
  if (after.bulkUnitCostInCents !== null) {
    if (before.bulkUnitCostInCents === null) changes.push("bulk_price_became_known");
    else if (after.bulkUnitCostInCents < before.bulkUnitCostInCents) changes.push("supplier_price_dropped");
  }
  if (before.shippingPerUnitInCents === null && after.shippingPerUnitInCents !== null) {
    changes.push("shipping_became_known");
  }
  if (before.leadTimeDays === null && after.leadTimeDays !== null) {
    changes.push("lead_time_became_known");
  }
  if (!before.integrity.ok && after.integrity.ok) {
    changes.push("price_breaks_became_usable");
  }
  // A refusal is material in the other direction: it is the difference between
  // "nobody has asked" and "we asked and there is no answer", and it changes
  // what J4 says next from a question into a suggestion to look elsewhere.
  if (before.provenance !== "UNAVAILABLE" && after.provenance === "UNAVAILABLE") {
    changes.push("supplier_refused");
  }

  return changes;
}

/**
 * Apply an owner's answer, and re-evaluate only if it earned that.
 *
 * The one place the whole loop closes. Everything it writes goes through
 * `recordOwnerQuote` / `recordUnavailable`, so provenance stays OWNER and
 * UNAVAILABLE respectively and nothing here invents a value or a second way to
 * store one.
 */
export async function answerEconomicsQuestion(input: {
  storeId: string;
  ref: SupplierProductRef;
  answer: EconomicsAnswer;
  userId?: string | null;
  now?: Date;
}): Promise<AnswerResult> {
  const { storeId, ref, answer } = input;

  const before = bulkTerms(await supplierEconomics(storeId, ref, { now: input.now }));

  // --- "I haven't found out yet" ------------------------------------------
  //
  // Deliberately a real branch rather than the absence of a call. Modelling it
  // means there is somewhere to test that nothing is written, and somewhere for
  // a future screen to send a reply that is honestly empty.
  if (answer.kind === "dont_know_yet") {
    return {
      recorded: null,
      changes: [],
      reevaluated: false,
      question: "still_open",
      // Unchanged, because nothing was written. Whatever was missing before
      // this reply is exactly what is missing after it.
      stillMissing: gapsInTerms(before),
      nowRecommends: null,
    };
  }

  const recorded =
    answer.kind === "supplier_would_not_say"
      ? await recordUnavailable({
          storeId, ref, userId: input.userId ?? null, note: answer.note ?? null, now: input.now,
        })
      : await recordOwnerQuote({
          storeId,
          ref,
          minimumOrderUnits: answer.minimumOrderUnits ?? null,
          bulkUnitCostInCents: answer.bulkUnitCostInCents ?? null,
          shippingPerUnitInCents: answer.shippingPerUnitInCents ?? null,
          leadTimeDays: answer.leadTimeDays ?? null,
          userId: input.userId ?? null,
          note: answer.note ?? null,
          now: input.now,
        });

  // A refused or preserved write changed nothing, so nothing downstream of it
  // ran. The outcome is returned rather than swallowed: a caller that asked to
  // record something and did not needs to know which.
  if (recorded.status !== "recorded") {
    return {
      recorded,
      changes: [],
      reevaluated: false,
      question: "still_open",
      stillMissing: gapsInTerms(before),
      nowRecommends: null,
    };
  }

  const after = bulkTerms(await supplierEconomics(storeId, ref, { now: input.now }));
  const changes = economicChanges(before, after);

  if (changes.length === 0) {
    // The owner confirmed what Genesis already had. Real information about our
    // data, no information about their business.
    return {
      recorded,
      changes,
      reevaluated: false,
      question: after.minimumOrderUnits !== null && after.bulkUnitCostInCents !== null ? "closed" : "still_open",
      stillMissing: gapsInTerms(after),
      nowRecommends: null,
    };
  }

  // --- something material moved, so recompute ------------------------------
  //
  // findGraduationOpportunities is called for its own reconsideration bookkeeping
  // against any decision this product already has; nextMoves is what the owner
  // would actually read.
  await findGraduationOpportunities(storeId);
  const moves = await nextMoves(storeId);
  const productId = await productIdFor(storeId, ref);
  const forThisProduct = moves.moves.find(
    (move) => move.productId !== null && move.productId === productId
  );

  const incomplete = after.minimumOrderUnits === null || after.bulkUnitCostInCents === null;

  return {
    recorded,
    changes,
    reevaluated: true,
    question: answer.kind === "supplier_would_not_say" ? "still_open" : incomplete ? "narrowed" : "closed",
    stillMissing: gapsInTerms(after),
    nowRecommends: forThisProduct?.recommendation ?? moves.moves[0]?.recommendation ?? null,
  };
}

/** Which owned product this supplier listing became, if any. */
async function productIdFor(storeId: string, ref: SupplierProductRef): Promise<string | null> {
  const adopted = await prisma.sourcedProduct.findFirst({
    where: {
      storeId,
      sourceKey: ref.sourceKey,
      externalProductId: ref.externalProductId,
      externalVariantId: ref.externalVariantId ?? "",
      NOT: { adoptedProductId: null },
    },
    select: { adoptedProductId: true },
  });
  if (adopted?.adoptedProductId) return adopted.adoptedProductId;

  const direct = await prisma.product.findFirst({
    where: {
      storeId,
      sourceKey: ref.sourceKey,
      externalProductId: ref.externalProductId,
    },
    select: { id: true },
  });
  return direct?.id ?? null;
}

/**
 * Mark the question answered, or leave it standing.
 *
 * Separated from the write above so the decision about the CARD is visibly
 * downstream of the decision about the FACT. A question is only closed when the
 * thing it asked for is actually known — never because somebody replied.
 */
export async function settleEconomicsQuestion(
  storeId: string,
  ref: SupplierProductRef,
  result: AnswerResult
): Promise<void> {
  const dedupeKey = economicsDedupeKey(ref);

  if (result.question === "closed") {
    await prisma.task.updateMany({
      where: { storeId, source: ECONOMICS_TASK_SOURCE, dedupeKey, status: { notIn: ["COMPLETED", "DISMISSED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    return;
  }

  // Still outstanding. `raiseEconomicsQuestions` will re-word it to ask for
  // whatever half remains the next time it runs — the card is not rewritten
  // here, because what is missing is derived from the data and deriving it
  // twice is how two answers to the same question start to disagree.
}
