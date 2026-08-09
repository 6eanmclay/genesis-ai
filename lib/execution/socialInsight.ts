import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { callGenesisModel } from "@/lib/genesisModel";
import { queryRecords } from "@/lib/businessModel/reasoning";

// Social Connections & Business Intelligence (2026-08-09) — "Most
// importantly: J4 should be able to interpret the data rather than simply
// display it" (Sean, with his own real example: "TikTok is currently your
// strongest audience channel..."). Called via IntegrationConnector's
// optional interpretSync() hook, right after a social connector's own
// sync() data has actually been persisted — real, current
// businessRecord("socialAccount") rows in hand, never stale or synthetic.
//
// Writes through communicateFinding() (lib/execution/genesisAutonomy.ts) —
// the same real, established "J4 tells the owner something" mechanic
// Cognitive Layer's own insights/predictions already use, not a new
// notification system. The resulting CognitiveOutput row is what makes
// this reachable via getBusinessUnderstanding().activeThoughts, on top of
// the raw data already being reachable via businessProfile.socialAccounts.

const SocialInsightSchema = z.object({
  // One real, specific insight — Sean's own example tone: name which
  // platform/metric is genuinely notable and why it matters for the
  // business, never a generic "your social media is growing" filler.
  summary: z.string(),
});

const SOCIAL_INSIGHT_SYSTEM_PROMPT = `You are Genesis (J4), looking at a merchant's real, currently-connected social media account data (Facebook, Instagram, and/or TikTok) to tell them something genuinely useful about it — not a status report, a real interpretation.

Compare across platforms when more than one is connected: which is the strongest audience channel and why (reach, engagement rate, follower count, growth), whether audiences differ in size vs. engagement quality, whether demographics differ in a way that matters for how the business should think about each platform. When only one platform is connected, interpret what its own numbers mean for the business (e.g. "your audience skews toward mobile evening browsing based on X" — only if the data actually supports a claim like that).

Ground every claim in the real numbers you're given. Never state a follower count, percentage, or demographic breakdown that isn't literally present in the data. Any field that's null or listed in unavailableMetrics means that platform genuinely doesn't expose it — never estimate or infer a number to fill the gap; if the interesting comparison you'd want to make needs a metric that's unavailable, either work with what IS available or say so honestly rather than fabricating.

Write one real, specific sentence (occasionally two if genuinely warranted) — the way a sharp business partner would open a conversation about this, not a dashboard caption. Never just restate a raw number ("You have 3,241 followers on Instagram") — say what it MEANS for the business (e.g. which channel deserves more attention, what the audience composition implies for product positioning or ad targeting).`;

export async function generateSocialInsight(storeId: string): Promise<void> {
  const socialAccounts = await queryRecords(storeId, "socialAccount");
  if (socialAccounts.length === 0) return;

  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      max_tokens: 500,
      thinking: { type: "adaptive" },
      system: SOCIAL_INSIGHT_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `This business's real, currently-connected social account data (JSON):\n${JSON.stringify(
            socialAccounts.map((r) => r.data),
            null,
            2
          )}`,
        },
      ],
      output_config: { effort: "medium", format: zodOutputFormat(SocialInsightSchema) },
    },
    { storeId, feature: "social_insight_generation" }
  );

  if (!outcome.ok || !outcome.message.parsed_output) return;

  // Dynamic import (2026-08-09) — a real, confirmed circular-import build
  // failure: genesisAutonomy.ts pulls in genesisActions.ts's own huge
  // executable registry, and something in that graph statically cycles
  // back to lib/integrations (the module tree this file's own callers —
  // facebook.ts/instagram.ts/tiktok.ts — live in). Deferring this one
  // import to call time (not module-load time) breaks the STATIC cycle
  // bundlers/Node's ESM loader trip on, with zero change to real runtime
  // behavior — communicateFinding still runs exactly the same way, just
  // resolved lazily.
  const { communicateFinding } = await import("./genesisAutonomy");
  await communicateFinding(storeId, {
    kind: "insight",
    summary: outcome.message.parsed_output.summary,
    entityType: "socialAccount",
  });
}
