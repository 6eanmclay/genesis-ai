import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { searchPhotoCandidates } from "./unsplash";
import { callGenesisModel } from "@/lib/genesisModel";

// Per-product sourcing (formerly sourceProductImageCandidate, defined here)
// now lives in lib/imageProviders/stockSearchProvider.ts, behind the
// ImageProvider interface — see that file's own comment. Hero sourcing
// below is intentionally untouched: it sources one image for the brand as
// a whole, not a specific product, so it isn't part of that per-product
// provider abstraction.

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
