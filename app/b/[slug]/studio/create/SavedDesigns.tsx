import Link from "next/link";

// WHAT THE OWNER LEFT HALF-FINISHED.
//
// ============ WHY THIS EXISTS (2026-08-28) =============================
//
// Sean: "If someone saves a design because they're not sure it's finished, it
// should remain available in their Creation Station/design library so they can
// reopen it later and continue working on it."
//
// Saving already wrote a real record before this component existed, and that
// was not enough: a draft nobody can reach is not recoverable, it is only
// stored. This is the reaching.
//
// Deliberately a list of links and nothing else — same restraint as
// AddAssetPanel. No preview grid, no sorting, no filters. Somebody who saved
// two hoodies last week needs to find one of them, not browse a library.

export interface SavedDesign {
  draftId: string;
  /** The blank it was designed on — reopening needs it. */
  externalProductId: string;
  name: string;
  /** "Black, front and back" — colour and which sides carry artwork. */
  summary: string;
  updatedAt: string | null;
  /** Whether it has already been turned into a product. */
  created: boolean;
}

function when(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function SavedDesigns({
  designs,
  hrefFor,
}: {
  designs: SavedDesign[];
  /** Where reopening one goes — the page owns the URL shape, not this list. */
  hrefFor: (design: SavedDesign) => string;
}) {
  if (designs.length === 0) return null;

  return (
    <section className="mx-auto w-full max-w-6xl px-5 pt-8">
      <h2 className="text-[13px] font-medium text-zinc-500">Your saved designs</h2>
      <ul className="mt-3 flex flex-col gap-1">
        {designs.map((design) => (
          <li key={design.draftId}>
            <Link
              href={hrefFor(design)}
              className="flex items-baseline gap-3 rounded-xl px-3 py-2.5 transition hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            >
              <span className="text-[15px] font-medium">{design.name}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-500">{design.summary}</span>
              {/* A draft that already became a product says so, because
                  reopening it and pressing Create again is the one mistake
                  this list could otherwise invite. */}
              {design.created && (
                <span className="shrink-0 text-[12px] text-zinc-500">already a product</span>
              )}
              <span className="shrink-0 text-[12px] text-zinc-400">{when(design.updatedAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
