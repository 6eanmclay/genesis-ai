"use client";

import { useRef, useState } from "react";
import { upload as blobUpload } from "@vercel/blob/client";
import { mapWithConcurrency } from "@/lib/concurrency";
import { createProduct } from "../actions";
import { SubmitButton } from "../SubmitButton";
import { useActionFormState } from "../useActionFormState";

const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";

const MAX_IMAGES = 10;
const UPLOAD_CONCURRENCY = 4;

function randomAssetKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function uploadOneToBlob(file: File): Promise<string> {
  const rawExt = file.type.split("/")[1] ?? "jpg";
  const extension = rawExt === "jpeg" ? "jpg" : rawExt;
  const uploaded = await blobUpload(`products/${randomAssetKey()}.${extension}`, file, {
    access: "public",
    handleUploadUrl: "/api/blob/product-image-upload",
    contentType: file.type,
  });
  return uploaded.url;
}

export function CreateProductForm() {
  const { state, formAction, resetKey } = useActionFormState(createProduct);
  // Real mobile bug fix (2026-08-08) — a real phone photo routinely clears
  // Vercel's own hard, non-configurable 4.5MB Function request-body ceiling
  // (confirmed against Vercel's current docs; next.config.ts's own
  // bodySizeLimit only governs a lower, Next-side layer that never gets a
  // chance to run above that). Every file now uploads straight from this
  // browser to Vercel Blob (same real, already-proven mechanism J4's own
  // chat uploads use) — this form's own Server Action submission carries
  // only the resulting URLs, short strings, never any file's bytes.
  //
  // Product media gallery (2026-08-08) — multi-select from the start
  // ("the upload flow must support selecting multiple images at once...
  // do not make the 10-image feature dependent on uploading images one at
  // a time," Sean's own words): every image chosen here becomes a real
  // ProductImage row the moment the product is created, not something the
  // owner has to separately add afterward on the Products list.
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ succeeded: number; total: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isUploading = uploadProgress !== null;

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).slice(0, MAX_IMAGES - imageUrls.length);
    event.target.value = "";
    if (files.length === 0) return;

    setUploadError(null);
    setUploadProgress({ succeeded: 0, total: files.length });
    const newUrls: string[] = [];
    const failures: string[] = [];
    let succeeded = 0;
    await mapWithConcurrency(files, UPLOAD_CONCURRENCY, uploadOneToBlob, (index, result) => {
      if (result.ok) {
        newUrls.push(result.value);
        succeeded += 1;
      } else {
        failures.push(files[index].name);
      }
      setUploadProgress({ succeeded, total: files.length });
    });
    setUploadProgress(null);
    if (newUrls.length > 0) setImageUrls((prev) => [...prev, ...newUrls]);
    if (failures.length > 0) setUploadError(`Couldn't upload: ${failures.join(", ")}.`);
  }

  return (
    <form
      key={resetKey}
      action={formAction}
      // SubmitButton derives its own disabled state from useFormStatus()
      // and has no external `disabled` prop to drive from isUploading —
      // guarding the submit event itself here is the real way to stop a
      // fast tap from submitting before every photo's real URL exists,
      // without changing the shared SubmitButton component.
      onSubmit={(event) => {
        if (isUploading) event.preventDefault();
      }}
      className="mt-4 flex max-w-md flex-col gap-4"
    >
      <input
        name="name"
        type="text"
        defaultValue={!state.ok ? state.values?.name : undefined}
        placeholder="Product name"
        required
        className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <textarea
        name="description"
        defaultValue={!state.ok ? state.values?.description : undefined}
        placeholder="Description (optional)"
        rows={3}
        className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <input
        name="price"
        type="number"
        step="0.01"
        min="0"
        defaultValue={!state.ok ? state.values?.price : undefined}
        placeholder="Price (e.g. 19.99)"
        required
        className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-black dark:text-zinc-50">Photos (optional, up to {MAX_IMAGES})</span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          Upload your own — if you leave this blank, Genesis will generate one for you to review. The first photo
          becomes the primary image; more can be added and reordered later.
        </span>
        {imageUrls.length < MAX_IMAGES && (
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={handleFileChange}
            disabled={isUploading}
            className="mt-1 w-full rounded-lg border border-black/[.08] px-4 py-3 text-sm text-zinc-600 file:mr-3 file:rounded-full file:border-0 file:bg-black/[.05] file:px-4 file:py-2 file:text-sm file:font-medium file:text-black hover:file:bg-black/[.08] disabled:opacity-50 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-300 dark:file:bg-white/[.1] dark:file:text-zinc-50 dark:hover:file:bg-white/[.15]"
          />
        )}
        {uploadProgress && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Uploading {uploadProgress.succeeded}/{uploadProgress.total}…
          </span>
        )}
        {imageUrls.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {imageUrls.map((url, i) => (
              <div key={url} className="relative h-16 w-16 overflow-hidden rounded-lg">
                {/* eslint-disable-next-line @next/next/no-img-element -- Vercel Blob is an arbitrary per-deployment host next/image can't optimize without ongoing config, same reasoning as every other Blob-sourced image in this app */}
                <img src={url} alt="" className="h-full w-full object-cover" />
                {i === 0 && (
                  <span className="absolute left-0.5 top-0.5 rounded-full bg-black/60 px-1 py-0.5 text-[8px] font-medium text-white">
                    Primary
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setImageUrls((prev) => prev.filter((u) => u !== url))}
                  aria-label="Remove this photo"
                  className="absolute bottom-0.5 right-0.5 rounded-full bg-black/60 px-1.5 text-xs text-white"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        {uploadError && <span className="text-xs text-red-600 dark:text-red-400">{uploadError}</span>}
      </label>
      {/* The Server Action receives only these real, already-uploaded URLs
          — never any file itself. Empty array (nothing submitted) when no
          photos were chosen, matching the field's own "optional" design. */}
      <input type="hidden" name="imageUrls" value={JSON.stringify(imageUrls)} />
      <SubmitButton pendingText="Adding..." className={`mt-2 px-5 py-2 ${ACCENT_BUTTON}`}>
        Add product
      </SubmitButton>
      {!state.ok && <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
    </form>
  );
}
