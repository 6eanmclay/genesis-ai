import { put } from "@vercel/blob";
import { randomUUID } from "crypto";
import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/prisma";
import { computeImageCost } from "@/lib/aiPricing";
import { businessIntentFor } from "@/lib/businessIntent";
import { growthCreditValueFor } from "@/lib/growthCreditCatalog";
import { recordActual, recordUnattributed, releaseReservation, reserveOne } from "@/lib/storage/ledger";
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
const MODEL = "gpt-image-1";

interface OpenAiImagesResponse {
  data?: { b64_json?: string }[];
}

// AI Cost & Usage Infrastructure, Milestone 3 — this was, before this
// milestone, the one real AI provider cost in the entire app with zero
// recording anywhere (confirmed by the research pass this system's own
// plan was built on). Mirrors lib/genesisModel.ts's recordUsage exactly:
// real cost from what actually happened (one successful generation = one
// real image), never estimated demand, awaited so the row is reliably
// written before a serverless function can exit, its own failure caught
// and never allowed to turn a real successful generation into a reported
// failure.
async function recordImageUsage(request: ImageSourceRequest, durationMs: number): Promise<string | null> {
  try {
    const event = await prisma.aiUsageEvent.create({
      data: {
        ...request.scope,
        inputTokens: 0,
        outputTokens: 0,
        feature: request.feature,
        provider: "openai",
        model: MODEL,
        imageCount: 1,
        durationMs,
        costUsd: computeImageCost(MODEL, 1),
        businessIntent: businessIntentFor(request.feature),
        growthCreditValue: growthCreditValueFor(request.feature),
      },
    });
    return event.id;
  } catch (err) {
    Sentry.captureException(err);
    return null;
  }
}

export const GeneratedImageProvider: ImageProvider = {
  kind: "generated",
  async source(request: ImageSourceRequest): Promise<ImageSourceResult | null> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    const startedAt = Date.now();
    let b64: string | undefined;
    try {
      const response = await fetch(OPENAI_IMAGES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
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

    // Recorded here, not after the Blob upload below — the real cost was
    // already incurred the moment OpenAI returned image bytes, regardless
    // of whether the subsequent upload succeeds. A failed upload still
    // means this function returns null (resolveProductImage falls through
    // to the next provider, same as any other failure), but the real
    // dollar spend already happened and must not go unrecorded because of
    // an unrelated storage error.
    const aiUsageEventId = await recordImageUsage(request, Date.now() - startedAt);

    // ============ THE LEDGER, BEFORE THE BLOB (Slice 3) ================
    //
    // storeId was never missing here — it has always been on request.scope,
    // which is spread straight into the AiUsageEvent row a few lines above.
    // Nothing new is threaded through the call chain; the context this needed
    // was already being carried past it.
    //
    // The union is the real subtlety. GenesisModelScope is { storeId } OR
    // { userId } OR an anonymous token, and onboarding generates imagery from
    // { userId } before a Store exists. Both cases get a ledger row; only the
    // first gets a reservation, because only the first has an allowance to
    // reserve against. See recordUnattributed for why that is not a guess.
    const bytes = Buffer.from(b64, "base64");
    const storeId = "storeId" in request.scope ? request.scope.storeId : null;
    const pathname = `products/${randomUUID()}.png`;

    let reservationId: string | null = null;
    if (storeId) {
      const reservation = await reserveOne(storeId, {
        name: pathname.slice("products/".length),
        prefix: "products/",
        source: "image.generated",
        // Known exactly: the bytes are already in hand before the upload.
        declaredBytes: bytes.length,
        contentType: "image/png",
      });
      if (!reservation.ok) {
        // Only reachable with enforcement on. Degrades to null like every other
        // failure in this provider, so resolveProductImage falls through rather
        // than crashing a chat turn — the convention this file opens with.
        return null;
      }
      reservationId = reservation.reservations[0].id;
    }

    try {
      const { url } = await put(pathname, bytes, {
        access: "public",
        contentType: "image/png",
        addRandomSuffix: false,
      });
      if (storeId && reservationId) {
        await recordActual({ id: reservationId, storeId, url, sizeInBytes: bytes.length, contentType: "image/png" });
      } else {
        await recordUnattributed({
          pathname,
          url,
          sizeInBytes: bytes.length,
          source: "image.generated.prestore",
          contentType: "image/png",
        });
      }
      return { url, provider: "generated", generationPrompt: request.prompt, aiUsageEventId };
    } catch {
      // The upload failed, so no bytes exist. Release the reservation rather
      // than leaving it to expire — a held reservation for an upload that will
      // never happen is space nobody can use and nobody can explain.
      if (storeId && reservationId) await releaseReservation(reservationId, storeId);
      return null;
    }
  },
};
