// One shared source of truth for how a CognitiveOutput.kind becomes an
// owner-facing label — consumed by DiscoveryFeed's cards and ActivityFeed's
// finding-communication rows, so the two surfaces can never drift into
// independently hand-copied vocabularies (the same discipline already
// applied to the Genesis Language's own colors in GENESIS_STATE_META).
// "insight" is real (computeInsights() writes it via communicate_finding)
// but had no label anywhere in the product until this pass — the same
// shape of previously-invisible gap already found for explanation-kind
// outputs before the Genesis Language retrofit.
export const COGNITIVE_OUTPUT_KIND_LABEL: Record<string, string> = {
  insight: "Insight",
  recommendation: "Recommendation",
  opportunity: "Opportunity",
  explanation: "Worth understanding",
  prediction: "Goal progress",
};
