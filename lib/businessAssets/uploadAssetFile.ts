// Business Assets M1 — generalizes lib/imageProviders/uploadProvider.ts's
// uploadProductImageFile for the same real Vercel Blob mechanism, but for
// any owner-uploaded business file, not just product photos. That function
// stays untouched — products keep their own path/behavior (direct write to
// Product.imageUrl, no BusinessRecord involved). This one always produces a
// BusinessRecord (via ingest.ts), never a Product field.
//
// Beta 1 bug #2 (2026-08-06) — a real iPhone photo (5.5MB) still failed
// after raising Next's Server Actions body limit, because Vercel's own
// platform-level Serverless Function payload ceiling (~4.5MB, confirmed via
// production logs showing the request rejected at the routing layer before
// ever reaching our function) sits in front of Next's own config and isn't
// something next.config.ts can raise. The real fix moves the byte transfer
// itself client-side: the browser uploads directly to Vercel Blob via
// @vercel/blob/client's upload() + app/api/blob/business-asset-upload's
// handleUpload, and only the resulting small Blob URL ever passes through a
// Server Action body. This file has no server-only imports left (no `put`,
// no `crypto`) specifically so GenesisAssistant.tsx (a client component)
// can safely import MAX_UPLOAD_BYTES/ALLOWED_CONTENT_TYPES from it too —
// client and server now validate against the exact same constants.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB
// image/heic and image/heif (2026-08-07, iPhone photo upload investigation)
// — iOS's own default camera format since iOS 11. Safari usually transcodes
// this to JPEG automatically before an <input type="file"> ever sees it, but
// that behavior isn't universal across iOS versions and capture paths — when
// it doesn't happen, the raw file.type really is "image/heic", and this
// allowlist was hard-rejecting a perfectly real photo with a "wrong file
// type" message. Genesis's own classification already degrades honestly
// when it can't read an image (see classifyAndExtractAsset's "I wasn't able
// to take a proper look at it" fallback), so accepting the raw bytes here is
// safe even before there's a real client-side re-encode step.
export const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

export interface UploadedAssetFile {
  url: string;
  originalFilename: string;
  fileType: "photo" | "document";
}

// Called after the browser has already put the real bytes in Blob storage
// (see the comment above) — this only ever validates and reshapes metadata,
// the same contentType check this file used to do before writing the blob,
// kept here rather than trusted blindly from the client.
export function finalizeUploadedAssetFile(uploaded: {
  url: string;
  originalFilename: string;
  contentType: string;
}): UploadedAssetFile {
  if (!ALLOWED_CONTENT_TYPES[uploaded.contentType]) {
    throw new Error("Please upload a PNG, JPEG, WebP, HEIC, or PDF file.");
  }
  return {
    url: uploaded.url,
    originalFilename: uploaded.originalFilename,
    fileType: uploaded.contentType === "application/pdf" ? "document" : "photo",
  };
}
