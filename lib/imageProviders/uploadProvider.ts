import { put } from "@vercel/blob";
import { randomUUID } from "crypto";
import type { ImageSourceResult } from "./types";

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
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB
export const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export async function uploadProductImageFile(file: File): Promise<ImageSourceResult> {
  const extension = ALLOWED_CONTENT_TYPES[file.type];
  if (!extension) {
    throw new Error("Please upload a PNG, JPEG, or WebP image.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("Image is too large — please upload a file under 8MB.");
  }

  const { url } = await put(`products/${randomUUID()}.${extension}`, file, {
    access: "public",
    contentType: file.type,
    addRandomSuffix: false,
  });

  return { url, provider: "upload" };
}
