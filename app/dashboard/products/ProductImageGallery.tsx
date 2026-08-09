"use client";

// Product media gallery (2026-08-08) — "a proper product media gallery,
// not ten separate unrelated upload buttons" (Sean). Replaces the old
// single-photo ProductPhotoUploadForm.tsx (now deleted) with real support
// for up to 10 ordered images: multi-select add, per-image replace/delete,
// and reorder via move-left/move-right (not pointer/touch drag-and-drop —
// there's no drag library in this codebase and real touch-drag reliability
// is a genuine, unverified risk; buttons give the identical outcome with
// guaranteed behavior on both mobile and desktop). Every upload here goes
// straight from this browser to Vercel Blob (same real mechanism the
// mobile upload-bug fix already proved out) — the Server Actions this
// calls only ever receive already-final URLs, never file bytes, so this
// UI can never reintroduce the platform 4.5MB body-limit failure.
//
// Lightbox (2026-08-09) — "I have to hit the little arrow every single
// time... I want the gallery to behave like a modern image gallery" (Sean),
// made concrete by a real need: J4 can now propose product-photo changes,
// and the owner has to actually inspect a photo before approving it. Tap
// any thumbnail to open it large, drag/swipe to move between images — the
// tiny per-thumbnail arrows stay exactly where they are, as secondary
// reorder controls, never the only way to browse.
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload as blobUpload } from "@vercel/blob/client";
import { mapWithConcurrency } from "@/lib/concurrency";
import { addProductImages, reorderProductImages, deleteProductImage, replaceProductImage } from "../actions";
import { ImageLightbox } from "../ImageLightbox";

const MAX_IMAGES = 10;

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

// A real concurrency cap, matching UploadAssetButton's own reasoning
// (app/j4/J4Workspace.tsx) — each Blob upload also invokes a serverless
// function to authenticate it, so a real multi-select of several photos
// stays throttled rather than firing all at once.
const UPLOAD_CONCURRENCY = 4;

export type GalleryImage = { id: string; url: string; position: number };

export function ProductImageGallery({ productId, images }: { productId: string; images: GalleryImage[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ succeeded: number; total: number } | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetId = useRef<string | null>(null);

  const ordered = [...images].sort((a, b) => a.position - b.position);
  const remainingSlots = MAX_IMAGES - ordered.length;

  function runMutation(task: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await task();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong — please try again.");
      }
    });
  }

  async function handleAddFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).slice(0, remainingSlots);
    event.target.value = "";
    if (files.length === 0) return;

    setError(null);
    setUploadProgress({ succeeded: 0, total: files.length });
    startTransition(async () => {
      const urls: string[] = [];
      const failures: string[] = [];
      let succeeded = 0;
      await mapWithConcurrency(files, UPLOAD_CONCURRENCY, uploadOneToBlob, (index, result) => {
        if (result.ok) {
          urls.push(result.value);
          succeeded += 1;
        } else {
          failures.push(files[index].name);
        }
        setUploadProgress({ succeeded, total: files.length });
      });
      setUploadProgress(null);

      if (urls.length > 0) {
        try {
          await addProductImages(productId, urls);
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Something went wrong — please try again.");
          return;
        }
      }
      if (failures.length > 0) {
        setError(`Couldn't upload: ${failures.join(", ")}.`);
      }
    });
  }

  function handleReplaceFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const imageId = replaceTargetId.current;
    event.target.value = "";
    if (!file || !imageId) return;
    runMutation(async () => {
      const url = await uploadOneToBlob(file);
      await replaceProductImage(imageId, url);
    });
  }

  function moveImage(imageId: string, direction: -1 | 1) {
    const index = ordered.findIndex((img) => img.id === imageId);
    const targetIndex = index + direction;
    if (index === -1 || targetIndex < 0 || targetIndex >= ordered.length) return;
    const reordered = [...ordered];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    runMutation(() => reorderProductImages(productId, reordered.map((img) => img.id)));
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
        Photos ({ordered.length}/{MAX_IMAGES})
      </span>

      {ordered.length === 0 ? (
        <div className="flex h-20 w-20 items-center justify-center rounded-lg bg-black/[.03] text-center text-[11px] text-zinc-400 dark:bg-white/[.05]">
          No image
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {ordered.map((image, i) => (
            <div key={image.id} className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-black/[.03] dark:bg-white/[.05]">
              {/* Tap to inspect large — the primary way to browse now.
                  Listener lives on the image itself, not the wrapping div,
                  so a tap on any of the overlay buttons below (siblings,
                  not descendants of this img) never also opens the
                  lightbox. */}
              {/* eslint-disable-next-line @next/next/no-img-element -- Vercel Blob is an arbitrary per-deployment host next/image can't optimize without ongoing config, same reasoning as every other Blob-sourced image in this app */}
              <img
                src={image.url}
                alt=""
                onClick={() => setLightboxIndex(i)}
                className="h-full w-full cursor-zoom-in object-cover"
              />
              {i === 0 && (
                <span className="pointer-events-none absolute left-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[9px] font-medium text-white">
                  Primary
                </span>
              )}
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-0.5 bg-black/60 px-1 py-0.5">
                <button
                  type="button"
                  disabled={isPending || i === 0}
                  onClick={() => moveImage(image.id, -1)}
                  aria-label="Move earlier"
                  title="Move earlier"
                  className="px-1 text-xs text-white disabled:opacity-30"
                >
                  ◀
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    replaceTargetId.current = image.id;
                    replaceInputRef.current?.click();
                  }}
                  aria-label="Replace this image"
                  title="Replace"
                  className="px-1 text-xs text-white disabled:opacity-30"
                >
                  ⟳
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => runMutation(() => deleteProductImage(image.id))}
                  aria-label="Delete this image"
                  title="Delete"
                  className="px-1 text-xs text-white disabled:opacity-30"
                >
                  ✕
                </button>
                <button
                  type="button"
                  disabled={isPending || i === ordered.length - 1}
                  onClick={() => moveImage(image.id, 1)}
                  aria-label="Move later"
                  title="Move later"
                  className="px-1 text-xs text-white disabled:opacity-30"
                >
                  ▶
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {remainingSlots > 0 && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={handleAddFiles}
            disabled={isPending}
            className="hidden"
          />
          <button
            type="button"
            disabled={isPending}
            onClick={() => fileInputRef.current?.click()}
            className="w-fit rounded-full bg-black/[.05] px-3 py-1.5 text-xs font-medium text-black hover:bg-black/[.08] disabled:opacity-50 dark:bg-white/[.1] dark:text-zinc-50 dark:hover:bg-white/[.15]"
          >
            {ordered.length === 0 ? "Add photos" : `Add up to ${remainingSlots} more`}
          </button>
        </>
      )}

      {/* Hidden, shared across every thumbnail's own Replace button —
          replaceTargetId.current names which image the next file picked
          here is for. */}
      <input ref={replaceInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleReplaceFile} className="hidden" />

      {uploadProgress && uploadProgress.total > 0 && (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          Uploading {uploadProgress.succeeded}/{uploadProgress.total}…
        </span>
      )}
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}

      {lightboxIndex !== null && (
        <ImageLightbox images={ordered} startIndex={lightboxIndex} onClose={() => setLightboxIndex(null)} />
      )}
    </div>
  );
}
