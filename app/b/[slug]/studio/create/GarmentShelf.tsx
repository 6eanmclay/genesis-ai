"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Garment } from "@/lib/creation/garment";

// CHOOSING WHAT TO MAKE.
//
// ============ THE FILTERS ARE THE SUPPLIER'S OWN FACTS ==================
//
// Type comes from the catalogue's `type` field; manufacturer is extracted from
// the product title, which is where Printful puts it. Neither is a taxonomy
// Genesis invented, and neither appears unless real garments carry it — a
// filter offering a choice that matches nothing is worse than no filter.
//
// A garment whose manufacturer could not be read is not hidden and is not given
// a made-up one. It sits under "Other", which is honest: we could not tell.

const ALL = "__all__";

export function GarmentShelf({
  garments,
  basePath,
  /** How many the supplier HAS, which may exceed how many were fetched. */
  availableCount,
}: {
  garments: Garment[];
  basePath: string;
  availableCount: number;
}) {
  const [type, setType] = useState(ALL);
  const [brand, setBrand] = useState(ALL);

  // Only offered when more than one exists — a filter with a single option is
  // a control that cannot change anything.
  const types = useMemo(
    () => [...new Set(garments.map((g) => g.type).filter((t): t is string => Boolean(t)))].sort(),
    [garments],
  );
  const brands = useMemo(
    () => [...new Set(garments.map((g) => g.brand).filter((b): b is string => Boolean(b)))].sort(),
    [garments],
  );

  const shown = garments.filter(
    (g) => (type === ALL || g.type === type) && (brand === ALL || (g.brand ?? "Other") === brand),
  );

  return (
    <div>
      {(types.length > 1 || brands.length > 1) && (
        <div className="mt-5 flex flex-col gap-3">
          {types.length > 1 && (
            <Row label="What" value={type} onChange={setType} options={types} allLabel="Everything" />
          )}
          {brands.length > 1 && (
            <Row label="Made by" value={brand} onChange={setBrand} options={brands} allLabel="Any maker" />
          )}
        </div>
      )}

      {/* ============ THE COUNT HAS TO BE THE SUPPLIER'S ==================
          `garments` is what was FETCHED, and a ceiling was put on that so one
          screen cannot spend a supplier's whole rate-limit allowance (see
          DETAIL_LIMIT in page.tsx). Reporting it as "N blanks from your
          supplier" would then state a number that belongs to us, not to them —
          a supplier with thirty hoodies would be described as having twelve.

          `availableCount` is how many the supplier actually has. When it is
          larger, the screen says both, because "showing twelve of thirty" is a
          fact about this page and "thirty" is the fact about the business. */}
      <p className="mt-4 text-[13px] text-zinc-500">
        {shown.length !== garments.length
          ? `${shown.length} of ${garments.length}`
          : availableCount > garments.length
            ? `Showing ${garments.length} of ${availableCount} from your supplier. Colours, sizes and print areas are theirs.`
            : `${garments.length} blanks from your supplier. Colours, sizes and print areas are theirs.`}
      </p>

      {shown.length === 0 ? (
        // A filter combination with nothing in it is a real outcome, and
        // saying so beats an empty grid that looks broken.
        <p className="mt-6 text-[14px] text-zinc-500">
          Nothing matches that combination. Widen one of the filters.
        </p>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((g) => (
            <Link
              key={g.externalProductId}
              href={`${basePath}/studio/create?garment=${encodeURIComponent(g.externalProductId)}`}
              className="group rounded-2xl border border-black/[.10] p-3 transition hover:border-black/30 dark:border-white/[.14] dark:hover:border-white/40"
            >
              <div className="aspect-square overflow-hidden rounded-xl bg-zinc-100 dark:bg-zinc-900">
                {g.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element -- supplier CDN
                  <img src={g.imageUrl} alt="" className="h-full w-full object-contain" />
                )}
              </div>
              <p className="mt-2 line-clamp-2 text-[13px] font-medium">{g.name}</p>
              <p className="mt-0.5 text-[12px] text-zinc-500">
                {/* Real facts only: the maker where the supplier named one, how
                    many colours, and which sides print. */}
                {g.brand ? `${g.brand} · ` : ""}
                {new Set(g.variants.map((v) => v.color)).size} colours
                {g.printAreas.length > 1 ? " · front & back" : ""}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: string[];
  allLabel: string;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-16 shrink-0 text-[12px] text-zinc-500">{label}</span>
      {/* Scrolls rather than wraps: a supplier with thirty garment types would
          otherwise push the shelf itself off the screen on a phone. */}
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {[{ key: ALL, text: allLabel }, ...options.map((o) => ({ key: o, text: o }))].map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={value === option.key}
            onClick={() => onChange(option.key)}
            className={[
              "shrink-0 rounded-full px-3 py-1.5 text-[13px] capitalize transition",
              value === option.key
                ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
                : "bg-black/[.06] text-zinc-700 hover:bg-black/[.10] dark:bg-white/[.08] dark:text-zinc-300 dark:hover:bg-white/[.14]",
            ].join(" ")}
          >
            {option.text.toLowerCase()}
          </button>
        ))}
      </div>
    </div>
  );
}
