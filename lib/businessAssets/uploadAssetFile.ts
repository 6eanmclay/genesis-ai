import { put } from "@vercel/blob";
import { randomUUID } from "crypto";

// Business Assets M1 — generalizes lib/imageProviders/uploadProvider.ts's
// uploadProductImageFile for the same real Vercel Blob mechanism, but for
// any owner-uploaded business file, not just product photos. That function
// stays untouched — products keep their own path/behavior (direct write to
// Product.imageUrl, no BusinessRecord involved). This one always produces a
// BusinessRecord (via ingest.ts), never a Product field.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB
const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export interface UploadedAssetFile {
  url: string;
  originalFilename: string;
  fileType: "photo" | "document";
}

export async function uploadAssetFile(file: File): Promise<UploadedAssetFile> {
  const extension = ALLOWED_CONTENT_TYPES[file.type];
  if (!extension) {
    throw new Error("Please upload a PNG, JPEG, WebP, or PDF file.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("File is too large — please upload something under 8MB.");
  }

  const { url } = await put(`assets/${randomUUID()}.${extension}`, file, {
    access: "public",
    contentType: file.type,
    addRandomSuffix: false,
  });

  return {
    url,
    originalFilename: file.name,
    fileType: file.type === "application/pdf" ? "document" : "photo",
  };
}
