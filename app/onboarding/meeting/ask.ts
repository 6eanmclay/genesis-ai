import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { callGenesisModel, genesisModelFailureMessage } from "@/lib/genesisModel";

// Meeting with J4 M5 — Ask, only if genuinely needed. Structurally closest
// to app/onboarding/actions.ts's decideExperienceNextStep (a per-turn
// judgment call: is this enough, or is one more question genuinely
// warranted) — but explicitly without that flow's forced-generation
// motivation. That flow must produce a store either way, so it forces
// confident=true on its last allowed turn; this meeting has no such
// requirement. MAX_FOLLOW_UPS below is a pure infrastructure safeguard
// against a runaway loop, never presented to the model as a target — zero
// and one follow-up both remain fully valid, expected, common outcomes.
export interface FollowUpTurn {
  question: string;
  answer: string;
}

const MAX_FOLLOW_UPS = 2;

const AskDecisionSchema = z.object({
  needsFollowUp: z.boolean(),
  // Exactly one concise question when needsFollowUp is true; null otherwise.
  question: z.string().nullable(),
});

const SYSTEM_PROMPT = `You are J4, in the middle of a real, warm conversation with a business owner about their vision for this business — not an interview, not a form. You've asked what they want this to become, and you're shown everything they've said so far.

Decide: do you already understand enough about their vision, or is there one real, specific, nameable gap that would genuinely change what you'd explore or recommend next? Bias strongly toward NOT asking — most real answers already say enough. Only ask a follow-up when something concrete and important is still genuinely unclear, never to fill a turn, gather more data for its own sake, or seem thorough.

If you do ask, ask exactly ONE concise, warm question that builds naturally on what they just said — never generic, never scripted-feeling, never something they already answered.`;

export async function decideNextMeetingStep(
  storeId: string,
  transcript: FollowUpTurn[]
): Promise<{ action: "ask"; question: string } | { action: "proceed" }> {
  // Safety ceiling only — reached without ever calling the model again, so
  // it can never be talked past by a model that keeps finding "one more"
  // real gap.
  if (transcript.length >= MAX_FOLLOW_UPS) {
    return { action: "proceed" };
  }

  const transcriptText = transcript.map((t) => `J4 asked: "${t.question}"\nThey answered: "${t.answer}"`).join("\n\n");

  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      max_tokens: 500,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: transcriptText }],
      output_config: { effort: "low", format: zodOutputFormat(AskDecisionSchema) },
    },
    { storeId, feature: "j4_meeting_ask" }
  );

  if (!outcome.ok) {
    throw new Error(genesisModelFailureMessage(outcome.kind));
  }
  const parsed = outcome.message.parsed_output;
  if (!parsed || (parsed.needsFollowUp && !parsed.question)) {
    // Malformed output degrades to the safe default — proceed rather than
    // ask a broken/empty question.
    return { action: "proceed" };
  }
  if (!parsed.needsFollowUp) {
    return { action: "proceed" };
  }
  return { action: "ask", question: parsed.question! };
}
