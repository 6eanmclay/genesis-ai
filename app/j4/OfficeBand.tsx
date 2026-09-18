"use client";

import Link from "next/link";
import { J4Character, type J4State } from "@/components/j4/J4Character";
import { OFFICE_ARC, type OfficeFact } from "@/lib/j4/officeFacts";
import type { QuickAction } from "@/lib/j4/officeQuickActions";

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
/**
 * J4, HIMSELF, AND NOTHING ELSE — the one thing that is always on screen.
 *
 * ============ WHY THE BAND SPLIT IN TWO (2026-09-13) ==================
 *
 * Measured at 390x844, the old single band was 461px tall and it was PINNED:
 * the room is `fixed inset-0` and everything above the list is `shrink-0`, so
 * the band never scrolled away — it permanently shrank the window the work
 * was read through to 177px, holding 2288px of briefing. The first row the
 * owner could act on landed at 784px, below the bottom of that window. On a
 * phone, the Office arrival showed no actionable work at all.
 *
 * The band was also TALLER on the smaller screen — 461 against 302 — because
 * the intro row stacks J4 above his title below `sm`, the quick actions wrap
 * to two rows, and the strip's source sentences wrap. It grew where there was
 * least room.
 *
 * Sean's correction is an information hierarchy, not a responsive shrink:
 * presence -> work -> quick actions -> supporting context, the SAME order at
 * both widths. So what is pinned is now only what the owner needs from
 * anywhere — J4, whose room this is, and the tab rail. Everything else moved
 * into the scrolling region, below the work, as OfficeGrounding.
 *
 * Nothing was hidden and nothing was shrunk to achieve it. J4 is the same
 * size he was; he is simply no longer standing in front of the work.
 */
export function OfficePresence({
  storeName,
  state,
  /**
   * WHOSE PAGE THIS IS (2026-09-17).
   *
   * The room IS the page, so "J4 Office" is its h1. The layer is an overlay
   * over a business page that already has one — and because J4Overlay keeps
   * the Office MOUNTED while closed, giving the layer this band put a second
   * top-level heading into the DOM of every dashboard page, where it shadowed
   * the page's own. verify-business-map-browser found it immediately: its
   * "the greeting is above the map" passed against the closed overlay's
   * heading and "and it is the welcome" then failed on the text.
   *
   * Two h1s is wrong on the page regardless of who reads it first. The heading
   * is the same words and the same size either way; only its level follows the
   * surface, which is what heading levels are for.
   */
  heading = "h1",
}: {
  storeName: string;
  state: J4State;
  heading?: "h1" | "h2";
}) {
  const Heading = heading;
  return (
    <section
      data-testid="office-presence"
      aria-label={`J4's office for ${storeName}`}
      className="relative shrink-0 overflow-hidden border-b border-[#4ade3a]/15 bg-[#050807]"
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

      {/* BESIDE, AT EVERY WIDTH. The phone was the one place J4 was stacked
          ABOVE his own title — `flex-col sm:flex-row` — and that stacking
          bought 81 of the 159 extra pixels the band cost at 390. He is the
          same 84px he always was; only the adjacency changed, which is why
          this is not "hiding J4 to gain pixels". */}
      <div className="relative flex flex-row items-center gap-4 px-4 py-3 sm:gap-5 sm:px-6 sm:py-4">
        {/* HE IS THE FIRST THING IN THE ROOM, and now the only thing that
            never leaves it. */}
        <div className="w-[84px] shrink-0 sm:w-[104px]">
          <J4Character state={state} size="fill" title={`J4 — ${state}`} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Heading className="text-[19px] font-semibold tracking-tight text-white sm:text-[22px]">
              J4 Office
            </Heading>
            <p className="truncate text-[13px] text-white/45">{storeName}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * WHAT THE ROOM OFFERS, BELOW THE WORK IT IS ABOUT.
 *
 * The rest of the old band: the shortcuts the owner can start, the business
 * fact J4 is holding, the arc the work moves through, and what this room is
 * for. All of it still present, all of it still first-class — it simply sits
 * after the work rather than in front of it, in the region that scrolls.
 *
 * Sean: "The owner should encounter the work before the shortcuts."
 */
export function OfficeGrounding({
  storeName,
  facts,
  quickActions = [],
  onOpenView,
}: {
  storeName: string;
  facts: OfficeFact[];
  /**
   * What the owner can START — verbs, where `facts` are nouns.
   *
   * Defaulted to empty so a caller that has not loaded intelligence yet
   * renders nothing here rather than a row of nothing.
   */
  quickActions?: QuickAction[];
  /** An Office category is a view of THIS surface, never a navigation away. */
  onOpenView: (view: string) => void;
}) {
  return (
    <section
      data-testid="office-band"
      aria-label={`What J4's office offers for ${storeName}`}
      className="relative overflow-hidden rounded-xl border border-white/[.07] bg-[#050807]"
    >
      {/* WHAT YOU CAN START — FIRST HERE, because the owner has now already
          passed the work these shortcuts are shortcuts around. This row used
          to sit below the counts and above everything; the order within the
          Office is presence, work, then this.

          There is no fixed set and no overflow. Everything here passed a real
          permission gate and a real state gate in officeQuickActions — which
          is why an empty row simply does not render rather than showing
          disabled buttons. */}
      {quickActions.length > 0 && (
        <div
          data-testid="office-quick-actions"
          className="relative flex flex-wrap gap-2 px-4 py-3 sm:px-6"
        >
          {quickActions.map((action) => (
            <QuickActionButton key={action.key} action={action} onOpenView={onOpenView} />
          ))}
        </div>
      )}

      {/* WHAT HE IS HOLDING FOR THEM. Real counts, each leading somewhere. */}
      <div
        data-testid="office-facts"
        // TWO ACROSS ON A PHONE, five on a wide screen — one column per fact,
        // so each number sits directly above its own reason rather than being
        // squeezed into a sixth of a row with a sentence it cannot hold. The
        // strip was 3/6 when a cell was a number and a word.
        className="relative grid grid-cols-2 gap-px border-t border-white/[.06] bg-white/[.05] sm:grid-cols-3 lg:grid-cols-5"
      >
        {facts.map((fact) => (
          <FactCell key={fact.label} fact={fact} onOpenView={onOpenView} />
        ))}
      </div>

      {/* WHAT THIS ROOM IS, last. The arc is how the work is organised and the
          sentence below it is what the room is for — orientation, which an
          owner needs once and then needs to be able to scroll past. It was
          permanent chrome on every visit, in the pixels the work needed. */}
      <div className="relative border-t border-white/[.06] px-4 py-3 sm:px-6">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-medium uppercase tracking-[.18em] text-[#4ade3a]/70">
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
    </section>
  );
}

/**
 * One number, what it is, and where it came from.
 *
 * A route renders as a real link and a view as a button, because they are
 * different acts and the browser should treat them differently - a link can be
 * opened in a new tab, a view cannot.
 *
 * ============ THE SOURCE IS ON THE SURFACE NOW (2026-09-12) ========
 *
 * It was the `title` attribute and nothing else, which meant "where did this
 * number come from" was answerable only by a mouse hovering a desktop. On the
 * phone the reasoning simply did not exist. The number was shown and its
 * justification was not, which is the same defect as every other place in this
 * codebase where evidence was computed and then dropped at the last step.
 *
 * Data & Connections set the vocabulary this follows: say what is known, and
 * say where each piece came from, in the open. The Office keeps its own dark
 * ground — it is J4's room, and the shared chrome unifies the system without
 * flattening the rooms — but the discipline is the same one.
 *
 * `title` is KEPT as well as rendered: it is a real affordance for a pointer,
 * and verify-office-arrival reads it to prove the strip says what it means.
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
      {/* THE NUMBER HAS ITS OWN HANDLE (2026-09-12). verify-office-arrival
          read the strip's counts by stripping non-digits from the whole
          cell's text — fine when a cell was a number and a word, wrong the
          moment the source sentence joined it, because the product is called
          J4 and "things J4 noticed" turns a 3 into 34. The reader now takes
          this element, which is still the rendered number on the real screen
          and not an attribute the UI could set independently of what it
          shows. */}
      <span
        data-testid={`${testId}-value`}
        className={`font-mono text-[17px] leading-none tabular-nums ${
          fact.quiet ? "text-white/25" : "text-[#4ade3a]"
        }`}
      >
        {fact.value}
      </span>
      <span className="text-[10.5px] uppercase tracking-[.1em] text-white/40 group-hover:text-white/65">
        {fact.label}
      </span>
      {/* NO DIGITS IN HERE, EVER — enforced by noSourceCarriesADigit. The
          strip's counts are read off this cell's textContent by stripping
          non-digits, and that reader is what catches a count contradicting
          the section beneath it. */}
      <span
        data-testid={`${testId}-source`}
        className="text-[11px] leading-snug text-white/30 group-hover:text-white/45"
      >
        {fact.source}
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

/**
 * One thing the owner can start, with the reason it is on offer.
 *
 * A route is a real link and a view is a button, the same distinction
 * FactCell draws and for the same reason. `because` is rendered, not
 * hovered — the Office's own rule since 2026-09-12: the number is on the
 * surface, so the reason for it is too.
 *
 * A limitation renders as its own line and is never a disabled state. The
 * marketing room genuinely works; it simply cannot send or measure a campaign
 * until an email platform is connected, and saying so is more useful than
 * greying out a door that opens.
 */
function QuickActionButton({
  action,
  onOpenView,
}: {
  action: QuickAction;
  onOpenView: (view: string) => void;
}) {
  const testId = `office-action-${action.key}`;
  const inner = (
    <>
      <span className="text-[13px] font-medium text-white/90 group-hover:text-white">
        {action.label}
      </span>
      <span className="text-[11px] leading-snug text-white/35 group-hover:text-white/55">
        {action.because}
      </span>
      {action.limitation && (
        <span
          data-testid={`${testId}-limitation`}
          className="text-[11px] leading-snug text-[#E2A33C]/75"
        >
          {action.limitation}
        </span>
      )}
    </>
  );
  const className =
    "group flex max-w-[19rem] flex-col items-start gap-0.5 rounded-lg border border-[#4ade3a]/20 bg-[#4ade3a]/[.06] px-3 py-2 text-left transition hover:border-[#4ade3a]/40 hover:bg-[#4ade3a]/[.10]";

  if (action.target.kind === "route") {
    return (
      <Link href={action.target.href} data-testid={testId} className={className}>
        {inner}
      </Link>
    );
  }
  const view = action.target.view;
  return (
    <button type="button" data-testid={testId} onClick={() => onOpenView(view)} className={className}>
      {inner}
    </button>
  );
}
