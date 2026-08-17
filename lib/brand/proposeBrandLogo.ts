import { prisma } from "@/lib/prisma";
import { GeneratedImageProvider } from "@/lib/imageProviders/generatedImageProvider";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";
import { ASSET_ROLES, resolveCurrentAsset } from "@/lib/businessModel/assets";
import { GENESIS_ACTIONS } from "@/lib/execution/genesisActions";
import { branchProposal, openProposal, type Proposal } from "@/lib/storefront/proposals";
import { buildLogoDirection } from "./logoDirection";

// "Make me a logo", end to end (2026-08-16).
//
// The whole point is that this is NOT a disconnected image generator. It reads
// what J4 already knows (getBusinessUnderstanding), turns that into a direction
// with a stated rationale (buildLogoDirection), generates, and puts the result
// on the table as a real proposal the owner can argue with — the same
// IDEA -> DISCUSSION -> REBUTTAL -> REFINEMENT -> APPROVAL loop everything else
// in this product uses. Approving it runs updateBrandLogoExecutable, which
// designates the brand.logo Asset.
//
// THE NO-PRESSURE RULE IS ENFORCED HERE, not left to the prompt.
// hasExistingLogo() is what a caller checks before offering anything: an owner
// who already has a logo they are happy with is finished, and J4 having the
// ability to generate another is not a reason to raise it. See WORK_STUDIO.md.

export interface BrandLogoProposalResult {
  proposal: Proposal;
  /** What J4 will say about why it made this. Shown, never logged. */
  rationale: string;
  /** What the direction was actually grounded in — honest about thin data. */
  groundedIn: string[];
  imageUrl: string;
}

/**
 * Whether the store already has a logo it is using.
 *
 * Checks the designated Asset first and falls back to Store.logoUrl, because
 * a store that predates designation still has a real logo the owner chose —
 * treating it as "no logo" would be exactly the pressure the rule forbids.
 */
export async function hasExistingLogo(storeId: string): Promise<boolean> {
  const asset = await resolveCurrentAsset(storeId, ASSET_ROLES.brandLogo);
  if (asset) return true;
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { logoUrl: true } });
  return Boolean(store?.logoUrl);
}

async function generate(params: {
  storeId: string;
  prompt: string;
  storeName: string;
  description: string | null;
  excludeUrls: string[];
}) {
  return GeneratedImageProvider.source({
    prompt: params.prompt,
    name: params.storeName,
    description: params.description,
    excludeUrls: params.excludeUrls,
    scope: { storeId: params.storeId },
    feature: "business_icon_generation",
  });
}

/**
 * J4's first recommendation: one logo, grounded in what it knows.
 *
 * `ownerDirection` carries the owner's own words when they asked for something
 * specific ("something with a wave in it"). It is passed through to the prompt
 * builder, which weights it LAST so it overrides anything inferred — the
 * owner's explicit words outrank J4's inference, always.
 */
export async function proposeBrandLogo(params: {
  storeId: string;
  ownerDirection?: string | null;
}): Promise<BrandLogoProposalResult | null> {
  const store = await prisma.store.findUnique({
    where: { id: params.storeId },
    select: { name: true, description: true, logoUrl: true },
  });
  if (!store) return null;

  const understanding = await getBusinessUnderstanding(params.storeId);
  const direction = buildLogoDirection({
    understanding,
    storeName: store.name,
    refinement: params.ownerDirection ?? null,
  });

  const sourced = await generate({
    storeId: params.storeId,
    prompt: direction.prompt,
    storeName: store.name,
    description: store.description,
    excludeUrls: store.logoUrl ? [store.logoUrl] : [],
  });
  // Honest null, the convention every image call here already follows: a
  // failure means no logo was made, never a fabricated placeholder.
  if (!sourced?.url) return null;

  const proposal = await openProposal(params.storeId, {
    actionType: "update_brand_logo",
    summary: "A logo for your business",
    rationale: direction.rationale,
    target: "brand.logo",
    input: {
      imageUrl: sourced.url,
      generationPrompt: sourced.generationPrompt ?? direction.prompt,
      ...(sourced.aiUsageEventId ? { aiUsageEventId: sourced.aiUsageEventId } : {}),
    },
    previousValues: { imageUrl: store.logoUrl ?? "" },
    authorizationTier: GENESIS_ACTIONS.update_brand_logo.authorizationTier,
  });

  return { proposal, rationale: direction.rationale, groundedIn: direction.groundedIn, imageUrl: sourced.url };
}

/** A named alternative direction. J4 writes these; they are not a fixed menu. */
export interface AlternativeDirection {
  /** What the owner will call it. "Warm and hand-drawn", never "Option 2". */
  label: string;
  /** How this one differs, in the owner's language. */
  intent: string;
}

/**
 * "I can also show you a couple of other directions."
 *
 * ONLY called when the owner has actually accepted the offer. The original is
 * preserved — branchProposal supersedes nothing — so an owner who liked the
 * first one still has it, and can say "keep the symbol from the original but
 * use the typography from option two" with both still on the table.
 *
 * Each alternative is generated from the same Business Understanding plus its
 * own stated intent, so they are variations on one informed direction rather
 * than unrelated generations.
 */
export async function branchBrandLogo(params: {
  storeId: string;
  proposalId: string;
  alternatives: AlternativeDirection[];
  ownerDirection?: string | null;
}) {
  const store = await prisma.store.findUnique({
    where: { id: params.storeId },
    select: { name: true, description: true, logoUrl: true },
  });
  if (!store) return null;

  const understanding = await getBusinessUnderstanding(params.storeId);
  const excludeUrls: string[] = store.logoUrl ? [store.logoUrl] : [];
  const drafts = [];

  for (const alternative of params.alternatives) {
    const direction = buildLogoDirection({
      understanding,
      storeName: store.name,
      // The alternative's own intent rides in as owner direction, so it gets
      // the same priority weighting: it is a deliberate instruction about this
      // branch, not a second guess at the business.
      refinement: [params.ownerDirection, alternative.intent].filter(Boolean).join(". "),
    });
    const sourced = await generate({
      storeId: params.storeId,
      prompt: direction.prompt,
      storeName: store.name,
      description: store.description,
      excludeUrls,
    });
    if (!sourced?.url) continue;
    excludeUrls.push(sourced.url);

    drafts.push({
      label: alternative.label,
      summary: alternative.label,
      rationale: alternative.intent,
      target: "brand.logo",
      input: {
        imageUrl: sourced.url,
        generationPrompt: sourced.generationPrompt ?? direction.prompt,
        ...(sourced.aiUsageEventId ? { aiUsageEventId: sourced.aiUsageEventId } : {}),
      },
    });
  }

  if (drafts.length === 0) return null;
  return branchProposal(params.storeId, params.proposalId, drafts);
}
