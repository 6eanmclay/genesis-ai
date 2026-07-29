import type { ImageProvider, ImageSourceRequest, ImageSourceResult } from "./types";
import { StockSearchProvider } from "./stockSearchProvider";
import { GeneratedImageProvider } from "./generatedImageProvider";

// The one place that decides which provider to try, and in what order —
// every call site that needs a product image goes through this now,
// instead of reaching for a specific provider directly. Providers are
// tried in sequence; the first real result wins. Generation is primary
// (OpenAI gpt-image-1 — Genesis creates original imagery whenever
// possible, per explicit direction, rather than defaulting to a
// stock-photo search engine); stock search is the fallback for whenever
// generation degrades to null (missing/invalid key, moderation rejection,
// a transient API failure — see GeneratedImageProvider's own comment).
const DEFAULT_PROVIDER_ORDER: ImageProvider[] = [GeneratedImageProvider, StockSearchProvider];

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
