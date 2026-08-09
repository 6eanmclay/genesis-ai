"use client";

// Lightbox (2026-08-09) — "I have to hit the little arrow every single
// time... I want the gallery to behave like a modern image gallery" (Sean).
// Extracted out of ProductImageGallery.tsx so the same real viewer also
// covers the OTHER place a photo needs real inspection: a J4-proposed
// image change's Current/Proposed preview (lib/execution/ActionDiff.tsx) —
// "I need to be able to inspect those photos properly before approving
// them" (Sean's own explicit reason this matters now). One real component,
// not two drifting copies.
import { useEffect, useRef, useState } from "react";

export interface LightboxImage {
  id: string;
  url: string;
}

// One drag handler, Pointer Events only — the one API that natively unifies
// touch and mouse ("on desktop, mouse drag/swipe should work where
// appropriate," Sean's own words) instead of maintaining separate touch/
// mouse listener pairs. The image translates live with the finger/cursor
// while dragging (no CSS transition, so it tracks exactly), then either
// commits to the next/prev image or springs back once released.
const SWIPE_COMMIT_THRESHOLD_PX = 60;

export function ImageLightbox({
  images,
  startIndex,
  onClose,
  primaryIndex = 0,
}: {
  images: LightboxImage[];
  startIndex: number;
  onClose: () => void;
  // The gallery's primary image is always position 0; a Current/Proposed
  // diff pair has no real "primary" concept, so callers without one simply
  // never show the badge (an index that never matches, e.g. -1, works too).
  primaryIndex?: number;
}) {
  const [index, setIndex] = useState(startIndex);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartX = useRef(0);
  const pointerId = useRef<number | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight") setIndex((i) => Math.min(images.length - 1, i + 1));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [images.length, onClose]);

  function handlePointerDown(e: React.PointerEvent) {
    pointerId.current = e.pointerId;
    dragStartX.current = e.clientX;
    setIsDragging(true);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (pointerId.current !== e.pointerId) return;
    let delta = e.clientX - dragStartX.current;
    // Rubber-band at the ends — dragging past the first/last image still
    // moves, just damped, so it never feels stuck or broken.
    if ((index === 0 && delta > 0) || (index === images.length - 1 && delta < 0)) {
      delta *= 0.35;
    }
    setDragX(delta);
  }

  function endDrag(e: React.PointerEvent) {
    if (pointerId.current !== e.pointerId) return;
    pointerId.current = null;
    setIsDragging(false);
    if (dragX <= -SWIPE_COMMIT_THRESHOLD_PX && index < images.length - 1) {
      setIndex(index + 1);
    } else if (dragX >= SWIPE_COMMIT_THRESHOLD_PX && index > 0) {
      setIndex(index - 1);
    }
    setDragX(0);
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-black/95"
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
    >
      <div className="flex shrink-0 items-center justify-between px-4 py-3 text-white">
        <span className="text-sm tabular-nums text-white/70">
          {images.length > 1 ? `${index + 1} / ${images.length}` : ""}
        </span>
        {index === primaryIndex && (
          <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-medium">Primary</span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-m-2 rounded-full p-2 text-white/80 hover:text-white"
        >
          ✕
        </button>
      </div>

      <div
        className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* Neighbors render alongside the active image, all shifted by one
            shared translateX — this is what makes a swipe show the next
            photo sliding in rather than the current one just fading. */}
        <div
          className="flex h-full w-full"
          style={{
            transform: `translateX(calc(${-index * 100}% + ${dragX}px))`,
            transition: isDragging ? "none" : "transform 240ms ease-out",
          }}
        >
          {images.map((image) => (
            <div key={image.id} className="flex h-full w-full shrink-0 items-center justify-center px-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- Vercel Blob is an arbitrary per-deployment host next/image can't optimize without ongoing config */}
              <img src={image.url} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
            </div>
          ))}
        </div>

        {index > 0 && (
          <button
            type="button"
            onClick={() => setIndex(index - 1)}
            aria-label="Previous photo"
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2.5 text-lg text-white hover:bg-black/60"
          >
            ‹
          </button>
        )}
        {index < images.length - 1 && (
          <button
            type="button"
            onClick={() => setIndex(index + 1)}
            aria-label="Next photo"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2.5 text-lg text-white hover:bg-black/60"
          >
            ›
          </button>
        )}
      </div>

      {images.length > 1 && (
        <div className="flex shrink-0 justify-center gap-1.5 py-3">
          {images.map((image, i) => (
            <button
              key={image.id}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Go to photo ${i + 1}`}
              className={`h-1.5 rounded-full transition-all ${i === index ? "w-4 bg-white" : "w-1.5 bg-white/35"}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
