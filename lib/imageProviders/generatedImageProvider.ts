import { put } from "@vercel/blob";
import { randomUUID } from "crypto";
import type { ImageProvider, ImageSourceRequest, ImageSourceResult } from "./types";

// Genesis's primary product-image source (per explicit direction: Genesis
// should create original imagery whenever possible, consistent with its
// role as a business creator rather than a stock-photo search engine —
// see resolveProductImage.ts's DEFAULT_PROVIDER_ORDER). OpenAI's gpt-image-1
// always returns base64-encoded bytes, never a URL (verified directly
// against OpenAI's docs — response_format isn't a supported param for this
// model the way it is for dall-e-2/3), so every real result here requires
// an upload step to get back a stable, storefront-servable URL — Vercel
// Blob, since this project has no other image-storage infrastructure and
// is already Vercel-hosted.
//
// Same "degrade to null, never throw" convention as StockSearchProvider —
// a missing key, a moderation rejection, or a transient API failure just
// means resolveProductImage falls through to stock search next, not a
// crashed chat turn.
const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";

interface OpenAiImagesResponse {
  data?: { b64_json?: string }[];
}

export const GeneratedImageProvider: ImageProvider = {
  kind: "generated",
  async source(request: ImageSourceRequest): Promise<ImageSourceResult | null> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    let b64: string | undefined;
    try {
      const response = await fetch(OPENAI_IMAGES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt: request.prompt,
          size: "1024x1024",
          quality: "high",
          n: 1,
          output_format: "png",
        }),
      });
      if (!response.ok) return null;

      const json = (await response.json()) as OpenAiImagesResponse;
      b64 = json.data?.[0]?.b64_json;
    } catch {
      return null;
    }
    if (!b64) return null;

    try {
      const { url } = await put(`products/${randomUUID()}.png`, Buffer.from(b64, "base64"), {
        access: "public",
        contentType: "image/png",
        addRandomSuffix: false,
      });
      return { url, provider: "generated", generationPrompt: request.prompt };
    } catch {
      return null;
    }
  },
};
