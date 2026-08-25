import { randomUUID } from "crypto";
import { readOwnerFacts } from "@/lib/businessModel/ownerFacts";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { callGenesisModel } from "@/lib/genesisModel";
import { communicateFinding } from "@/lib/execution/genesisAutonomy";
import { GENESIS_ACTIONS, type BlueprintContextSubset } from "@/lib/execution/genesisActions";
import type { CreativeDirectionOption } from "@/lib/onboarding/types";
import type { UpdateMarketingAssetsInput } from "@/lib/execution/executables/updateMarketingAssets";

// Marketing Engine (Chapter 3) — update_marketing_assets' real reachability
// fix. A first real attempt added it to Reason's own ProposedActionSchema
// (lib/intelligence/cognitiveLayer.ts) even with a fully empty input — and
// hit the exact same "compiled grammar is too large" 400 that schema's own
// comment already documents, confirmed live. Per this codebase's own
// standing rule (a provider-level constraint is never grounds to redesign
// a principle, only to find a different implementation path),
// update_marketing_assets is reachable through a genuinely separate
// mechanism instead: checkAndProposeMarketingAssetsUpdate below is a cheap,
// deterministic Understand-layer check (are the real bios missing?),
// called unconditionally from runCognitiveReview — zero added complexity
// to Reason's own schema, a real generative call (draftMarketingAssets)
// only when the deterministic check is actually true.

const MarketingAssetsDraftSchema = z.object({
  brandKeywords: z.array(z.string()),
  instagramBio: z.string(),
  facebookDescription: z.string(),
  xBio: z.string(),
});

const MARKETING_ASSETS_DRAFT_SYSTEM_PROMPT = `You are Genesis (J4), drafting real marketing bios/keywords for a merchant's business, using only the real business context given to you below.

Write in the business's own real brand voice — brandVoiceAndTone and creativeBrandVoice, when given, describe how this specific business actually sounds; with no real voice guidance yet, write plain, warm copy specific to what the business actually sells, never a generic template. Ground every claim in the real businessProfile you're given — never invent a fact about the business.

instagramBio and xBio must respect each platform's real character norms (short, scannable). facebookDescription can be a little longer. brandKeywords should be real, specific terms this business would actually want to be found for — never generic filler words.

This is a starting draft for the owner to personalize, never a finished replacement of their voice.`;

export async function draftMarketingAssets(
  storeId: string,
  reason: string
): Promise<UpdateMarketingAssetsInput | null> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { name: true, description: true, blueprint: true, creativeDirection: true },
  });
  const blueprint = store.blueprint as BlueprintContextSubset | null;
  // The four claims live in the fact lifecycle now. Read once, used below.
  const claims = await readOwnerFacts(storeId);
  const creativeDirection = store.creativeDirection as CreativeDirectionOption | null;

  const contextForPrompt = {
    storeName: store.name,
    storeDescription: store.description,
    reason,
    // From the facts, not the blueprint (2026-08-24, D1-A).
    brandVoiceAndTone: claims.brandVoice,
    creativeBrandVoice: creativeDirection?.brandVoice ?? null,
    businessProfile: {
      brandStory: blueprint?.brandIdentity?.brandStory ?? null,
      brandPersonality: claims.brandPersonality,
      targetAudience: claims.targetAudience,
      uniqueSellingProposition: claims.sellingProposition,
    },
  };

  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      max_tokens: 1200,
      thinking: { type: "adaptive" },
      system: MARKETING_ASSETS_DRAFT_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `Business context (JSON):\n${JSON.stringify(contextForPrompt, null, 2)}` },
      ],
      output_config: { effort: "low", format: zodOutputFormat(MarketingAssetsDraftSchema) },
    },
    { storeId, feature: "marketing_assets_draft" }
  );

  if (!outcome.ok) return null;
  return outcome.message.parsed_output;
}

// Called unconditionally inside runCognitiveReview — cheap and safe to run
// every real review pass, same "deterministic checks run every time, only
// the expensive generative step is conditional" discipline this codebase
// already applies elsewhere (e.g. computeInsights vs. the AI review itself).
// Returns true only when a real new ApprovalRequest was actually created.
export async function checkAndProposeMarketingAssetsUpdate(storeId: string): Promise<boolean> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { blueprint: true },
  });
  const blueprint = store?.blueprint as BlueprintContextSubset | null;
  const assets = blueprint?.marketingAssets;

  // Stale/missing: every real platform bio is empty. A store with at least
  // one real bio already isn't a candidate here — this check is for
  // "never been filled in yet," not "could theoretically be improved,"
  // matching the same restraint every other real recommendation in this
  // codebase already applies (never propose just because it's possible).
  const hasAnyRealBio = Boolean(
    assets?.instagramBio?.trim() || assets?.facebookDescription?.trim() || assets?.xBio?.trim()
  );
  if (hasAnyRealBio) return false;

  const alreadyPending = await prisma.approvalRequest.findFirst({
    where: { storeId, actionType: "update_marketing_assets", status: "PENDING_APPROVAL" },
    select: { id: true },
  });
  if (alreadyPending) return false;

  const drafted = await draftMarketingAssets(
    storeId,
    "This store's social bios and keywords have never been filled in."
  );
  if (!drafted) return false;

  const definition = GENESIS_ACTIONS.update_marketing_assets;
  const summary =
    "Your Instagram, Facebook, and X bios are all empty, so search and social discovery have nothing real to show yet. Here's a starting draft — treat it as a first pass in your own words, not the final version.";

  const { cognitiveOutputId } = await communicateFinding(storeId, {
    kind: "recommendation",
    summary,
    priority: "medium",
    confidence: 0.7,
    actionHref: "/dashboard/marketing",
    proposedAction: { actionType: "update_marketing_assets", input: drafted },
  });

  // AWAITED since 2026-08-24 (D1-A): getCurrentValues may be async now, and a
  // Promise stored here would serialise into previousValues as {} — reversal
  // silently losing everything it exists to preserve. Typecheck cannot catch it
  // because these flow into Json positions.
  const previousValues = await definition.getCurrentValues({ storeId, blueprint: blueprint ?? null });
  const groupId = randomUUID();

  const approval = await prisma.approvalRequest.create({
    data: {
      storeId,
      cognitiveOutputId,
      actionType: "update_marketing_assets",
      input: drafted as object,
      previousValues: previousValues as object,
      summary,
      authorizationTier: definition.authorizationTier,
      groupId,
      topicKey: "marketing_assets_missing",
    },
  });
  await prisma.cognitiveOutput.update({
    where: { id: cognitiveOutputId, storeId },
    data: { status: "SUPERSEDED", approvalRequestId: approval.id },
  });

  return true;
}
