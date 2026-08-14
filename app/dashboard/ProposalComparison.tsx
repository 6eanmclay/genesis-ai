"use client";

import { useState } from "react";
import { proposalPresentation, type ProposalScope } from "@/lib/storefront/proposalScope";

// CURRENT ↔ PROPOSED, at a size that matches what is being proposed, and with
// room for more than one direction (2026-08-14).
//
// Sean's rule, from GENESIS_SURFACES.md: "the comparison should make
// CURRENT ↔ PROPOSED immediately understandable, preferably with a toggle or
// equivalent interaction. And the proposal must have enough visual fidelity
// that the owner can make a real decision from it."
//
// And, later: "I still want J4 to be able to show me multiple visual
// directions when appropriate... [Direction A] [Direction B] or a toggle
// between the two visual states." So this takes a list of sides rather than a
// fixed pair. One direction is the ordinary case and renders exactly as it
// did; two or more turn the same control into a chooser without becoming a
// different component.
//
// WHY A TOGGLE RATHER THAN SIDE BY SIDE. Two storefronts side by side on a
// phone are two columns roughly 160px wide, which is not a comparison, it is
// two thumbnails. Swapping one full-width view in place is how a person
// actually spots a difference: the parts that stay still disappear from
// attention and the parts that move announce themselves.
//
// EVERY FRAME STAYS MOUNTED. Toggling hides one and shows another rather than
// swapping an iframe's src. A storefront takes real time to load, and a toggle
// that reloads on every press is one the owner presses once. Keeping them all
// alive is what makes flipping back and forth feel like looking at the same
// page changing, which is the entire point.

export interface ComparisonSide {
  /** Stable key. "current" is reserved for the storefront as it is now. */
  id: string;
  label: string;
  url: string;
}

export function ProposalComparison({
  sides,
  scope,
  storeName,
  /** Which side to show first. Defaults to the first non-current side. */
  initialId,
}: {
  sides: ComparisonSide[];
  /** Drives the height. Derived from what the proposal touches, never chosen here. */
  scope: ProposalScope;
  storeName: string;
  initialId?: string;
}) {
  const firstProposed = sides.find((s) => s.id !== "current") ?? sides[0];
  const [activeId, setActiveId] = useState<string>(initialId ?? firstProposed?.id ?? "current");
  const { previewHeightClass, label } = proposalPresentation(scope);

  if (sides.length === 0) return null;

  return (
    <div className="mt-3">
      {/* One control with N states, not N buttons — the owner is flipping one
          view, not choosing between pages. Scrolls horizontally rather than
          shrinking each label to nothing when J4 offers several directions. */}
      <div
        className="mb-2 flex items-center gap-1 overflow-x-auto rounded-full border border-black/[.08] bg-black/[.02] p-1 dark:border-white/[.145] dark:bg-white/[.04]"
        role="group"
        aria-label={`Compare ${label}`}
      >
        {sides.map((side) => {
          const active = side.id === activeId;
          return (
            <button
              key={side.id}
              type="button"
              onClick={() => setActiveId(side.id)}
              aria-pressed={active}
              className={`min-w-0 flex-1 shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? side.id === "current"
                    ? "bg-white text-black shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                    : "bg-[#2563eb] text-white"
                  : "text-zinc-500 dark:text-zinc-400"
              }`}
            >
              {side.label}
            </button>
          );
        })}
      </div>

      <div
        className={`relative w-full overflow-hidden rounded-xl border border-black/[.08] bg-white dark:border-white/[.145] ${previewHeightClass}`}
      >
        {sides.map((side) => (
          <iframe
            key={side.id}
            src={side.url}
            title={
              side.id === "current"
                ? `${storeName} as it is now`
                : `${storeName} with ${side.label} applied`
            }
            loading="lazy"
            className={`absolute inset-0 h-full w-full ${side.id === activeId ? "" : "invisible"}`}
          />
        ))}
      </div>

      <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        Showing {label}. This is your real storefront, not a mock.
      </p>
    </div>
  );
}
