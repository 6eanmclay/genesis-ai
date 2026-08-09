// AI Cost & Usage Infrastructure, Milestone 1 — the single source of truth
// for "what triggered this AI call." Every real call site (lib/genesisModel.ts's
// callGenesisModel, and lib/imageProviders/generatedImageProvider.ts's
// GeneratedImageProvider) tags itself with exactly one of these when it
// records an AiUsageEvent row.
//
// Deliberately a plain string union, not a Prisma enum — matches this
// codebase's existing "open, additive taxonomy, never a schema migration to
// add a value" convention (see lib/businessTaxonomy.ts's own comment on
// REVENUE_STREAM_TYPES for the same reasoning applied to a different axis).
//
// This is also the identifier set a future Growth Credit catalog keys off
// of (see lib/execution/genesisActions.ts's own comment) — naming these
// around real product actions, not internal implementation details, is
// what makes that possible later without renaming everything.
export const AI_FEATURES = [
  // Store draft generation (app/dashboard/ai-actions.ts, generateStoreDraftCore)
  "store_draft_primary_blueprint",
  "store_draft_secondary_blueprint",
  "store_draft_composition",
  "store_draft_business_category",
  // Draft-phase chat (applyGenesisMessage)
  "draft_chat_control",
  "draft_chat_content_primary",
  "draft_chat_content_secondary",
  "draft_chat_composition",
  // Business Assets (lib/businessAssets/)
  "business_asset_classification",
  // Live-store chat (applyGenesisMessageToStore)
  "store_chat_upload_intent_detection",
  // Response Modes plan (2026-08-07) — replaces the four now-removed
  // classifier-specific features below (store_chat_data_question,
  // store_chat_business_fact, store_chat_image_request_detection,
  // store_chat_campaign_request_detection) with one unified, tool-enabled
  // triage call.
  "store_chat_unified_triage",
  "store_chat_data_answer",
  "store_chat_content_primary",
  "store_chat_content_secondary",
  "store_chat_composition",
  // Recommendations / Business Intelligence
  "recommendation_explanation",
  "cognitive_review",
  // Product imagery
  "hero_image_query",
  "stock_image_query_reformulation",
  "product_image_generation",
  "business_icon_generation",
  // J4 approvable product content changes (2026-08-09) — real, grounded
  // name/description suggestions for one or more existing products,
  // generated once request_product_content_change resolves scope (see
  // lib/execution/productContentGeneration.ts).
  "product_content_generation",
  // Onboarding v2 / activation flow (app/onboarding/actions.ts)
  "onboarding_business_model_classification",
  "onboarding_brand_positioning_classification",
  "onboarding_creative_direction_generation",
  "onboarding_uploaded_artwork_identity",
  "onboarding_creative_theme_structure",
  "onboarding_hero_selection",
  // Experience-First Onboarding (anonymous, app/onboarding/actions.ts)
  "onboarding_experience_decision",
  // Meeting with J4 (app/onboarding/meeting/)
  "j4_meeting_reflect",
  "j4_meeting_listen_extraction",
  "j4_meeting_ask",
  // Marketing Engine (lib/marketing/, app/dashboard/ai-actions.ts)
  "marketing_campaign_planning",
  "marketing_assets_draft",
  // Daily Operating Rhythm (lib/dashboard/genesisBriefingComposer.ts)
  "owner_briefing_composer",
  // J4 Voice Memos (lib/voice/j4VoiceMemo.ts) — transcribing a recorded
  // memo, distinct from store_chat_unified_triage's own real understanding
  // call on the resulting transcript text (applyGenesisMessageToStore
  // handles that with its existing features, unchanged).
  "voice_memo_transcription",
  // J4 spoken response (lib/voice/j4VoiceOutput.ts) — synthesizing J4's
  // own reply as speech, concurrent with the text already streaming.
  "j4_voice_output",
  // Social Connections & Business Intelligence (2026-08-09) — real
  // cross-platform interpretation of a store's just-synced social account
  // data (lib/execution/socialInsight.ts), triggered after a Facebook/
  // Instagram/TikTok sync.
  "social_insight_generation",
] as const;

export type AiFeature = (typeof AI_FEATURES)[number];
