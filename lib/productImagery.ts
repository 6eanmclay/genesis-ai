import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { searchPhotoCandidates } from "./unsplash";
import { callGenesisModel } from "@/lib/genesisModel";

// Verified directly this session: a raw product name/description often
// fails an Unsplash search outright — brand-flavored names ("Rue de
// Vigne") and non-generic phrasing ("Cedar Blend Moth Repellent Balls")
// return zero results, while a plain, generic, photographable description
// of the same physical object succeeds. This reformulation step is the
// fix — same Unsplash search underneath, better queries going in. No image
// generation: every candidate returned is a real photograph.
const QueryReformulationSchema = z.object({
  queries: z.array(z.string()).max(3),
});

const QUERY_REFORMULATION_SYSTEM_PROMPT = `You are helping find real stock photos for an e-commerce product on a photo search engine (Unsplash). Stock photo search only works well with plain, generic, physically descriptive phrases — it has no idea what a brand name or a store's product name means.

Given a product's name and description, produce up to 3 short search phrases (2-5 words each) that describe what the product actually IS or LOOKS like as a physical object — not its brand name, not marketing language, not any non-English or stylized phrasing. Strip out brand/store names entirely. Order them from most to least likely to return a good, representative photo.

Example: "Rue de Vigne" (a perfume) -> "perfume bottle", "glass perfume bottle on table"
Example: "Cedar Blend Moth Repellent Balls" -> "cedar wood balls", "wooden closet balls"
Example: "Forge Adjustable Dumbbell Pair" -> "adjustable dumbbells", "dumbbell pair gym"

If the product is genuinely abstract (e.g. a software feature) and has no real physical form, still propose the closest reasonable concrete visual (e.g. a laptop, a dashboard screen, an office desk) rather than an empty list.`;

async function reformulateQueries(product: { name: string; description: string | null }): Promise<string[]> {
  // A provider failure here degrades the same way a missing parsed_output
  // already did — fall back to the raw product name (see
  // sourceProductImageCandidate below) rather than throwing. Nothing about
  // sourcing a product photo is worth surfacing an AI-provider error to the
  // merchant for; callGenesisModel already logs the real failure server-side.
  const outcome = await callGenesisModel({
    model: "claude-opus-4-8",
    max_tokens: 1000,
    thinking: { type: "adaptive" },
    system: QUERY_REFORMULATION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Product name: ${product.name}\nDescription: ${product.description ?? "(none)"}`,
      },
    ],
    output_config: {
      effort: "low",
      format: zodOutputFormat(QueryReformulationSchema),
    },
  });
  if (!outcome.ok) return [];
  return outcome.message.parsed_output?.queries ?? [];
}

// Sources one candidate image for a product, preferring Claude-reformulated
// generic search phrases over the raw product name. Skips any URL already
// in `excludeUrls` (the product's current live image, plus every candidate
// already shown for a given approval) so regenerating can produce a
// genuinely different result instead of silently re-showing the same one.
// Returns null once every reformulated phrase is exhausted with nothing
// new to offer — a normal, expected outcome, not an error.
export async function sourceProductImageCandidate(
  product: { name: string; description: string | null },
  excludeUrls: string[] = []
): Promise<string | null> {
  const excluded = new Set(excludeUrls);
  const queries = await reformulateQueries(product);
  // Fall back to the raw name if Claude returned nothing usable, so a
  // transient reformulation failure doesn't fully block sourcing.
  const candidateQueries = queries.length > 0 ? queries : [product.name];

  for (const query of candidateQueries) {
    const photos = await searchPhotoCandidates(query, 5);
    const unseen = photos.find((url) => !excluded.has(url));
    if (unseen) return unseen;
  }

  return null;
}

// The architectural fix for hero-image genericness (Beta Round 2 audit,
// Priority 4): the storefront hero used to fall back to products[0]'s own
// image — coupling the single most visible piece of storefront identity to
// array position and to whichever product happened to get a real photo.
// This gives the hero its own deliberate sourcing step, exactly like a real
// product does, querying the brand's own vision/what-it-sells rather than
// any one product — so hero quality never depends on product-array order or
// on any single product's imagery having succeeded or failed.
const HeroQuerySchema = z.object({
  queries: z.array(z.string()).max(3),
});

const HERO_QUERY_SYSTEM_PROMPT = `You are helping find one real stock photo (Unsplash) to represent a storefront's hero image — not a specific product, the overall feeling, setting, or material of the business as a whole.

Given what the business sells and its stated vision, produce up to 3 short, plain, generic, physically photographable search phrases (2-5 words each) describing a scene, setting, material, or atmosphere that captures this brand's world — a workshop, a studio, a landscape, a material close-up, a lifestyle moment. Never a specific named product, a brand name, or marketing language.

Example: a heritage leather goods brand, old-world craft -> "leather workshop", "hand-stitched leather", "leather tanning"
Example: a calming plant shop for apartment dwellers -> "houseplants apartment", "indoor plants sunlight", "cozy plant corner"
Example: a dark luxury fitness brand -> "gym equipment dark", "weightlifting silhouette", "modern gym interior"

Order from most to least likely to return a striking, on-brand photo.`;

export async function sourceHeroImageCandidate(brief: {
  productType: string | null;
  vision: string;
}): Promise<string | null> {
  // Same "degrade to no image, never to an error" reasoning as
  // reformulateQueries above — a hero photo is a nice-to-have, not
  // something worth surfacing a provider failure to the merchant for.
  const outcome = await callGenesisModel({
    model: "claude-opus-4-8",
    max_tokens: 500,
    thinking: { type: "adaptive" },
    system: HERO_QUERY_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `What they sell: ${brief.productType ?? "(unspecified)"}\nVision: ${brief.vision}`,
      },
    ],
    output_config: {
      effort: "low",
      format: zodOutputFormat(HeroQuerySchema),
    },
  });
  if (!outcome.ok) return null;
  const queries = outcome.message.parsed_output?.queries ?? [];

  for (const query of queries) {
    const photos = await searchPhotoCandidates(query, 1);
    if (photos[0]) return photos[0];
  }

  return null;
}
