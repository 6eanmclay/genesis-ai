import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { RECOMMENDATION_MESSAGES } from "./recommendations";
import { callGenesisModel, genesisModelFailureMessage } from "@/lib/genesisModel";

export interface RecommendationExplanation {
  explanation: string;
  // Deliberately a small typed object, not a bare string — room to add
  // fields later (e.g. generatedAt, model version) without a signature
  // change anywhere that calls this.
}

const ExplanationSchema = z.object({ explanation: z.string() });

// Shared with ai-actions.ts's calibration guidance in spirit, but kept as a
// separate local copy — this file has no other reason to depend on that
// module, and the guidance here is a one-liner, not worth an import.
const EXPLANATION_SYSTEM_PROMPT = `You are Genesis, an expert e-commerce consultant. The merchant has been shown a recommendation on their dashboard and asked why it matters. Explain the reasoning a domain expert would give — the business impact, risk, or opportunity behind it — in 1-2 sentences. Do not simply restate the recommendation's own wording back to them.

You are explaining ONLY the single recommendation given to you. Do not propose new or different recommendations, and do not suggest the merchant do anything beyond what was already recommended — narrating why is your only job here.

Be precise about certainty: state facts plainly, but frame any advice or generalization as guidance (e.g. "typically...", "this usually matters because...") rather than settled fact.`;

// The reusable service PH-07 layer 2 is built around — a caching layer can
// wrap this function later (keyed on recommendationId/storeId) without
// touching the server action, the button component, or the panel.
export async function getRecommendationExplanation(params: {
  recommendationId: string;
  storeId?: string;
  storeName: string;
}): Promise<RecommendationExplanation> {
  const message = RECOMMENDATION_MESSAGES[params.recommendationId];
  if (!message) {
    throw new Error(`Unknown recommendation id: ${params.recommendationId}`);
  }
  // storeId is typed optional on this reusable service, but its one real
  // caller (ai-actions.ts's explainRecommendation) always has one via
  // requireStorePermission — Track 0's per-store usage accounting needs a
  // real scope, so this fails loudly rather than silently skipping cost
  // governance for a call that, in practice, is never actually missing it.
  if (!params.storeId) {
    throw new Error("getRecommendationExplanation requires a storeId for usage accounting.");
  }

  const outcome = await callGenesisModel({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    system: EXPLANATION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Store: ${params.storeName}\nRecommendation shown to the merchant: "${message}"\n\nExplain why this matters.`,
      },
    ],
    output_config: {
      effort: "low",
      format: zodOutputFormat(ExplanationSchema),
    },
  }, { storeId: params.storeId, feature: "recommendation_explanation" });

  if (!outcome.ok) {
    throw new Error(genesisModelFailureMessage(outcome.kind));
  }

  const result = outcome.message.parsed_output;
  if (!result) {
    throw new Error("Genesis couldn't generate an explanation");
  }

  return { explanation: result.explanation };
}
