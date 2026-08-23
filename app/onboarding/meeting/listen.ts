import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { randomUUID } from "crypto";
import { callGenesisModel, genesisModelFailureMessage } from "@/lib/genesisModel";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { GoalCaptureSchema, ChallengeCaptureSchema, toGoalRecordData, toChallengeRecordData } from "@/lib/businessModel/factCapture";

// Meeting with J4 M4 — Listen. Unlike live chat's business-fact extraction
// (one message, at most one fact), one open "what do you want this to
// become" answer can honestly contain several real facts — a goal and a
// challenge in the same breath. An array of the same real Capture shapes
// live chat already uses, not a new schema, scoped to goal/challenge only
// (this stage is about vision, not employees/locations).
const VisionFactsSchema = z.object({
  facts: z.array(
    z.discriminatedUnion("entityType", [
      z.object({ entityType: z.literal("goal"), data: GoalCaptureSchema }),
      z.object({ entityType: z.literal("challenge"), data: ChallengeCaptureSchema }),
    ])
  ),
});

const SYSTEM_PROMPT = `You are J4, listening to a business owner describe, in their own words, what they ultimately want this business to become. Extract every real, durable goal or challenge they actually stated — never invent one that wasn't really said, and never force something out of a vague answer that didn't contain one.

A "goal" is something they want to achieve. A "challenge" is something they're worried about or currently struggling with. One answer can honestly contain zero, one, or several of these — most short answers contain one or two; a genuinely vague answer ("I just want it to grow, I guess") may honestly contain none. Never pad the list to seem thorough.

For each goal, fill in description with a real, specific sentence in the owner's own terms. If they stated a real dollar figure, fill in targetValueInCents (e.g. "$10k a month" -> 1000000); leave it null otherwise, never estimate one. For each challenge, fill in description the same way.`;

export interface VisionExtractionResult {
  factsWritten: number;
}

export async function extractAndPersistVisionFacts(
  storeId: string,
  visionText: string,
  /**
   * WHO SAID IT (2026-08-22). The meeting is the single richest source of
   * owner-stated facts in the product, and until now it wrote them with no
   * author at all -- so a goal from the meeting and a goal from a connector
   * were equally anonymous downstream. The caller has always had this; it
   * simply had nowhere to put it.
   */
  statedByUserId: string | null
): Promise<VisionExtractionResult> {
  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      max_tokens: 1200,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: visionText }],
      output_config: { effort: "medium", format: zodOutputFormat(VisionFactsSchema) },
    },
    { storeId, feature: "j4_meeting_listen_extraction" }
  );

  if (!outcome.ok) {
    throw new Error(genesisModelFailureMessage(outcome.kind));
  }
  const parsed = outcome.message.parsed_output;
  if (!parsed) {
    throw new Error("J4 meeting vision extraction: malformed model output");
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  let written = 0;
  for (const fact of parsed.facts) {
    const fullData =
      fact.entityType === "goal" ? toGoalRecordData(fact.data, todayIso) : toChallengeRecordData(fact.data, todayIso);
    await persistSyncedRecords(
      storeId,
      "j4_meeting",
      [{ entityType: fact.entityType, externalId: randomUUID(), data: fullData }],
      {
        // The owner said this out loud in a meeting and a model wrote down what
        // it heard. Same pair as live chat, same reason for recording both.
        provenance: "OWNER",
        provenanceDetail: "meeting",
        statedById: statedByUserId,
        modelExtracted: true,
      }
    );
    written++;
  }

  return { factsWritten: written };
}
