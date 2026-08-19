// Business Intelligence Engine M2 (2026-08-18) — the canonical topic-key
// derivation.
//
// ONE function, used by both the backfill and every new proposal, so a decision
// made last January and a decision made tomorrow enter the belief system under
// the same name. Two derivations would be two vocabularies, and a belief formed
// across them would be counting things that only look alike.
//
// DETERMINISTIC. No AI call, no inference, no text parsing of summaries — only
// `actionType` and the already-recorded `input`. A model asked to classify a
// historical decision would be inventing information about the past, which is
// exactly what a backfill must never do.
//
// READABLE ON PURPOSE. learn.ts renders a topicKey verbatim into a belief the
// owner reads: `The owner has declined proposals about "product_image_replacement"
// 2 time(s)`. So these are short human-legible slugs in the same
// lowercase_snake_case convention the model's own topic keys already use
// ("declining_repeat_purchases", "marketing_assets_missing") — never a
// structural identifier like "action:update_product", which would surface to the
// owner as a database row read aloud.
//
// NULL IS A REAL ANSWER. Where the mapping is ambiguous the derivation returns
// null and the row keeps no topic key at all. Sean's rule: "Do not backfill
// decisions where the mapping is ambiguous. Leave those null rather than
// guessing." A wrong key is worse than no key — it merges unrelated decisions
// into one false pattern, and beliefs are built by counting.

/**
 * Action types with exactly one honest name, independent of their input.
 *
 * Keyed by the KIND OF ASK rather than by the record acted on. Two declines
 * about different products are real evidence about the kind of suggestion the
 * owner doesn't want; a per-product key would almost never reach a threshold of
 * two, and the belief it eventually formed would be about one item rather than
 * about the owner.
 */
const SINGLE_MEANING_KEYS: Readonly<Record<string, string>> = {
  update_product_image: "product_image_replacement",
  create_product: "new_product",
  create_product_from_design: "new_product_from_design",
  delete_product: "product_removal",
  update_seo: "storefront_seo",
  update_hero: "storefront_hero",
  update_theme: "storefront_theme",
  update_homepage_content: "storefront_homepage_content",
  update_section_order: "storefront_section_order",
  refine_storefront: "storefront_refinement",
  update_brand_logo: "brand_logo",
  update_brand_identity: "brand_identity",
  update_store_identity: "store_identity",
  update_store_content: "store_policy_content",
  update_design_direction: "design_direction",
  update_marketing_assets: "marketing_assets",
};

/**
 * Action types that deliberately derive nothing.
 *
 * Not oversights — bookkeeping and record-keeping actions. "The owner has
 * declined proposals about goal_status" would be a preference nobody ever
 * expressed, and Learn counts whatever it is given.
 */
const NO_TOPIC_KEY: ReadonlySet<string> = new Set([
  "update_goal_status",
  "resolve_challenge",
  "communicate_finding",
]);

/** The content fields update_product can actually change (genesisActions.ts). */
const PRODUCT_CONTENT_FIELDS = ["name", "description"] as const;

function changedProductFields(input: Record<string, unknown>): string[] {
  return PRODUCT_CONTENT_FIELDS.filter((field) => field in input);
}

/**
 * The canonical topic key for a proposal, or null when no honest name exists.
 *
 * @param actionType the ApprovalRequest's own actionType
 * @param input      the ApprovalRequest's own recorded input
 */
export function deriveTopicKey(actionType: string, input: unknown): string | null {
  if (NO_TOPIC_KEY.has(actionType)) return null;

  const single = SINGLE_MEANING_KEYS[actionType];
  if (single) return single;

  // update_product is the one action whose meaning genuinely depends on what
  // is being changed — a name change and a description rewrite are different
  // asks, and an owner can reasonably welcome one and decline the other.
  if (actionType === "update_product") {
    const record = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
    if (!record) return null;

    const changed = changedProductFields(record);
    if (changed.length === 0) return null; // productId only — nothing was proposed
    if (changed.length === PRODUCT_CONTENT_FIELDS.length) return "product_content_rewrite";
    return changed[0] === "name" ? "product_name_change" : "product_description_rewrite";
  }

  // An action type nobody has mapped yet. Deliberately null rather than a
  // generated fallback: an unrecognised action is exactly the ambiguous case.
  return null;
}

export interface BackfillCandidate {
  id: string;
  actionType: string;
  input: unknown;
  topicKey: string | null;
}

export interface BackfillUpdate {
  id: string;
  topicKey: string;
}

/**
 * The backfill plan — the pure decision, separated from the writing.
 *
 * Emits ONLY an id and the topic key to add. There is no shape here that could
 * carry a summary, a timestamp, a decision, an actor or a provenance field, so
 * "the backfill only adds the missing topicKey" is guaranteed by the type
 * rather than promised by a comment.
 *
 * Rows that already have a topic key are never touched, so a re-run cannot
 * rewrite a key the model authored, and running the backfill twice is a no-op.
 */
export function planTopicKeyBackfill(rows: BackfillCandidate[]): BackfillUpdate[] {
  const updates: BackfillUpdate[] = [];
  for (const row of rows) {
    if (row.topicKey !== null) continue;
    const derived = deriveTopicKey(row.actionType, row.input);
    if (derived === null) continue; // ambiguous — left exactly as it is
    updates.push({ id: row.id, topicKey: derived });
  }
  return updates;
}
