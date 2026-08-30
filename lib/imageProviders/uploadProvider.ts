import { put } from "@vercel/blob";
import { randomUUID } from "crypto";
import type { ImageSourceResult } from "./types";
import {
  recordActual,
  recordUnattributed,
  releaseReservation,
  reserveOne,
  StorageRefusedError,
} from "@/lib/storage/ledger";

// The manual path — deliberately NOT part of resolveProductImage's
// try-in-sequence chain (generated -> stock). There's no prompt to
// generate/search from here; the owner already picked the exact file, so
// there's nothing to "resolve." Used directly by
// app/dashboard/actions.ts's uploadProductImage, which — per explicit
// direction — writes straight to Product.imageUrl, bypassing the
// ApprovalRequest workflow entirely. Genesis-generated and stock-sourced
// images keep going through approval; a manual upload is the owner's own
// direct decision about their own business, not something Genesis needs
// to propose back to them.
// Exported (2026-08-08) — the product media gallery's own direct-to-Blob
// upload token route (app/api/blob/product-image-upload/route.ts) reuses
// these exact same real limits rather than inventing a second, possibly-
// drifting set. uploadProductImageFile below is otherwise unchanged and
// stays exactly as it was — still the real path app/onboarding/actions.ts
// uses for pre-launch artwork upload, deliberately untouched by the
// Products-page migration to direct-to-Blob (see that migration's own
// comments for why this function itself was structurally the bug: any
// caller that still routes bytes through a Server Action body inherits
// Vercel's real 4.5MB platform ceiling regardless of this file's own 8MB
// check, which never gets the chance to run above that).
// Real bug (2026-08-09) — see lib/businessAssets/uploadAssetFile.ts's own
// matching comment: 8MB was an arbitrary self-imposed cap, not a real
// platform ceiling, and rejected genuinely ordinary photos (PNG especially
// — no lossy compression). Raised to match that same fix.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB
export const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * @param storeId The business this file belongs to, or null when there is not
 *   one yet. REQUIRED AND EXPLICIT rather than optional: its only caller today
 *   is onboarding's pre-launch artwork upload, which genuinely runs before a
 *   Store row exists, and a parameter that could be forgotten would make the
 *   next caller's missing attribution silent. Passing null is a statement.
 */
export async function uploadProductImageFile(
  file: File,
  storeId: string | null,
): Promise<ImageSourceResult> {
  const extension = ALLOWED_CONTENT_TYPES[file.type];
  if (!extension) {
    throw new Error("Please upload a PNG, JPEG, or WebP image.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("Image is too large — please upload a file under 20MB.");
  }

  const pathname = `products/${randomUUID()}.${extension}`;
  // file.size is the real byte count, known before the upload — so this is a
  // reservation for exactly what will land, not a ceiling.
  let reservationId: string | null = null;
  if (storeId) {
    const reservation = await reserveOne(storeId, {
      name: pathname.slice("products/".length),
      prefix: "products/",
      source: "image.upload",
      declaredBytes: file.size,
      contentType: file.type,
    });
    if (!reservation.ok) throw new StorageRefusedError(reservation.reason, reservation.usage.allowanceBytes);
    reservationId = reservation.reservations[0].id;
  }

  try {
    const { url } = await put(pathname, file, {
      access: "public",
      contentType: file.type,
      addRandomSuffix: false,
    });
    if (storeId && reservationId) {
      await recordActual({ id: reservationId, storeId, url, sizeInBytes: file.size, contentType: file.type });
    } else {
      await recordUnattributed({
        pathname,
        url,
        sizeInBytes: file.size,
        source: "image.upload.prestore",
        contentType: file.type,
      });
    }
    return { url, provider: "upload" };
  } catch (error) {
    // ============ A FAILED PERMANENT UPLOAD STAYS ACCOUNTED FOR ======
    //
    // The reservation is released because no bytes landed, so holding space for
    // them would be wrong. What is NOT done is swallowing the failure: it is
    // rethrown, so the owner is told their photo did not upload rather than
    // finding a product with no picture later.
    if (storeId && reservationId) await releaseReservation(reservationId, storeId);
    throw error;
  }
}
