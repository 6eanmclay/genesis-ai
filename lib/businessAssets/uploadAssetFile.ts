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
// Real bug (Sean, 2026-08-09, real-device report): a genuine photo
// ("IMG_8019.png") failed to upload. 8MB was never a platform constraint
// (see this file's own top comment — direct-to-Blob has no serverless
// body-limit ceiling) — it was just an arbitrary self-imposed cap, and
// PNG in particular has no lossy compression, so a modern phone's
// full-resolution photo or a long screenshot can easily clear 8MB while
// still being a completely ordinary file. Raised to match the precedent
// already set for voice memos (lib/voice/voiceMemoFile.ts's own 20MB).
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB
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
// DOCX (2026-08-09) — "if Genesis is intended to accept documents/
// knowledge files, .docx needs to be supported" (Sean, after a real
// upload — a workbook chapter file — was silently rejected as
// "unsupported type"). Genuinely supported end-to-end, not just allow-
// listed: classify.ts extracts real text from the file (via mammoth)
// before it's ever shown to Claude, since Anthropic's own document
// content blocks don't read .docx natively (confirmed against their
// current docs — binary formats like .docx must be converted to text or
// PDF first, unlike PDF's own native block support).
export const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

// Content types classified as a real document (readable text/pages), not
// a photo — everything else in ALLOWED_CONTENT_TYPES is an image type.
const DOCUMENT_CONTENT_TYPES = new Set<string>(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);

// Real, well-known mobile-browser gotcha (2026-08-09) — File.type is not
// always reliable: some mobile browsers/OS share-sheet flows report an
// empty string, or a generic type like "application/octet-stream", for a
// genuinely ordinary photo. Extension-based fallback, checked only when
// the browser's own reported type isn't already a real match, so this
// never overrides a type the browser DID report correctly.
const EXTENSION_CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// Resolves a File to one of ALLOWED_CONTENT_TYPES' own keys, trusting the
// browser-reported type first and falling back to the filename's own
// extension only when that type isn't already a real match. Returns null
// when neither signal resolves to a supported type — the real "genuinely
// unsupported file" case, unchanged from before this fix.
export function resolveAssetContentType(file: { type: string; name: string }): string | null {
  // hasOwnProperty on both lookups (2026-08-22), and the second one was
  // genuinely reachable: `ext` comes from the FILENAME, so a file called
  // "notes.constructor" made `EXTENSION_CONTENT_TYPE[ext]` resolve to the
  // inherited Object constructor. That is truthy, so `?? null` never fired and
  // this returned a FUNCTION — from a signature that promises `string | null`.
  // Instead of being cleanly refused as an unsupported file, it went on into
  // the upload carrying that as its content type.
  //
  // The first lookup is the same shape against a browser-reported type. A real
  // browser will not report "constructor", but this function's whole reason for
  // existing is that File.type cannot be trusted — so it should not be trusted
  // to be a plausible MIME string either. Note what the truthy branch does:
  // it returns `file.type` VERBATIM, so a prototype key would have been handed
  // back as an allowed content type.
  if (Object.prototype.hasOwnProperty.call(ALLOWED_CONTENT_TYPES, file.type)) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!ext || !Object.prototype.hasOwnProperty.call(EXTENSION_CONTENT_TYPE, ext)) return null;
  const fallback = EXTENSION_CONTENT_TYPE[ext];
  return typeof fallback === "string" ? fallback : null;
}

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
    throw new Error("Please upload a PNG, JPEG, WebP, HEIC, DOCX, or PDF file.");
  }
  return {
    url: uploaded.url,
    originalFilename: uploaded.originalFilename,
    fileType: DOCUMENT_CONTENT_TYPES.has(uploaded.contentType) ? "document" : "photo",
  };
}
