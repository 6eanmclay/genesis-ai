"use client";

// Real mobile bug fix (2026-08-08) — same real fix as CreateProductForm.tsx's
// own: this used to be a plain server-rendered <form> submitting a raw File
// directly in uploadProductImage's Server Action body, hard-capped by
// Vercel's platform-level 4.5MB Function payload ceiling regardless of
// next.config.ts's own bodySizeLimit. The file now uploads straight from
// this browser to Blob (same mechanism J4's chat uploads already use); the
// Server Action only ever receives the resulting URL.
import { useRef, useState } from "react";
import { upload as blobUpload } from "@vercel/blob/client";
import { uploadProductImage } from "../actions";
import { SubmitButton } from "../SubmitButton";

function randomAssetKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ProductPhotoUploadForm({ productId, hasExistingImage }: { productId: string; hasExistingImage: boolean }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setIsUploading(true);
    try {
      const extension = file.type.split("/")[1] === "jpeg" ? "jpg" : file.type.split("/")[1];
      const uploaded = await blobUpload(`products/${randomAssetKey()}.${extension}`, file, {
        access: "public",
        handleUploadUrl: "/api/blob/product-image-upload",
        contentType: file.type,
      });
      setImageUrl(uploaded.url);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Couldn't upload that image — please try again.");
      if (fileInputRef.current) fileInputRef.current.value = "";
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <form
      action={uploadProductImage.bind(null, productId)}
      onSubmit={(event) => {
        if (isUploading || !imageUrl) event.preventDefault();
      }}
      className="flex flex-col gap-1"
    >
      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
        {hasExistingImage ? "Change photo" : "Add photo"}
      </span>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFileChange}
        disabled={isUploading}
        className="w-full text-xs text-zinc-500 file:mr-1 file:rounded-full file:border-0 file:bg-black/[.05] file:px-3 file:py-2 file:text-xs file:font-medium file:text-black hover:file:bg-black/[.08] disabled:opacity-50 dark:text-zinc-400 dark:file:bg-white/[.1] dark:file:text-zinc-50 dark:hover:file:bg-white/[.15]"
      />
      {isUploading && <span className="text-xs text-zinc-500 dark:text-zinc-400">Uploading…</span>}
      {uploadError && <span className="text-xs text-red-600 dark:text-red-400">{uploadError}</span>}
      <input type="hidden" name="imageUrl" value={imageUrl ?? ""} />
      <SubmitButton
        pendingText="Saving..."
        className="w-full rounded-full bg-black\[.05] px-3 py-2 text-xs font-medium text-black hover:bg-black/[.08] disabled:opacity-50 dark:bg-white/[.1] dark:text-zinc-50 dark:hover:bg-white/[.15]"
      >
        Upload photo
      </SubmitButton>
    </form>
  );
}
