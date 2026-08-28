import Link from "next/link";
import type { SavedDesignRow } from "./actions";

// FINISH WORKING ON — the unfinished work, at the doorway.
//
// ============ WHY THIS EXISTS (2026-08-28) =============================
//
// Sean: "Creation Station should have a 'Finish working on' / 'Saved designs'
// area at the doorway. This should show unfinished designs so a user can start
// several products without losing their work."
//
// The first version was a list of names and a timestamp, which is not something
// anybody can pick their own half-finished hoodie out of. What it shows now is
// what he asked for: the artwork, the garment, the colour, which sides have
// work on them, when it was last touched, and whether it is still in progress.
//
// Still deliberately a list rather than a gallery. Somebody who saved two
// hoodies last week needs to find one of them, not browse a library.

function when(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

export function SavedDesigns({
  designs,
  hrefFor,
}: {
  designs: SavedDesignRow[];
  /** Where reopening one goes — the page owns the URL shape, not this list. */
  hrefFor: (design: SavedDesignRow) => string;
}) {
  if (designs.length === 0) return null;

  return (
    <section className="mx-auto w-full max-w-6xl px-5 pt-10">
      <h2 className="text-[15px] font-medium">Finish working on</h2>
      <p className="mt-1 text-[13px] text-zinc-500">
        Your saved designs and unfinished creations.
      </p>

      <ul className="mt-4 flex flex-col gap-1">
        {designs.map((design) => (
          <li key={design.draftId}>
            <Link
              href={hrefFor(design)}
              className="flex items-center gap-3 rounded-xl p-2 transition hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            >
              {/* THE ARTWORK, which is what somebody actually recognises. On a
                  white tile because artwork is usually transparent, and on a
                  dark theme transparent artwork is invisible. */}
              <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-black/[.10] bg-white dark:border-white/[.14]">
                {design.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- Blob-hosted
                  <img
                    src={design.thumbnailUrl}
                    alt=""
                    className="h-full w-full object-contain p-1"
                  />
                ) : (
                  <span className="text-[10px] text-zinc-400">empty</span>
                )}
              </span>

              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium">{design.name}</span>
                <span className="block truncate text-[12px] text-zinc-500">
                  {[design.color, design.sides.length > 0 ? design.sides.join(" and ") : "nothing on it yet"]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>

              <span className="shrink-0 text-right">
                {/* A design that already became a product says so, because
                    reopening it and pressing Create again is the one mistake
                    this list could otherwise invite. */}
                <span
                  className={[
                    "block text-[11px] font-medium",
                    design.created ? "text-zinc-400" : "text-[var(--brand-accent,#6366f1)]",
                  ].join(" ")}
                >
                  {design.created ? "Already a product" : "In progress"}
                </span>
                <span className="block text-[11px] text-zinc-400">{when(design.updatedAt)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
