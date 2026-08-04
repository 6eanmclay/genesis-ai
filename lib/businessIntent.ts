import type { AiFeature } from "./aiFeatures";

// AI Cost & Usage Infrastructure — the business-intent layer Sean asked to
// add before call-site instrumentation went too deep (2026-08-04): a
// coarser axis than AiFeature, sitting above it, answering "what kind of
// business activity is this" rather than "which exact call was this."
// Fixed to Sean's own 9 categories — deliberately not open/additive like
// AiFeature or businessTaxonomy.ts's own taxonomies, since the whole point
// is a small, stable set to aggregate and compare against over time; add a
// 10th only with real evidence it's needed, not preemptively.
export const BUSINESS_INTENT_CATEGORIES = [
  "build_business",
  "create_product",
  "improve_store",
  "create_marketing",
  "analyze_business",
  "research",
  "financial_insight",
  "customer_communication",
  "growth_recommendation",
] as const;

export type BusinessIntentCategory = (typeof BUSINESS_INTENT_CATEGORIES)[number];

// Every AiFeature maps to exactly one category — the Record<AiFeature, ...>
// type below makes a missing entry a compile error the moment AI_FEATURES
// gains a new value, same discipline lib/genesisModel.ts's required
// `feature` param already enforces at the call-site level. A first-pass
// judgment call,
// not a frozen taxonomy — some features are general-purpose utility
// (e.g. the dashboard chat's own routing/control calls) approximated to
// their most representative use; reclassify freely in this one file as
// real usage data makes a better category obvious.
const AI_FEATURE_INTENT: Record<AiFeature, BusinessIntentCategory> = {
  store_draft_primary_blueprint: "build_business",
  store_draft_secondary_blueprint: "build_business",
  store_draft_composition: "build_business",
  store_draft_business_category: "build_business",
  draft_chat_control: "build_business",
  draft_chat_content_primary: "build_business",
  draft_chat_content_secondary: "build_business",
  draft_chat_composition: "build_business",
  store_chat_data_question: "analyze_business",
  store_chat_data_answer: "analyze_business",
  store_chat_business_fact: "research",
  store_chat_image_request_detection: "create_marketing",
  store_chat_content_primary: "customer_communication",
  store_chat_content_secondary: "customer_communication",
  store_chat_composition: "improve_store",
  recommendation_explanation: "growth_recommendation",
  cognitive_review: "growth_recommendation",
  hero_image_query: "create_marketing",
  stock_image_query_reformulation: "create_marketing",
  product_image_generation: "create_product",
  business_icon_generation: "improve_store",
  onboarding_business_model_classification: "build_business",
  onboarding_brand_positioning_classification: "build_business",
  onboarding_creative_direction_generation: "build_business",
  onboarding_uploaded_artwork_identity: "build_business",
  onboarding_creative_theme_structure: "build_business",
  onboarding_hero_selection: "create_product",
  onboarding_experience_decision: "build_business",
  j4_meeting_reflect: "customer_communication",
  // Matches store_chat_business_fact's own mapping — the same kind of work
  // (turning real owner statements into durable business facts), just a
  // different real conversation context.
  j4_meeting_listen_extraction: "research",
};

export function businessIntentFor(feature: AiFeature): BusinessIntentCategory {
  return AI_FEATURE_INTENT[feature];
}
