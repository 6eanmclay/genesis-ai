import type { GenesisModelScope } from "@/lib/genesisModel";
import type { AiFeature } from "@/lib/aiFeatures";

// The common interface every image source conforms to — generated,
// stock-searched, or uploaded — so the rest of the app (approval flow,
// Product.imageUrl writes, the "couldn't find/generate" messaging) never
// needs to know or care which one produced a given URL. Deliberately not
// three unrelated functions with different signatures: the whole point of
// this pass is that resolveProductImage (see resolveProductImage.ts) can
// try providers in order and treat every result identically.
//
// `prompt` is the primary generation/search input — for a product, this is
// ProductBlueprintSchema.imagePrompt (already AI-authored at generation
// time, previously only ever used as an extra stock-search query — see
// StockSearchProvider's own comment). `name`/`description` stay available
// for providers that still benefit from them (stock search's query
// reformulation step genuinely uses both).
export interface ImageSourceRequest {
  prompt: string;
  name: string;
  description: string | null;
  excludeUrls: string[];
  // Track 0 — AI cost governance. Only StockSearchProvider's query
  // reformulation step actually calls callGenesisModel today
  // (GeneratedImageProvider calls OpenAI directly), but this lives on the
  // shared request shape so every caller supplies it once, not per-provider.
  scope: GenesisModelScope;
  // AI Cost & Usage Infrastructure, Milestone 3 — what this image is
  // actually for (see lib/aiFeatures.ts), so GeneratedImageProvider can
  // record a real, correctly-tagged AiUsageEvent row for the one AI
  // provider cost in this app that had zero cost tracking before this
  // milestone. Required for the same reason GenesisModelContext.feature
  // is required — a missing tag here is exactly the gap this system exists
  // to close.
  feature: AiFeature;
}

export type ImageProviderKind = "generated" | "stock" | "upload";

export interface ImageSourceResult {
  url: string;
  provider: ImageProviderKind;
  // Unsplash's own guidelines ask for photographer/source attribution
  // where the photo is used — generated and uploaded images have no such
  // requirement, so this stays optional and provider-specific rather than
  // forcing every provider to invent one.
  attribution?: string;
  // The exact prompt actually sent to the generation model — set only by
  // GeneratedImageProvider. Callers that persist an image sourced this way
  // (see ai-actions.ts's update_product_image call sites and
  // updateProductImageExecutable) carry this into Product.richContent's
  // imagePrompt, so a generated image's provenance survives past the
  // initial call rather than being discarded once the URL is in hand.
  generationPrompt?: string;
}

export interface ImageProvider {
  readonly kind: ImageProviderKind;
  source(request: ImageSourceRequest): Promise<ImageSourceResult | null>;
}
