"use client";

// Product media gallery (2026-08-08) — the storefront half. "Verify that
// the storefront displays the primary image correctly and provides a
// usable gallery for the additional product images" (Sean). The hero
// keeps rendering the primary image by default (images[0] — Product.imageUrl
// itself, unchanged); this adds a real thumbnail strip beneath it, shown
// only when a product actually has more than one image, letting a
// customer swap the hero client-side (no page reload) rather than a real,
// separate gallery component being needed for the single-image case.
import { useState } from "react";

export function ProductGallery({
  images,
  productName,
  className,
}: {
  images: { url: string }[];
  productName: string;
  className?: string;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = images[selectedIndex] ?? images[0] ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className={className}>
        {selected ? (
          // eslint-disable-next-line @next/next/no-img-element -- Vercel Blob is an arbitrary per-deployment host next/image can't optimize without ongoing config, same reasoning as every other Blob-sourced image in this app
          <img src={selected.url} alt={productName} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-sm text-[var(--brand-text-secondary)]">
            No image
          </div>
        )}
      </div>

      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto">
          {images.map((image, i) => (
            <button
              key={image.url + i}
              type="button"
              onClick={() => setSelectedIndex(i)}
              aria-label={`Show image ${i + 1} of ${images.length}`}
              aria-current={i === selectedIndex}
              className={`h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 transition ${
                i === selectedIndex ? "border-[var(--brand-accent)]" : "border-transparent opacity-70 hover:opacity-100"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- same reasoning as the hero image above */}
              <img src={image.url} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
