import { prisma } from "@/lib/prisma";
import { upsertTask, resolveStaleTasks } from "@/lib/dashboard/tasks";
import { missingEconomics, supplierEconomics, ECONOMICS_GAP_EXPLANATION, type EconomicsGap } from "./economics";
import { nextMoves } from "./nextMoves";
import { toVariantKey } from "./types";

// THE QUESTION J4 ACTUALLY ASKS, AND WHERE IT LIVES.
//
// `nextMoves` has been able to produce an unblock — "I can't tell you whether
// this is worth buying properly until I know what it costs in bulk" — since the
// economics layer landed. Nothing carried that question anywhere an owner could
// answer it, so in production it was a sentence with no destination.
//
// This turns it into a Task. NOT A NEW MECHANISM: Task is where every other
// thing Genesis needs from an owner already lives, `requiredInput` and the
// AWAITING_INPUT status were declared in the schema for exactly this and used by
// nothing, and `upsertTask` already has the identity, reopening and race
// behaviour that took two attempts to get right. A second table for "questions
// about suppliers" would be a parallel inbox nobody merges.
//
// ONE QUESTION PER BLOCKED PRODUCT, and only the half that is missing. An owner
// who already told us the minimum is asked about the price, not about both — see
// `missingEconomics`, which is the same function the unblock move uses, so the
// card and the conversation can never disagree about what is outstanding.

/** Every economics question shares this prefix, so the sweep can find its own. */
export const ECONOMICS_TASK_SOURCE = "supplier_economics";

export interface EconomicsQuestion {
  dedupeKey: string;
  productId: string;
  productName: string;
  sourceKey: string;
  externalProductId: string;
  externalVariantId: string | null;
  gaps: EconomicsGap[];
}

/**
 * The identity of a question.
 *
 * All four parts of the product's identity, for the same reason the table's
 * unique key is: two suppliers can use the same external id, and a question
 * about one must never be answered by a reply about the other.
 */
export function economicsDedupeKey(ref: {
  sourceKey: string;
  externalProductId: string;
  externalVariantId: string | null;
}): string {
  return `${ECONOMICS_TASK_SOURCE}.${ref.sourceKey}:${ref.externalProductId}:${toVariantKey(ref.externalVariantId)}`;
}

/**
 * What Genesis would need to know, phrased as something a person can act on.
 *
 * The summary is the WHY. "I don't know the minimum order" is a fact about
 * Genesis; "it decides what buying in bulk would actually cost you up front" is
 * a reason to pick up the phone, and it is the only part of this that makes the
 * card worth showing.
 */
function questionText(productName: string, gaps: EconomicsGap[]): { title: string; summary: string } {
  if (gaps.includes("unusable_tiers")) {
    return {
      title: `Check the price breaks for ${productName}`,
      summary:
        `The price breaks I have recorded for ${productName} don't add up, so I've stopped using them rather than ` +
        `quote you a figure I can't stand behind. What does your supplier actually charge, and how many do you have to order?`,
    };
  }

  const onlyMinimum = gaps.length === 1 && gaps[0] === "minimum_order";
  const onlyPrice = gaps.length === 1 && gaps[0] === "bulk_price";

  if (onlyMinimum) {
    return {
      title: `How many ${productName} do you have to order at once?`,
      summary:
        `I know what your supplier charges per unit, but not ${ECONOMICS_GAP_EXPLANATION.minimum_order}.`,
    };
  }
  if (onlyPrice) {
    return {
      title: `What does ${productName} cost you in bulk?`,
      summary:
        `I know how many you'd have to order, but not ${ECONOMICS_GAP_EXPLANATION.bulk_price}.`,
    };
  }

  return {
    title: `What would ${productName} cost you to buy in bulk?`,
    summary:
      `Two things, and I need them before I can tell you whether owning this outright is worth it: ` +
      `${ECONOMICS_GAP_EXPLANATION.minimum_order}, and ${ECONOMICS_GAP_EXPLANATION.bulk_price}.`,
  };
}

/**
 * Raise a question for every product whose progression is blocked on economics,
 * and retire the ones that are not blocked any more.
 *
 * Reads `nextMoves` rather than the database directly, deliberately. The
 * decision about whether something is blocked, and how much that block is worth
 * resolving, is already made — asking again here would be a second opinion that
 * could disagree with the one the owner is looking at.
 */
export async function raiseEconomicsQuestions(storeId: string): Promise<EconomicsQuestion[]> {
  const { moves } = await nextMoves(storeId);

  const questions: EconomicsQuestion[] = [];

  for (const move of moves) {
    if (move.kind !== "unblock" || move.productId === null) continue;

    const product = await prisma.product.findFirst({
      where: { id: move.productId, storeId },
      select: { id: true, name: true, sourceKey: true, externalProductId: true, externalVariantId: true },
    });
    // The identity has to be complete to be answerable. A product with no source
    // recorded has no supplier to ring, and a card asking somebody to find out
    // what an unknown supplier charges is a card nobody can act on.
    if (!product?.sourceKey || !product.externalProductId) continue;

    const adopted = await prisma.sourcedProduct.findFirst({
      where: { storeId, adoptedProductId: product.id },
      select: { sourceKey: true, externalProductId: true, externalVariantId: true },
    });
    const ref = adopted
      ? {
          sourceKey: adopted.sourceKey,
          externalProductId: adopted.externalProductId,
          externalVariantId: adopted.externalVariantId === "" ? null : adopted.externalVariantId,
        }
      : {
          sourceKey: product.sourceKey,
          externalProductId: product.externalProductId,
          externalVariantId: product.externalVariantId,
        };

    const gaps = missingEconomics(await supplierEconomics(storeId, ref));
    if (gaps.length === 0) continue;

    questions.push({
      dedupeKey: economicsDedupeKey(ref),
      productId: product.id,
      productName: product.name,
      ...ref,
      gaps,
    });
  }

  for (const question of questions) {
    const { title, summary } = questionText(question.productName, question.gaps);
    await upsertTask(storeId, {
      dedupeKey: question.dedupeKey,
      source: ECONOMICS_TASK_SOURCE,
      relatedRecordId: question.productId,
      relatedEntityType: "product",
      title,
      summary,
      // The snapshot is the identity plus what is outstanding — enough for the
      // answer to be applied to the right supplier's product without trusting
      // anything the reply itself claims about which product it is about.
      context: {
        productId: question.productId,
        sourceKey: question.sourceKey,
        externalProductId: question.externalProductId,
        externalVariantId: question.externalVariantId,
        gaps: question.gaps,
      },
      // WHAT IS STILL OUTSTANDING, in the field the schema declared for it and
      // nothing had ever written. Separate from `context` because it is the part
      // that changes: an owner who answers half the question gets a card asking
      // for the other half, not the same card again.
      requiredInput: {
        gaps: question.gaps,
        asks: question.gaps.map((gap) => ECONOMICS_GAP_EXPLANATION[gap]),
      },
      actionType: "answer_supplier_economics",
      // The owner is the only source. J4 cannot look this up, cannot infer it,
      // and must never fill it in — which is what `always_approve` would quietly
      // permit. `recommend` is the honest tier for a question.
      trustLevel: "recommend",
      priority: "opportunity",
    });
  }

  // A question whose gap has closed stops being asked. Scoped to this source, so
  // it can never retire somebody else's task.
  await resolveStaleTasks(storeId, ECONOMICS_TASK_SOURCE, questions.map((q) => q.dedupeKey));

  return questions;
}
