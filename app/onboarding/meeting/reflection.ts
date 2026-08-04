import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { callGenesisModel, genesisModelFailureMessage } from "@/lib/genesisModel";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";

// Meeting with J4 M3 — Reflect, the first stage (MEETING_WITH_J4.md). Grounded
// in real getBusinessUnderstanding() data only: identity/brandStory/mission/
// targetAudience/USP (store.blueprint.brandIdentity, via getBusinessProfile)
// and the one real launch product. Deliberately NOT the owner's raw
// ideaText/brandPositioningText answers — those live only on StoreDraft.
// onboardingState, which confirmStoreDraftCore deletes the moment the real
// Store is created (app/dashboard/ai-actions.ts:3617) — gone long before a
// launched store ever reaches this meeting. The AI-generated brand identity
// those answers produced is what survives, and is itself real and specific
// enough to reflect back — never a generic "tell me about your business."
const MeetingReflectionSchema = z.object({
  message: z.string(),
});

const SYSTEM_PROMPT = `You are J4, meeting this business's owner for the first time, immediately after Genesis just built their store with them. This is not an onboarding step and not an interview — it's the opening of a real, ongoing partnership.

Your one job right now: prove you already understand this business, in one warm, specific, self-contained message. Name real, concrete details from what's shown below — the brand's actual story, voice, or the one real product it launched with — never a generic "tell me about your business" opener. The owner should read this and feel understood before you've asked them anything.

Do not ask a question yet — that's a separate moment. Do not propose or recommend anything yet. Just reflect what you already know, in your own voice: confident, warm, genuinely curious about where this goes, never robotic or like a form summarizing itself back. 2-4 sentences.`;

export async function generateMeetingReflection(storeId: string): Promise<string> {
  const understanding = await getBusinessUnderstanding(storeId);
  const { identity, offerings } = understanding.profile;

  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      max_tokens: 600,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `What Genesis already knows about this business:\n${JSON.stringify(
            {
              identity,
              products: offerings.items.map((item) => ({
                name: item.data.name,
                category: item.data.category,
                priceInCents: item.data.priceInCents,
              })),
            },
            null,
            2
          )}`,
        },
      ],
      output_config: { effort: "medium", format: zodOutputFormat(MeetingReflectionSchema) },
    },
    { storeId, feature: "j4_meeting_reflect" }
  );

  if (!outcome.ok) {
    throw new Error(genesisModelFailureMessage(outcome.kind));
  }

  const parsed = outcome.message.parsed_output;
  if (!parsed) {
    throw new Error("J4 meeting reflection: malformed model output");
  }
  return parsed.message;
}
