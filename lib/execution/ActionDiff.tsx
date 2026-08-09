"use client";

import { useState } from "react";
import { FIELD_LABELS } from "@/lib/execution/fieldLabels";
import { ImageLightbox } from "@/app/dashboard/ImageLightbox";

// Meeting with J4 M2 — extracted from ApprovalRequestsPanel.tsx so any
// future caller (the meeting's inline explain/approve/execute UI) renders
// exactly the same generic Current -> Proposed diff, never a bespoke
// per-action card. A third, fourth, fifth... registered action type needs
// no changes here — it renders correctly the moment it's added to
// GENESIS_ACTIONS/FIELD_LABELS, the same guarantee this already held
// before the extraction, just no longer only true for one caller.
//
// "use client" (2026-08-09) — the image-diff preview below needs real tap-
// to-inspect state (ImageLightbox): "J4 is now going to be able to
// recommend product-photo changes. I need to be able to inspect those
// photos properly before approving them" (Sean). This file has zero
// server-only dependencies (see fieldLabels.ts's own comment), so it was
// always safe to render from either a Server or Client Component — this
// just makes that explicit and adds the one real interactive island.
export const HIDDEN_DIFF_KEYS = new Set(["productId"]);

// A plain string array (e.g. coreValues, brandKeywords) formatted for one
// diff row — Array.prototype.toString() joins with a bare comma, no space,
// which reads as a bug rather than a list. Any field ending in "InCents"
// (priceInCents today, any future money field) renders as real currency
// rather than a raw integer — a generic, name-pattern-based rule, not a
// per-action special case. Everything else falls through to String()
// unchanged.
export function formatDiffValue(key: string, value: unknown): string {
  if (key.endsWith("InCents") && typeof value === "number") {
    return `$${(value / 100).toFixed(2)}`;
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "(empty)";
  }
  return String(value ?? "(empty)");
}

// The generic per-key diff rows — including the one real special case
// (side-by-side image preview for imageUrl) — shared by every current and
// future caller. `input`/`previousValues` are the same loosely-typed shape
// ApprovalRequest.input/previousValues already are everywhere else in this
// codebase (real, validated Json at write time; read generically here).
export function ActionDiffRows({
  input,
  previousValues,
}: {
  input: Record<string, unknown>;
  previousValues: Record<string, unknown>;
}) {
  const diffKeys = Object.keys(input).filter((key) => !HIDDEN_DIFF_KEYS.has(key));
  // "I need to be able to inspect those photos properly before approving
  // them" (Sean) — 0 opens Current large, 1 opens Proposed large; null is
  // closed. Real DB URLs only (a missing side renders "No image," never a
  // lightbox entry), so the index always matches ImageLightbox's own array.
  const [openImageIndex, setOpenImageIndex] = useState<number | null>(null);

  return (
    <dl className="mt-2 flex flex-col gap-2">
      {diffKeys.map((key) => {
        const previous = previousValues[key];
        const proposed = input[key];

        if (key === "imageUrl") {
          const lightboxImages = [
            ...(typeof previous === "string" ? [{ id: "current", url: previous }] : []),
            ...(typeof proposed === "string" ? [{ id: "proposed", url: proposed }] : []),
          ];
          // Current is always lightboxImages[0] when present; Proposed is
          // whichever slot follows it — never assume a fixed index.
          const proposedLightboxIndex = typeof previous === "string" ? 1 : 0;
          return (
            <div key={key} className="text-xs">
              <dt className="font-medium text-zinc-500">{FIELD_LABELS[key] ?? key}</dt>
              <div className="mt-1 flex gap-2">
                <div className="flex-1">
                  <p className="mb-1 text-zinc-400">Current</p>
                  {previous && typeof previous === "string" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={previous}
                      alt="Current product"
                      onClick={() => setOpenImageIndex(0)}
                      className="aspect-square w-full cursor-zoom-in rounded-md object-cover"
                    />
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center rounded-md bg-black/[.03] text-zinc-400 dark:bg-white/[.05]">
                      No image
                    </div>
                  )}
                </div>
                <div className="flex-1">
                  <p className="mb-1 text-black dark:text-zinc-50">Proposed</p>
                  {proposed && typeof proposed === "string" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={proposed}
                      alt="Proposed product"
                      onClick={() => setOpenImageIndex(proposedLightboxIndex)}
                      className="aspect-square w-full cursor-zoom-in rounded-md object-cover"
                    />
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center rounded-md bg-black/[.03] text-zinc-400 dark:bg-white/[.05]">
                      No image
                    </div>
                  )}
                </div>
              </div>
              {openImageIndex !== null && (
                <ImageLightbox images={lightboxImages} startIndex={openImageIndex} onClose={() => setOpenImageIndex(null)} />
              )}
            </div>
          );
        }

        return (
          <div key={key} className="text-xs">
            <dt className="font-medium text-zinc-500">{FIELD_LABELS[key] ?? key}</dt>
            <dd className="mt-0.5 text-zinc-400 line-through">{formatDiffValue(key, previous)}</dd>
            <dd className="mt-0.5 text-black dark:text-zinc-50">{formatDiffValue(key, proposed)}</dd>
          </div>
        );
      })}
    </dl>
  );
}
