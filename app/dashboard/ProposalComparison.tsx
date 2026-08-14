"use client";

import { useState } from "react";
import { proposalPresentation, type ProposalScope } from "@/lib/storefront/proposalScope";

// CURRENT ↔ PROPOSED, at a size that matches what is being proposed
// (2026-08-14).
//
// Sean's rule, from GENESIS_SURFACES.md: "the comparison should make
// CURRENT ↔ PROPOSED immediately understandable, preferably with a toggle or
// equivalent interaction. And the proposal must have enough visual fidelity
// that the owner can make a real decision from it."
//
// WHY A TOGGLE RATHER THAN SIDE BY SIDE. Two storefronts side by side on a
// phone are two columns roughly 160px wide, which is not a comparison, it is
// two thumbnails. Swapping one full-width view in place is how a person
// actually spots a difference: the parts that stay still disappear from
// attention and the parts that move announce themselves. Side by side stays
// available for genuinely small comparisons through the existing
// VisualProposal, which this does not replace.
//
// BOTH FRAMES STAY MOUNTED. Toggling hides one and shows the other rather
// than swapping an iframe's src. A storefront takes real time to load, and a
// toggle that reloads on every press is one the owner presses once. Keeping
// both alive is what makes flipping back and forth feel like looking at the
// same page changing, which is the entire point.

type Side = "current" | "proposed";

export function ProposalComparison({
  currentUrl,
  proposedUrl,
  scope,
  storeName,
}: {
  currentUrl: string;
  proposedUrl: string;
  /** Drives the height. Derived from what the proposal touches, never chosen here. */
  scope: ProposalScope;
  storeName: string;
}) {
  const [side, setSide] = useState<Side>("proposed");
  const { previewHeightClass, label } = proposalPresentation(scope);

  return (
    <div className="mt-3">
      {/* The control reads as one thing with two states, not two buttons —
          the owner is flipping one view, not choosing between two pages. */}
      <div
        className="mb-2 flex items-center gap-1 rounded-full border border-black/[.08] bg-black/[.02] p-1 dark:border-white/[.145] dark:bg-white/[.04]"
        role="group"
        aria-label={`Compare ${label}`}
      >
        {(["current", "proposed"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setSide(value)}
            aria-pressed={side === value}
            className={`flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              side === value
                ? value === "proposed"
                  ? "bg-[#2563eb] text-white"
                  : "bg-white text-black shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                : "text-zinc-500 dark:text-zinc-400"
            }`}
          >
            {value === "current" ? "Current" : "J4's proposal"}
          </button>
        ))}
      </div>

      <div
        className={`relative w-full overflow-hidden rounded-xl border border-black/[.08] bg-white dark:border-white/[.145] ${previewHeightClass}`}
      >
        {/* Both rendered, one shown. `hidden` rather than unmounting, so the
            frame the owner is about to flip back to is already loaded. */}
        <iframe
          src={currentUrl}
          title={`${storeName} as it is now`}
          loading="lazy"
          className={`absolute inset-0 h-full w-full ${side === "current" ? "" : "invisible"}`}
        />
        <iframe
          src={proposedUrl}
          title={`${storeName} with J4's proposal applied`}
          loading="lazy"
          className={`absolute inset-0 h-full w-full ${side === "proposed" ? "" : "invisible"}`}
        />
      </div>

      <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        Showing {label}. This is your real storefront, not a mock.
      </p>
    </div>
  );
}
