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
}

export interface ImageProvider {
  readonly kind: ImageProviderKind;
  source(request: ImageSourceRequest): Promise<ImageSourceResult | null>;
}
