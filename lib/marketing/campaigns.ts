import { randomUUID } from "crypto";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { callGenesisModel } from "@/lib/genesisModel";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import type { BlueprintContextSubset } from "@/lib/execution/genesisActions";
import type { CreativeDirectionOption } from "@/lib/onboarding/types";

// Marketing Engine (Chapter 3) — campaign planning and content generation.
// Deliberately free: this is pure Understand/Reason work (drafting real
// per-channel copy, then persisting it as a real BusinessRecord) — it never
// touches execute() or Growth Points. Only the Marketing Engine's own
// execute_campaign action, a real cadence commitment, ever invests points
// (see ARCHITECTURE.md's Marketing Engine section).

const CampaignPlanSchema = z.object({
  name: z.string(),
  channels: z.array(
    z.object({
      // Open vocabulary, matching CampaignSchema.channel's own shape — not
      // gated on a real connected platform existing yet (channel selection
      // against real connections is a later concern, see ARCHITECTURE.md).
      channel: z.string(),
      content: z.string(),
    })
  ),
});

const CAMPAIGN_PLANNING_SYSTEM_PROMPT = `You are Genesis (J4), planning a real marketing campaign for a merchant's own business, using only the real business understanding given to you below — the same understanding your own recommendation engine reasons from.

Draft real, specific, channel-appropriate copy for each channel the request calls for (or, if the merchant didn't name specific channels, the 2-3 that best fit the request and this business) — never generic template copy. Ground every claim in the real businessProfile/beliefs/recentDecisions you're given; never invent a fact, statistic, or promise about the business that isn't supported by what you were told.

Write every piece of copy in the business's own real brand voice — brandVoiceAndTone and creativeBrandVoice, when given, describe how this specific business actually sounds; a store with no real voice guidance yet should read as plain, warm, and specific to what it actually sells, never as a generic "shop now!" template. photographyStyle, when given, is guidance for what kind of imagery would fit this campaign — describe it in the copy's own stage directions if genuinely useful, never fabricate an image.

Every piece of content here is a starting draft for the owner to personalize, never a finished replacement of their own voice — write it that way: real, usable, specific, but clearly an offer to refine, not the final word.`;

export interface PlannedCampaignChannel {
  channel: string;
  content: string;
}

export interface PlannedCampaign {
  groupId: string;
  name: string;
  channels: PlannedCampaignChannel[];
}

// Returns null on any real failure (provider error, empty plan) — the same
// "fall through silently, never crash the turn" convention every other
// chat-adjacent classifier/generator in this codebase already follows.
export async function planMarketingCampaign(
  storeId: string,
  request: string
): Promise<PlannedCampaign | null> {
  const [store, understanding] = await Promise.all([
    prisma.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { name: true, blueprint: true, creativeDirection: true },
    }),
    getBusinessUnderstanding(storeId),
  ]);

  const blueprint = store.blueprint as BlueprintContextSubset | null;
  const creativeDirection = store.creativeDirection as CreativeDirectionOption | null;

  const contextForPrompt = {
    storeName: store.name,
    request,
    // The two real, previously-unconsumed brand-DNA fields, finally read
    // into a prompt — see ARCHITECTURE.md's Marketing Engine section.
    brandVoiceAndTone: blueprint?.brandIdentity?.brandVoiceAndTone ?? null,
    creativeBrandVoice: creativeDirection?.brandVoice ?? null,
    photographyStyle: creativeDirection?.photographyStyle ?? null,
    businessProfile: understanding.profile,
    beliefs: understanding.beliefs,
    recentDecisions: understanding.recentDecisions,
  };

  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      max_tokens: 3000,
      thinking: { type: "adaptive" },
      system: CAMPAIGN_PLANNING_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Business context (JSON):\n${JSON.stringify(contextForPrompt, null, 2)}`,
        },
      ],
      output_config: { effort: "medium", format: zodOutputFormat(CampaignPlanSchema) },
    },
    { storeId, feature: "marketing_campaign_planning" }
  );

  if (!outcome.ok) return null;
  const plan = outcome.message.parsed_output;
  if (!plan || plan.channels.length === 0) return null;

  const groupId = randomUUID();
  await persistSyncedRecords(
    storeId,
    "genesis_chat",
    plan.channels.map((c) => ({
      entityType: "campaign" as const,
      externalId: randomUUID(),
      data: {
        name: plan.name,
        channel: c.channel,
        status: "draft" as const,
        content: c.content,
        scheduledAt: null,
        groupId,
        sentAt: null,
        audienceSize: null,
        metrics: null,
      },
    })),
    {
      // The owner asked for a campaign; J4 wrote it. GENERATED describes the
      // draft that now exists, which is what this record IS — the owner's
      // request is a conversation turn, not a campaign.
      provenance: "GENERATED",
      provenanceDetail: "campaign draft",
      statedById: null,
      modelExtracted: true,
    }
  );

  return { groupId, name: plan.name, channels: plan.channels };
}
