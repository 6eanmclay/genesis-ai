import { prisma } from "@/lib/prisma";
import type { GenesisActionType } from "@/lib/execution/genesisActions";

// Progressive storefront improvement, passes 2 and 3 (2026-08-12) — the
// frequency governor and the suggestion memory.
//
// Sean's framing, and the reason this is code rather than prompt text:
// "The goal is to make 'occasionally' and 'J4 remembers what I rejected'
// actual product behavior, not something we merely ask the model to do in a
// prompt." A model asked to be restrained is restrained on average; a store
// that has already been told no is a fact, and facts belong in a query.
//
// This governs ONLY J4's own initiative. A storefront change the owner asks
// for in chat runs through a completely different path (the chat action
// pipeline in app/dashboard/ai-actions.ts) and is deliberately never gated
// here — being asked is not the same as volunteering, and throttling a
// direct request would be a bug, not restraint.

// Which proposals count as "a storefront improvement" for governing
// purposes. Deliberately the visual/structural surface an owner would
// recognise as "you changed how my store looks," not everything that happens
// to touch a store row.
//
// Excluded on purpose: update_seo (discoverability, not design — and it is
// cheap, specific, and genuinely worth raising when it is empty),
// update_product_image and create_product (product-level work the owner is
// usually mid-flow on), and update_marketing_assets (campaign content, a
// different conversation entirely). Governing those would suppress useful,
// unrelated help under a rule written for redesigns.
export const STOREFRONT_SUGGESTION_ACTION_TYPES: ReadonlySet<GenesisActionType> = new Set<GenesisActionType>([
  "update_theme",
  "update_design_direction",
  "update_brand_identity",
  "update_hero",
  "update_homepage_content",
  "update_section_order",
  "update_store_content",
  "update_store_identity",
]);

// Seven days. Long enough that a storefront suggestion reads as J4 having
// noticed something rather than as a recurring prompt, and comfortably longer
// than the review sweep's own cadence — so the governor, not the sweep
// frequency, is what decides how often the owner hears about their storefront.
export const STOREFRONT_SUGGESTION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export type StorefrontSuggestionDecision =
  | { allowed: true }
  | { allowed: false; reason: "cooldown" | "previously_rejected" | "owner_preference"; detail: string };

// Whether J4 may raise this specific unprompted storefront proposal right
// now. Three independent reasons to stay quiet, checked cheapest-first.
export async function canSuggestStorefrontImprovement({
  storeId,
  actionType,
  topicKey,
  now = new Date(),
}: {
  storeId: string;
  actionType: GenesisActionType;
  topicKey: string | null | undefined;
  now?: Date;
}): Promise<StorefrontSuggestionDecision> {
  // Not a storefront-improvement proposal at all — nothing to govern. Every
  // other kind of proposal J4 makes is unaffected by this file.
  if (!STOREFRONT_SUGGESTION_ACTION_TYPES.has(actionType)) return { allowed: true };

  // 1. The frequency governor. One in-flight window per store, regardless of
  //    which dimension the idea is about — the owner experiences "J4 keeps
  //    wanting to redesign my store" as one behaviour, not as eight separate
  //    ones, so the cooldown is per store rather than per action type.
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { lastStorefrontSuggestionAt: true },
  });
  const last = store?.lastStorefrontSuggestionAt;
  if (last) {
    const elapsed = now.getTime() - last.getTime();
    if (elapsed < STOREFRONT_SUGGESTION_COOLDOWN_MS) {
      const daysLeft = Math.ceil((STOREFRONT_SUGGESTION_COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
      return {
        allowed: false,
        reason: "cooldown",
        detail: `Last storefront suggestion was ${Math.floor(elapsed / (24 * 60 * 60 * 1000))}d ago; ${daysLeft}d of cooldown remain.`,
      };
    }
  }

  // Everything below is memory, and memory needs a stable identity for the
  // idea. Without a topicKey there is nothing to match a past decision
  // against, so the cooldown above is the only protection available.
  if (!topicKey) return { allowed: true };

  // 2. The owner already said no to this exact idea. topicKey is the same
  //    stable identity ApprovalRequest and CognitiveOutput already use — the
  //    underlying pattern, independent of exact wording — so a re-worded
  //    version of a rejected idea is still recognised as the same idea.
  const rejected = await prisma.approvalRequest.findFirst({
    where: { storeId, topicKey, status: "REJECTED" },
    orderBy: { decidedAt: "desc" },
    select: { decidedAt: true },
  });
  if (rejected) {
    return {
      allowed: false,
      reason: "previously_rejected",
      detail: `Owner rejected this same topicKey${
        rejected.decidedAt ? ` on ${rejected.decidedAt.toISOString().slice(0, 10)}` : ""
      }.`,
    };
  }

  // 3. A learned preference about this topic. lib/intelligence/learn.ts
  //    already mines rejected proposals into Belief rows categorised
  //    "owner_preference" — this reads what that layer writes, so a
  //    preference learned from repeated declines suppresses the suggestion
  //    even after the individual ApprovalRequest rows are long gone.
  const preference = await prisma.belief.findFirst({
    where: { storeId, topicKey, category: "owner_preference" },
    select: { claim: true, confidence: true },
  });
  if (preference) {
    return {
      allowed: false,
      reason: "owner_preference",
      detail: `Learned preference (confidence ${preference.confidence.toFixed(2)}): ${preference.claim}`,
    };
  }

  return { allowed: true };
}

// Stamps the governor. Called only once a storefront proposal has genuinely
// been created — never on the attempt, so a proposal suppressed by any of the
// checks above does not silently start the owner's cooldown for them.
export async function recordStorefrontSuggestionMade(storeId: string, now = new Date()): Promise<void> {
  await prisma.store.update({
    where: { id: storeId },
    data: { lastStorefrontSuggestionAt: now },
  });
}
