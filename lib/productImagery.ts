import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { searchPhotoCandidates } from "./unsplash";

const anthropic = new Anthropic();

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
  const stream = anthropic.messages.stream({
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
  const message = await stream.finalMessage();
  return message.parsed_output?.queries ?? [];
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
