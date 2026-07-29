import type { ImageProvider, ImageSourceRequest, ImageSourceResult } from "./types";
import { StockSearchProvider } from "./stockSearchProvider";

// The one place that decides which provider to try, and in what order —
// every call site that needs a product image goes through this now,
// instead of reaching for a specific provider directly. Providers are
// tried in sequence; the first real result wins. Today's default order is
// stock-only (StockSearchProvider), identical to pre-existing behavior —
// GeneratedImageProvider slots in at the front of DEFAULT_PROVIDER_ORDER
// the moment a real generation API is wired up (see this file's own
// tracking comment), making generation the primary path and stock search
// the fallback, per explicit direction. Nothing about this orchestrator
// itself needs to change when that happens.
//
// TODO(image-generation): once GeneratedImageProvider exists, prepend it
// here: [GeneratedImageProvider, StockSearchProvider].
//
// Decided (not yet implemented — blocked on OPENAI_API_KEY, a genuinely
// new dependency; this project has never called OpenAI before):
// - Provider: OpenAI gpt-image-1. New env var OPENAI_API_KEY.
// - Input: request.prompt (ProductBlueprintSchema.imagePrompt), same as
//   every other provider here — no separate generation-specific prompt
//   field.
// - The generation prompt actually sent to the API must be preserved
//   alongside the resulting image, not discarded once the call returns —
//   ImageSourceResult likely needs a field for this (e.g. a `prompt`
//   string, parallel to the existing optional `attribution`) so a
//   generated image's provenance survives past the initial call, the same
//   way stock images already carry attribution. Decide the exact shape
//   when implementing, not speculatively added now.
const DEFAULT_PROVIDER_ORDER: ImageProvider[] = [StockSearchProvider];

export async function resolveProductImage(
  request: ImageSourceRequest,
  providers: ImageProvider[] = DEFAULT_PROVIDER_ORDER
): Promise<ImageSourceResult | null> {
  for (const provider of providers) {
    const result = await provider.source(request);
    if (result) return result;
  }
  return null;
}
