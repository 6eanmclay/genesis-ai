"use client";

import { useRef, useState } from "react";
import { upload as blobUpload } from "@vercel/blob/client";
import { createProduct } from "../actions";
import { SubmitButton } from "../SubmitButton";
import { useActionFormState } from "../useActionFormState";

const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";

function randomAssetKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function CreateProductForm() {
  const { state, formAction, resetKey } = useActionFormState(createProduct);
  // Real mobile bug fix (2026-08-08) — a real phone photo routinely clears
  // Vercel's own hard, non-configurable 4.5MB Function request-body ceiling
  // (confirmed against Vercel's current docs; next.config.ts's own
  // bodySizeLimit only governs a lower, Next-side layer that never gets a
  // chance to run above that). The file now uploads straight from this
  // browser to Vercel Blob (same real, already-proven mechanism J4's own
  // chat uploads use — see app/api/blob/product-image-upload/route.ts) —
  // this form's own Server Action submission carries only the resulting
  // URL, a short string, never the file's bytes.
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
      key={resetKey}
      action={formAction}
      // SubmitButton derives its own disabled state from useFormStatus()
      // and has no external `disabled` prop to drive from isUploading —
      // guarding the submit event itself here is the real way to stop a
      // fast tap from submitting before the photo's real URL exists,
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
        <span className="text-sm font-medium text-black dark:text-zinc-50">Photo (optional)</span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          Upload your own — if you leave this blank, Genesis will generate one for you to review.
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={handleFileChange}
          disabled={isUploading}
          className="mt-1 w-full rounded-lg border border-black/[.08] px-4 py-3 text-sm text-zinc-600 file:mr-3 file:rounded-full file:border-0 file:bg-black/[.05] file:px-4 file:py-2 file:text-sm file:font-medium file:text-black hover:file:bg-black/[.08] disabled:opacity-50 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-300 dark:file:bg-white/[.1] dark:file:text-zinc-50 dark:hover:file:bg-white/[.15]"
        />
        {isUploading && <span className="text-xs text-zinc-500 dark:text-zinc-400">Uploading…</span>}
        {imageUrl && !isUploading && (
          /* eslint-disable-next-line @next/next/no-img-element -- Vercel Blob is an arbitrary per-deployment host next/image can't optimize without ongoing config, same reasoning as every other Blob-sourced image in this app */
          <img src={imageUrl} alt="" className="mt-1 h-20 w-20 rounded-lg object-cover" />
        )}
        {uploadError && <span className="text-xs text-red-600 dark:text-red-400">{uploadError}</span>}
      </label>
      {/* The Server Action receives only this real, already-uploaded URL —
          never the file itself. Empty string (not submitted at all) when
          no photo was chosen, matching the field's own "optional" design;
          createProduct treats an empty/missing value exactly like the old
          empty file input did. */}
      <input type="hidden" name="imageUrl" value={imageUrl ?? ""} />
      <SubmitButton pendingText="Adding..." className={`mt-2 px-5 py-2 ${ACCENT_BUTTON}`}>
        Add product
      </SubmitButton>
      {!state.ok && <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
    </form>
  );
}
