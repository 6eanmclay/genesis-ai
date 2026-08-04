import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { searchPhotoCandidates } from "@/lib/unsplash";
import { callGenesisModel } from "@/lib/genesisModel";
import type { ImageProvider, ImageSourceRequest, ImageSourceResult } from "./types";

// The pre-existing sourcing path (formerly lib/productImagery.ts's
// sourceProductImageCandidate), unchanged in behavior, now conforming to
// the shared ImageProvider interface — see resolveProductImage.ts for why
// this stopped being the only provider. Real stock photography from
// Unsplash's search API, never generated. Verified directly this session:
// a raw product name/description often fails an Unsplash search outright
// — brand-flavored names ("Rue de Vigne") and non-generic phrasing ("Cedar
// Blend Moth Repellent Balls") return zero results, while a plain,
// generic, physically descriptive phrase of the same object succeeds —
// this reformulation step is that fix, same search underneath, better
// queries going in.
const QueryReformulationSchema = z.object({
  queries: z.array(z.string()).max(3),
});

const QUERY_REFORMULATION_SYSTEM_PROMPT = `You are helping find real stock photos for an e-commerce product on a photo search engine (Unsplash). Stock photo search only works well with plain, generic, physically descriptive phrases — it has no idea what a brand name or a store's product name means.

Given a product's name and description, produce up to 3 short search phrases (2-5 words each) that describe what the product actually IS or LOOKS like as a physical object — not its brand name, not marketing language, not any non-English or stylized phrasing. Strip out brand/store names entirely. Order them from most to least likely to return a good, representative photo.

Example: "Rue de Vigne" (a perfume) -> "perfume bottle", "glass perfume bottle on table"
Example: "Cedar Blend Moth Repellent Balls" -> "cedar wood balls", "wooden closet balls"
Example: "Forge Adjustable Dumbbell Pair" -> "adjustable dumbbells", "dumbbell pair gym"

If the product is genuinely abstract (e.g. a software feature) and has no real physical form, still propose the closest reasonable concrete visual (e.g. a laptop, a dashboard screen, an office desk) rather than an empty list.`;

async function reformulateQueries(request: ImageSourceRequest): Promise<string[]> {
  // A provider failure here degrades the same way a missing parsed_output
  // already did — fall back to the raw product name (below) rather than
  // throwing. Nothing about sourcing a product photo is worth surfacing an
  // AI-provider error to the merchant for; callGenesisModel already logs
  // the real failure server-side.
  const outcome = await callGenesisModel({
    model: "claude-opus-4-8",
    max_tokens: 1000,
    thinking: { type: "adaptive" },
    system: QUERY_REFORMULATION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Product name: ${request.name}\nDescription: ${request.description ?? "(none)"}`,
      },
    ],
    output_config: {
      effort: "low",
      format: zodOutputFormat(QueryReformulationSchema),
    },
  }, { ...request.scope, feature: "stock_image_query_reformulation" });
  if (!outcome.ok) return [];
  return outcome.message.parsed_output?.queries ?? [];
}

export const StockSearchProvider: ImageProvider = {
  kind: "stock",
  async source(request: ImageSourceRequest): Promise<ImageSourceResult | null> {
    const excluded = new Set(request.excludeUrls);
    const queries = await reformulateQueries(request);
    // Fall back to the raw name if Claude returned nothing usable, so a
    // transient reformulation failure doesn't fully block sourcing.
    const candidateQueries = queries.length > 0 ? queries : [request.name];

    for (const query of candidateQueries) {
      const photos = await searchPhotoCandidates(query, 5);
      const unseen = photos.find((url) => !excluded.has(url));
      if (unseen) {
        return { url: unseen, provider: "stock" };
      }
    }

    return null;
  },
};
