import type { ReactNode } from "react";
import type { ConnectionState } from "@/lib/integrations/connectionHealth";

// THE SHARED GENESIS CHROME — first written for Data & Connections (2026-09-12).
//
// ============ WHAT THIS IS, AND WHAT IT IS NOT ========================
//
// Sean's direction for the Genesis Experience Rebuild: "unified system,
// differentiated rooms." The chrome — panels, labels, figures, accents,
// rhythm — is what makes every surface belong to one product. The GROUND each
// room's content sits on is deliberately NOT part of that and stays per room
// (lib/dashboard/rooms.ts): the Storefront's neutral mat exists so a
// merchant's own cream storefront is the brightest thing on screen, and a
// dark chrome painted over it would be the mat-versus-picture failure that
// rule was written to prevent.
//
// So nothing here sets a page background. These are objects that sit ON a
// ground, and they are built to read correctly on all of them.
//
// ============ WHY A MODULE RATHER THAN CLASSES ON A PAGE =============
//
// Because the next four surfaces inherit this vocabulary, and the cheapest
// way to end up with five dialects is to let each screen spell the panel
// itself. One definition, imported.
//
// Server components by design — no "use client". Nothing here holds state.

/** A bordered surface. The basic object every Genesis screen is made of. */
export function Panel({
  children,
  className = "",
  accent = false,
}: {
  children: ReactNode;
  className?: string;
  /** Lifts one panel that carries the screen's point. Spend it once. */
  accent?: boolean;
}) {
  return (
    <div
      className={[
        "rounded-xl border",
        accent
          ? "border-emerald-500/30 bg-emerald-500/[.04] dark:border-emerald-400/25 dark:bg-emerald-400/[.05]"
          : "border-black/[.08] bg-white dark:border-white/[.10] dark:bg-white/[.02]",
        className,
      ].join(" ")}
    >
      {children}
    </div>
  );
}

/**
 * The small uppercase label above a group.
 *
 * Letter-spaced and quiet on purpose: it names a region without competing with
 * the content inside it.
 */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[11px] uppercase tracking-[.18em] text-zinc-500 dark:text-zinc-500">
      {children}
    </p>
  );
}

export function SectionTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-3">
      <h2 className="text-lg font-semibold text-black dark:text-zinc-50">{children}</h2>
      {sub ? (
        <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">{sub}</p>
      ) : null}
    </div>
  );
}

/**
 * A counted thing.
 *
 * tabular-nums because these line up in rows, and a column of figures that
 * does not align is the most legible failure a data screen can have — the same
 * reasoning Commerce's own ground already carries.
 */
export function Figure({ value, label }: { value: ReactNode; label: ReactNode }) {
  return (
    <div>
      <div className="text-2xl font-semibold tabular-nums text-black dark:text-zinc-50">{value}</div>
      <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
    </div>
  );
}

/**
 * A connection's state, as a dot and a word.
 *
 * Colour is SEMANTIC and deliberately separate from the green accent: green
 * here means "this is working", not "this is a Genesis thing". The six states
 * are connectionHealthOf's, never a set invented for a screen.
 */
const STATE_TONE: Record<ConnectionState, string> = {
  connected: "bg-emerald-500",
  connected_no_data: "bg-sky-500",
  needs_reconnection: "bg-amber-500",
  failed: "bg-red-500",
  not_connected: "bg-zinc-400 dark:bg-zinc-600",
  unavailable: "bg-zinc-300 dark:bg-zinc-700",
};

export function StateDot({ state }: { state: ConnectionState }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATE_TONE[state]}`}
      aria-hidden="true"
    />
  );
}
