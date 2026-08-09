"use client";

// Product media gallery (2026-08-08) — "a proper product media gallery,
// not ten separate unrelated upload buttons" (Sean). Replaces the old
// single-photo ProductPhotoUploadForm.tsx (now deleted) with real support
// for up to 10 ordered images: multi-select add, per-image replace/delete,
// plus real drag-and-drop reorder. Every upload here goes straight from
// this browser to Vercel Blob (same real mechanism the mobile upload-bug
// fix already proved out) — the Server Actions this calls only ever
// receive already-final URLs, never file bytes, so this UI can never
// reintroduce the platform 4.5MB body-limit failure.
//
// Lightbox (2026-08-09) — "I have to hit the little arrow every single
// time... I want the gallery to behave like a modern image gallery" (Sean),
// made concrete by a real need: J4 can now propose product-photo changes,
// and the owner has to actually inspect a photo before approving it. Tap
// any thumbnail to open it large, drag/swipe to move between images.
//
// Real drag-and-drop (2026-08-09) — "true mobile drag-and-drop reordering
// ... touch drag must work ... the dragged image must visibly move ...
// dropping it before/after another image must actually change the order"
// (Sean, from real mobile + desktop testing — arrow-only reorder was never
// enough). @dnd-kit is a real, purpose-built, actively-maintained toolkit
// for exactly this (touch/mouse/keyboard sensors, accessible, well past
// 1.0) — reinventing pointer-drag physics by hand here would be the
// "genuine, unverified risk" this file's own original comment warned
// against, not a fix for it. Arrows stay as a secondary, always-reliable
// fallback (keyboard users, precision nudges), never the primary way to
// reorder again.
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload as blobUpload } from "@vercel/blob/client";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  useSensor,
  useSensors,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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

// One thumbnail, draggable via @dnd-kit's useSortable. listeners/attributes
// go on the whole tile (not a separate handle) — dnd-kit's own distance/
// delay activation constraints (set on the sensors below) are what let a
// plain tap still reach the image's onClick or a button's onClick
// normally; only a real drag gesture past that threshold claims the
// pointer. touch-none is required so the browser doesn't also try to
// scroll the page through an in-progress touch drag.
function SortableThumbnail({
  image,
  isPrimary,
  isFirst,
  isLast,
  isPending,
  onOpen,
  onMoveEarlier,
  onMoveLater,
  onReplace,
  onDelete,
}: {
  image: GalleryImage;
  isPrimary: boolean;
  isFirst: boolean;
  isLast: boolean;
  isPending: boolean;
  onOpen: () => void;
  onMoveEarlier: () => void;
  onMoveLater: () => void;
  onReplace: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: image.id });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
      className="relative h-20 w-20 shrink-0 touch-none overflow-hidden rounded-lg bg-black/[.03] dark:bg-white/[.05]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Vercel Blob is an arbitrary per-deployment host next/image can't optimize without ongoing config, same reasoning as every other Blob-sourced image in this app */}
      <img src={image.url} alt="" onClick={onOpen} className="h-full w-full object-cover" draggable={false} />
      {isPrimary && (
        <span className="pointer-events-none absolute left-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[9px] font-medium text-white">
          Primary
        </span>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-0.5 bg-black/60 px-1 py-0.5">
        <button
          type="button"
          disabled={isPending || isFirst}
          onClick={onMoveEarlier}
          aria-label="Move earlier"
          title="Move earlier"
          className="px-1 text-xs text-white disabled:opacity-30"
        >
          ◀
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={onReplace}
          aria-label="Replace this image"
          title="Replace"
          className="px-1 text-xs text-white disabled:opacity-30"
        >
          ⟳
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={onDelete}
          aria-label="Delete this image"
          title="Delete"
          className="px-1 text-xs text-white disabled:opacity-30"
        >
          ✕
        </button>
        <button
          type="button"
          disabled={isPending || isLast}
          onClick={onMoveLater}
          aria-label="Move later"
          title="Move later"
          className="px-1 text-xs text-white disabled:opacity-30"
        >
          ▶
        </button>
      </div>
    </div>
  );
}

export function ProductImageGallery({ productId, images }: { productId: string; images: GalleryImage[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ succeeded: number; total: number } | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetId = useRef<string | null>(null);

  // Optimistic reorder — "must actually change the order," visibly and
  // immediately, not just after the next server round trip. Cleared the
  // moment a genuinely new `images` prop arrives (the real, persisted
  // order), same "adjust state during render when a prop changes" pattern
  // GenesisAssistant.tsx's own message reconciliation already uses.
  const [syncedImages, setSyncedImages] = useState(images);
  const [localOrder, setLocalOrder] = useState<GalleryImage[] | null>(null);
  if (images !== syncedImages) {
    setSyncedImages(images);
    setLocalOrder(null);
  }

  const ordered = localOrder ?? [...images].sort((a, b) => a.position - b.position);
  const remainingSlots = MAX_IMAGES - ordered.length;

  // MouseSensor + TouchSensor (not PointerSensor) — @dnd-kit's own
  // canonical Sortable setup, since each device gets its own tuned
  // activation constraint: mouse needs a small drag distance so a plain
  // click still reaches the image/buttons underneath; touch needs a short
  // hold (delay) so an ordinary scroll gesture is never mistaken for a
  // drag. KeyboardSensor makes this reachable without a pointer at all.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

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
    setLocalOrder(reordered);
    runMutation(() => reorderProductImages(productId, reordered.map((img) => img.id)));
  }

  function handleDragStart(event: DragStartEvent) {
    setDraggingId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setDraggingId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = ordered.findIndex((img) => img.id === active.id);
    const newIndex = ordered.findIndex((img) => img.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(ordered, oldIndex, newIndex);
    setLocalOrder(reordered);
    runMutation(() => reorderProductImages(productId, reordered.map((img) => img.id)));
  }

  const draggingImage = draggingId ? ordered.find((img) => img.id === draggingId) : null;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
        Photos ({ordered.length}/{MAX_IMAGES})
        {ordered.length > 1 && <span className="ml-1 font-normal text-zinc-400 dark:text-zinc-500">— drag to reorder</span>}
      </span>

      {ordered.length === 0 ? (
        <div className="flex h-20 w-20 items-center justify-center rounded-lg bg-black/[.03] text-center text-[11px] text-zinc-400 dark:bg-white/[.05]">
          No image
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDraggingId(null)}
        >
          <SortableContext items={ordered.map((img) => img.id)} strategy={rectSortingStrategy}>
            <div className="flex flex-wrap gap-2">
              {ordered.map((image, i) => (
                <SortableThumbnail
                  key={image.id}
                  image={image}
                  isPrimary={i === 0}
                  isFirst={i === 0}
                  isLast={i === ordered.length - 1}
                  isPending={isPending}
                  onOpen={() => setLightboxIndex(i)}
                  onMoveEarlier={() => moveImage(image.id, -1)}
                  onMoveLater={() => moveImage(image.id, 1)}
                  onReplace={() => {
                    replaceTargetId.current = image.id;
                    replaceInputRef.current?.click();
                  }}
                  onDelete={() => runMutation(() => deleteProductImage(image.id))}
                />
              ))}
            </div>
          </SortableContext>
          {/* The dragged tile floats above everything and tracks the
              pointer/finger directly (a real DOM portal, not just a CSS
              transform on the original tile) — this is the concrete "the
              dragged image must visibly move" affordance. */}
          <DragOverlay>
            {draggingImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={draggingImage.url}
                alt=""
                className="h-20 w-20 rounded-lg object-cover opacity-90 shadow-xl ring-2 ring-[var(--brand-accent,#2563eb)]"
              />
            ) : null}
          </DragOverlay>
        </DndContext>
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
