import { prisma } from "@/lib/prisma";
import { evaluateStorefront, type StorefrontEvaluation } from "@/lib/storefront/evaluate";
import {
  canSuggestStorefrontImprovement,
  recordStorefrontSuggestionMade,
  type StorefrontSuggestionDecision,
} from "@/lib/dashboard/storefrontSuggestionGate";
import { deriveTopicKey } from "./topicKeys";
import type { Insight } from "./insights";
import type { GenesisActionType } from "@/lib/execution/genesisActions";

// Business Intelligence Engine M4 (2026-08-18) — the continuous engine notices
// what J4 already knows how to see.
//
// evaluateStorefront has existed since the P2/P3 website-intelligence work and
// reads only first-party data: products and assets, no connector, no sales. It
// had exactly one caller — the chat handler, when the owner asked. So J4 could
// form a real opinion about the store, but only if invited to.
//
// Meanwhile M1 and M3 made the cycle actually run for a store with no
// connectors, and it had almost nothing to say: of five insight detectors, four
// read connector-only data and the fifth needs two weeks of sales. A
// pre-revenue store got a working engine and silence.
//
// THIS ADDS NO NEW CAPABILITY. It gives an existing one a second caller.
// evaluateStorefront is untouched, the suggestion gate is untouched, the
// notification path is untouched — an insight raised here becomes an ambient
// GenesisObservation through the same notifyFromInsights every other insight
// uses. There is no second notification system, because there is no new
// notification code at all.
//
// GROUNDED, NEVER INFERRED. Sean's rule for pre-revenue stores: J4 may name a
// real storefront problem with no sales data, and must never infer sales
// performance from its absence. Every string this produces is either counted
// from real rows or quoted verbatim from evaluateStorefront's own reading, and
// nothing here reads an order, a transaction or a revenue figure.

export const STOREFRONT_READINESS_INSIGHT_TYPE = "storefront.readiness";

/** The observation key this insight becomes, via notify.ts's own prefix. */
export const STOREFRONT_READINESS_DEDUPE_KEY = `insight:${STOREFRONT_READINESS_INSIGHT_TYPE}`;

/**
 * Which action each finding is really about, and therefore which governance
 * applies to it.
 *
 * This is the honest part rather than a formality. The suggestion gate governs
 * the visual/structural surface an owner recognises as "you changed how my
 * store looks", and DELIBERATELY excludes product-level work — its own comment:
 * "product-level work the owner is usually mid-flow on... Governing those would
 * suppress useful, unrelated help under a rule written for redesigns."
 *
 * So `products_missing_photos` maps to update_product_image, which is not in
 * the governed set, and the gate correctly declines to throttle it. Forcing it
 * under a redesign cooldown to make the mapping tidy would break the gate's own
 * stated intent.
 */
const FINDING_ACTIONS: Readonly<Record<string, GenesisActionType>> = {
  no_hero_composition: "update_hero",
  editorial_imagery_unused: "update_homepage_content",
  products_could_be_grouped: "update_section_order",
  no_logo: "update_brand_identity",
  products_missing_photos: "update_product_image",
};

/**
 * Which finding speaks first when several are true.
 *
 * Deliberate, not evaluateStorefront's authoring order: something that makes
 * the store look broken outranks something that would make it look better. A
 * blank product card is visible to every visitor today; an uncomposed hero is
 * an improvement on something that already works.
 */
const FINDING_PRIORITY: readonly string[] = [
  "products_missing_photos",
  "no_logo",
  "no_hero_composition",
  "editorial_imagery_unused",
  "products_could_be_grouped",
];

function leadingFinding(evaluation: StorefrontEvaluation) {
  for (const key of FINDING_PRIORITY) {
    const found = evaluation.findings.find((f) => f.key === key);
    if (found) return found;
  }
  // A finding key this map hasn't seen yet still gets a voice rather than
  // silently disappearing — evaluateStorefront may grow, and an unranked
  // finding is worth less than a ranked one, not worth nothing.
  return evaluation.findings[0] ?? null;
}

/** The action and canonical topic key a finding is governed under. */
export function governanceFor(findingKey: string): { actionType: GenesisActionType; topicKey: string | null } | null {
  const actionType = FINDING_ACTIONS[findingKey];
  if (!actionType) return null;
  // M2's canonical derivation, reused rather than a second vocabulary — so the
  // gate's previously-rejected and learned-preference lookups match the same
  // keys a real proposal for this action would carry.
  return { actionType, topicKey: deriveTopicKey(actionType, null) };
}

export interface StorefrontReadinessPlan {
  insight: Insight;
  /**
   * True only when this is a genuine first raise. The gate's own rule: stamp
   * the cooldown once a suggestion has really been made, never on an attempt
   * that was suppressed, and never again while it is already standing.
   */
  stampCooldown: boolean;
}

/**
 * Whether to raise a storefront-readiness insight — the pure decision.
 *
 * Three inputs, three real jobs:
 *  - `evaluation`  what is actually true about the store right now.
 *  - `gate`        whether J4 is allowed to volunteer this at all.
 *  - `observationIsActive` whether J4 has already said it and is still saying it.
 *
 * THE THIRD ONE IS NOT AN OPTIMISATION, it is a correctness requirement. The
 * gate's cooldown would otherwise silence the insight the very next cycle,
 * notifyFromInsights' resolve sweep would see it missing, and it would mark the
 * observation RESOLVED — quietly retracting something still true, seven days
 * before J4 is allowed to say it again. So an insight already standing keeps
 * being produced for as long as the condition holds; the gate decides whether
 * to START saying it, never whether to keep a true thing said.
 */
export function planStorefrontReadinessInsight(params: {
  evaluation: StorefrontEvaluation;
  gate: StorefrontSuggestionDecision;
  observationIsActive: boolean;
}): StorefrontReadinessPlan | null {
  const { evaluation, gate, observationIsActive } = params;

  // Nothing wrong with the storefront is not an insight. Silence is a real,
  // valid output of a cycle.
  const leading = leadingFinding(evaluation);
  if (!leading) return null;

  if (!observationIsActive && !gate.allowed) return null;

  const insight: Insight = {
    type: STOREFRONT_READINESS_INSIGHT_TYPE,
    // Never "urgent". A storefront gap is a real opportunity to fix something,
    // not an emergency, and Red is reserved for things that are.
    severity: "opportunity",
    // J4's own reading, verbatim. Not re-summarised, not embellished, and
    // never joined to a claim about sales.
    summary: leading.observed,
    metrics: {
      leadingFinding: leading.key,
      findingKeys: evaluation.findings.map((f) => f.key),
      findingCount: evaluation.findings.length,
      // Counted facts from real rows — the same numbers evaluateStorefront
      // itself counted. No revenue, no orders, no conversion, nothing that
      // would imply sales performance where there is no sales data.
      productCount: evaluation.productCount,
      productsWithImages: evaluation.productsWithImages,
      editorialImageCount: evaluation.editorialImageCount,
      hasLogo: evaluation.hasLogo,
    },
  };

  return { insight, stampCooldown: !observationIsActive };
}

/**
 * The database-facing half: gather the three inputs, plan, and stamp.
 *
 * Called by computeInsights alongside every other detector, so it inherits the
 * whole existing path — notification bar, dedupe, auto-resolve, and the M1
 * cycle's own cadence — with no new plumbing.
 */
export async function detectStorefrontReadiness(storeId: string): Promise<Insight | null> {
  const evaluation = await evaluateStorefront(storeId);
  const leading = leadingFinding(evaluation);
  if (!leading) return null;

  const governance = governanceFor(leading.key);
  const [gate, active] = await Promise.all([
    governance
      ? canSuggestStorefrontImprovement({
          storeId,
          actionType: governance.actionType,
          topicKey: governance.topicKey,
        })
      : Promise.resolve<StorefrontSuggestionDecision>({ allowed: true }),
    prisma.genesisObservation.findFirst({
      where: { storeId, dedupeKey: STOREFRONT_READINESS_DEDUPE_KEY, status: "ACTIVE" },
      select: { id: true },
    }),
  ]);

  const plan = planStorefrontReadinessInsight({
    evaluation,
    gate,
    observationIsActive: active !== null,
  });
  if (!plan) return null;

  if (plan.stampCooldown) {
    // Only on a real raise — see the stamp's own comment in the gate: a
    // suppressed suggestion must never silently start the owner's cooldown.
    await recordStorefrontSuggestionMade(storeId);
  }
  return plan.insight;
}
