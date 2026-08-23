"use client";

import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import type { ContextEntry } from "@/lib/j4/contextTypes";

// THE CONTEXT PANE (UI6 piece 1).
//
// OWNER-INITIATED, and that is an invariant rather than an intention. This
// component has no effect, no subscription, no timer and no server call — the
// only thing that changes whether it is open is the owner pressing the control
// that opens it. There is deliberately no prop by which a parent could open it
// on J4's behalf, because a prop like that is how "show me my context" quietly
// becomes "J4 decided to interrupt me".
//
// READ-ONLY. It renders strings. There is no form, no action, no button that
// does anything but close it, and no path from here to a proposal. Anything
// that changes business state continues through
// proposal → authorization → execution → verification, untouched.
//
//   Context pane = understand. Action surface = change.
//
// CURRENT, NOT HISTORICAL. The entries are built from the understanding the
// surface fetched for this render, so the pane shows what J4 knows now — the
// same rule conversations follow when they resume.

export function ContextPane({
  entries,
  conversationLabel,
  anchoredWork,
  onClose,
}: {
  /** Built from the closed registry. Nothing else can appear here. */
  entries: ContextEntry[];
  /** Which conversation this is the context for. */
  conversationLabel: string;
  /** The conversation's anchored work, when it has some. Metadata, not a link. */
  anchoredWork: string | null;
  onClose: () => void;
}) {
  return (
    <aside
      data-role="context-pane"
      aria-label="Business context"
      className="flex w-full flex-col gap-3 rounded-lg border p-3 sm:w-72"
      style={{ borderColor: GENESIS_ATMOSPHERE.border, backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-[#f4f2fb]">What J4 knows</p>
          <p className="truncate text-[11px]" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            {conversationLabel}
          </p>
        </div>
        {/* The only control in here, and it only closes. */}
        <button
          type="button"
          data-role="close-context-pane"
          onClick={onClose}
          className="shrink-0 rounded-md px-2 py-1 text-[11px] transition hover:bg-white/[.06]"
          style={{ color: GENESIS_ATMOSPHERE.textSecondary }}
        >
          Close
        </button>
      </div>

      {anchoredWork && (
        <div>
          <p className="text-[11px] font-medium" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            This conversation is about
          </p>
          <p className="mt-0.5 text-xs text-[#f4f2fb]">{anchoredWork}</p>
        </div>
      )}

      {entries.length === 0 ? (
        // An honest empty state. J4 knowing nothing yet is a real answer, and
        // filler here would be the opposite of what this pane is for.
        <p className="text-xs" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
          Nothing recorded yet. As you tell J4 about the business, it shows up here.
        </p>
      ) : (
        entries.map((entry) => (
          <div key={entry.key} data-context-type={entry.key}>
            <p className="text-[11px] font-medium" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
              {entry.label}
            </p>
            <ul className="mt-0.5 space-y-0.5">
              {entry.lines.map((line, i) => (
                <li key={i} className="text-xs text-[#f4f2fb]">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </aside>
  );
}
