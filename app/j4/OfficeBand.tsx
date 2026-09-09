"use client";

import Link from "next/link";
import { J4Character, type J4State } from "@/components/j4/J4Character";
import { OFFICE_ARC, type OfficeFact } from "@/lib/j4/officeFacts";

/**
 * J4'S OFFICE, AS A PLACE HE IS IN.
 *
 * ============ WHAT THIS REPLACES (2026-09-09, Sean) ====================
 *
 * "The current Office is still the old Office... I want the new Office to feel
 * like walking into J4's office/business command center, not opening a
 * database page." The Office opened on a small identity strip reading "J4 /
 * Business Partner for Cubit & Coil" above a list of rows. Nothing about it
 * said a partner was present; it read as a filter bar over a table.
 *
 * So the top of the Office is now J4 himself at a size you meet rather than
 * notice, the arc the work moves through, and what he is currently holding for
 * the owner. The rows below are unchanged in substance and now carry real
 * actions (officeActions.ts) - this is the room they sit in.
 *
 * ============ WHAT IT DELIBERATELY DOES NOT DO ========================
 *
 * The reference shows a sixteen-item left rail, a "Business Health 87" dial
 * and a "Search anything in your business" field. None are here. The rail was
 * ruled out on 2026-09-09 and GENESIS_SURFACES.md records it as not adopted;
 * the score has no calculation behind it; the search does not exist. Sean's
 * own instruction covers all three - the references "communicate the intended
 * visual hierarchy and experience", they are not artwork to copy.
 *
 * Every number here comes from lib/j4/officeFacts.ts, where a fact cannot be
 * built without naming its source.
 */
export function OfficeBand({
  storeName,
  state,
  facts,
  onOpenView,
}: {
  storeName: string;
  state: J4State;
  facts: OfficeFact[];
  /** An Office category is a view of THIS surface, never a navigation away. */
  onOpenView: (view: string) => void;
}) {
  return (
    <section
      data-testid="office-band"
      aria-label={`J4's office for ${storeName}`}
      className="relative overflow-hidden border-b border-[#4ade3a]/15 bg-[#050807]"
    >
      {/* The honeycomb as light rather than an image: the same motif as the
          artwork, without a second asset to keep registered to the first. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[.55]"
        style={{
          backgroundImage:
            "radial-gradient(120% 90% at 12% 0%, rgba(74,222,58,.16), transparent 62%), radial-gradient(80% 70% at 100% 100%, rgba(74,222,58,.07), transparent 70%)",
        }}
      />

      <div className="relative flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:gap-5 sm:px-6 sm:py-5">
        {/* HE IS THE FIRST THING IN THE ROOM. */}
        <div className="w-[84px] shrink-0 sm:w-[104px]">
          <J4Character state={state} size="fill" title={`J4 — ${state}`} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-[19px] font-semibold tracking-tight text-white sm:text-[22px]">
              J4 Office
            </h1>
            <p className="truncate text-[13px] text-white/45">{storeName}</p>
          </div>

          {/* The arc, from the direction. A rule rather than a headline: it is
              how the work is organised, not a slogan to shout. */}
          <ol className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-medium uppercase tracking-[.18em] text-[#4ade3a]/70">
            {OFFICE_ARC.map((step, i) => (
              <li key={step} className="flex items-center gap-2">
                {step}
                {i < OFFICE_ARC.length - 1 && (
                  <span aria-hidden="true" className="text-white/20">
                    &rsaquo;
                  </span>
                )}
              </li>
            ))}
          </ol>

          <p className="mt-2 max-w-prose text-[13px] leading-snug text-white/55">
            Everything you and I know about this business, in one place. Ask me
            anything, or start from what I&rsquo;ve found.
          </p>
        </div>
      </div>

      {/* WHAT HE IS HOLDING FOR THEM. Real counts, each leading somewhere. */}
      <div
        data-testid="office-facts"
        className="relative grid grid-cols-3 gap-px border-t border-white/[.06] bg-white/[.05] sm:grid-cols-6"
      >
        {facts.map((fact) => (
          <FactCell key={fact.label} fact={fact} onOpenView={onOpenView} />
        ))}
      </div>
    </section>
  );
}

/**
 * One number, and the one thing it leads to.
 *
 * A route renders as a real link and a view as a button, because they are
 * different acts and the browser should treat them differently - a link can be
 * opened in a new tab, a view cannot. The `title` is the fact's own source
 * sentence, so "where did this number come from" is answerable in place.
 */
function FactCell({
  fact,
  onOpenView,
}: {
  fact: OfficeFact;
  onOpenView: (view: string) => void;
}) {
  const testId = `office-fact-${fact.label.toLowerCase().replace(/\s+/g, "-")}`;
  const inner = (
    <>
      <span
        className={`font-mono text-[17px] leading-none tabular-nums ${
          fact.quiet ? "text-white/25" : "text-[#4ade3a]"
        }`}
      >
        {fact.value}
      </span>
      <span className="text-[10.5px] uppercase tracking-[.1em] text-white/40 group-hover:text-white/65">
        {fact.label}
      </span>
    </>
  );
  const className =
    "group flex flex-col items-start gap-1 bg-[#050807] px-3 py-2.5 text-left transition hover:bg-[#0b1310]";

  if (fact.target.kind === "route") {
    return (
      <Link href={fact.target.href} data-testid={testId} title={fact.source} className={className}>
        {inner}
      </Link>
    );
  }
  const view = fact.target.view;
  return (
    <button type="button" data-testid={testId} title={fact.source} onClick={() => onOpenView(view)} className={className}>
      {inner}
    </button>
  );
}
