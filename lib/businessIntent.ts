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
  // Same reasoning as j4_meeting_listen_extraction below — detecting that
  // the owner wants to hand Genesis real business knowledge is the same
  // kind of work, just routed to the upload flow instead of a captured
  // fact.
  store_chat_upload_intent_detection: "research",
  // Turning an uploaded file into durable business knowledge — the same
  // real kind of work store_chat_unified_triage's capture_business_fact
  // tool does, just sourced from a file's actual content instead of a chat
  // statement.
  business_asset_classification: "research",
  // Response Modes plan (2026-08-07) — one call now covers what
  // store_chat_data_question/store_chat_business_fact/
  // store_chat_campaign_request_detection/store_chat_image_request_detection
  // used to split across four; approximated to its most common real
  // outcome (a data question or plain conversational reply), same
  // "reclassify freely as usage data clarifies it" practice this file
  // already follows.
  store_chat_unified_triage: "analyze_business",
  store_chat_data_answer: "analyze_business",
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
  // Matches store_chat_unified_triage's capture_business_fact tool — the
  // same kind of work (turning real owner statements into durable business
  // facts), just a different real conversation context.
  j4_meeting_listen_extraction: "research",
  j4_meeting_ask: "customer_communication",
  marketing_campaign_planning: "create_marketing",
  marketing_assets_draft: "create_marketing",
  // Same real synthesis pipeline as cognitive_review, just composed into a
  // narrative rather than structured findings.
  owner_briefing_composer: "growth_recommendation",
  // Same reasoning as business_asset_classification above — turning a
  // recorded memo into text is the input layer for durable business
  // knowledge, not the understanding itself (store_chat_unified_triage
  // handles the transcript's real content afterward).
  voice_memo_transcription: "research",
  // Same category as store_chat_unified_triage — this is that same
  // conversational reply, just spoken; the underlying content's real
  // intent already lives with whichever turn produced the text.
  j4_voice_output: "analyze_business",
};

export function businessIntentFor(feature: AiFeature): BusinessIntentCategory {
  return AI_FEATURE_INTENT[feature];
}
