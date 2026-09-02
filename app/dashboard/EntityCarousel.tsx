"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ANONYMOUS_CUSTOMER_LABEL, type Certainty } from "@/lib/businessModel/businessMap";
import type { MapEntity } from "@/lib/businessModel/mapEntities";
import { useJ4Ask } from "./J4AskContext";
import type { DomainDestination } from "./BusinessMapCanvas";

// THE SECOND LAYER OF THE MAP: WHAT J4 KNOWS ABOUT ONE THING.
//
// ============ WHY A CAROUSEL AND NOT A LIST (2026-09-02) ===============
//
// Sean: "The Business Map shouldn't just tell me that something exists. It
// should be a place where I can actually understand what J4 knows about that
// thing."
//
// A list is a table of contents — it answers "what is in here", which the map
// already answered. One thing at a time, with room, answers "what do you know
// about this", which is the question the map could not previously take.
//
// ============ NOT A STRIP OF TILES ====================================
//
// Sean: "Don't make the carousel just a horizontal strip of tiny cards. Each
// entity should have enough room to show its image/content and a meaningful
// description."
//
// So a card is `min(100%, 27rem)` and scroll-snaps to centre. On a phone that
// is the whole width and one card fills the view; on a desktop its neighbours
// show at the edges, which is what makes it read as a collection rather than a
// detail screen. It is real overflow, so a phone swipes it natively and a
// keyboard reaches every card — the arrows are an addition, not the only way.
//
// ============ EVERY LINE IS READ, NOT WRITTEN =========================
//
// The facts come off the record (see businessMap.ts). "What J4 noticed" is a
// real GenesisObservation whose `recordId` is this record — not a sentence
// generated to fill the section. An entity with no observation shows no
// section, because an empty "J4 noticed:" implies J4 looked and found nothing
// when it never looked.

function certaintyColor(c: Certainty): string {
  if (c === "known") return "var(--map-known)";
  if (c === "inferred") return "var(--map-inferred)";
  return "var(--map-unknown)";
}

/**
 * What an owner is handed to J4 when they ask about one thing.
 *
 * THE HONEST LIMIT OF THE EXISTING SEAM. `useJ4Ask` carries text into the real
 * composer and nothing else — no hidden payload, no second send path (see
 * J4AskContext.tsx for why that matters). So the context is carried the way a
 * person would carry it: by naming the thing precisely enough that J4's own
 * tools can find it. No record id, which an owner would see and could not read.
 */
function askText(entity: MapEntity, domainLabel: string): string {
  // A CUSTOMER WITH NO NAME IS CALLED "Customer", so asking J4 about the
  // "customer Customer" would be asking about nobody. The question is framed
  // instead by the one commercial fact the card already shows, which J4's own
  // tools can resolve — without putting a contact detail back on the screen
  // that the label was changed to keep off it.
  if (entity.label === ANONYMOUS_CUSTOMER_LABEL) {
    const spend = entity.facts.find((f) => f.label === "Spent with you");
    if (spend) {
      return `Tell me what you know about the customer who has spent ${spend.value} with me, and what you would do about it.`;
    }
    return `Tell me what you know about my customers, and what you would do about them.`;
  }
  const what = entity.kind ? `${entity.kind.toLowerCase()} "${entity.label}"` : `"${entity.label}"`;
  return `Tell me what you know about the ${what} in ${domainLabel.toLowerCase()}, and what you would do about it.`;
}

function Card({
  entity,
  domainLabel,
  destination,
  noticed,
  onConnect,
}: {
  entity: MapEntity;
  domainLabel: string;
  destination: DomainDestination | null;
  noticed: string[];
  onConnect: (() => void) | null;
}) {
  const { ask, available } = useJ4Ask();
  const [broken, setBroken] = useState(false);
  const showImage = entity.image !== null && !broken;

  return (
    <article
      data-testid="entity-card"
      // NO RECORD ID IN THE MARKUP. `internalContactId` builds a contact's id
      // as `internal:contact:<email>`, so echoing it into an attribute would
      // put the address back on the landing screen — invisible, but present in
      // the page. Nothing read this; it was mine, for debugging.
      // PORTRAIT ON A PHONE, LANDSCAPE ON A DESKTOP. A desktop stage is wide
      // and short, so stacking a photograph above the text left the facts
      // nowhere to go; side by side, the same card has half again as much
      // room for what J4 knows.
      className="flex w-[min(100%,27rem)] shrink-0 snap-center flex-col overflow-hidden rounded-2xl border border-black/[.09] bg-[var(--map-surface)] shadow-sm sm:w-[min(100%,33rem)] sm:flex-row dark:border-white/[.12]"
    >
      {/* ---- the thing itself, where there is a picture of it -------------- */}
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={entity.image!}
          alt=""
          onError={() => setBroken(true)}
          className="h-32 w-full shrink-0 border-b border-black/[.06] object-cover sm:h-auto sm:w-[10rem] sm:self-stretch sm:border-b-0 sm:border-r dark:border-white/[.08]"
        />
      ) : (
        // NO PLACEHOLDER PHOTOGRAPH. A quiet band carrying the certainty
        // colour, so a card without a picture still reads as belonging to the
        // same set rather than as a picture that failed.
        <div
          className="h-1.5 w-full shrink-0 sm:h-auto sm:w-1.5"
          style={{ background: certaintyColor(entity.certainty), opacity: 0.55 }}
          aria-hidden
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col p-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {entity.kind && (
            <span className="rounded-full bg-black/[.05] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--map-soft)] dark:bg-white/[.08]">
              {entity.kind}
            </span>
          )}
          {/* THE DISTINCTION SEAN ASKED TO KEEP, on every single card. */}
          <span
            data-testid="entity-certainty"
            className="inline-flex items-center gap-1.5 text-[11px] text-[var(--map-soft)]"
          >
            <i
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{
                background: entity.certainty === "unknown" ? "transparent" : certaintyColor(entity.certainty),
                border: entity.certainty === "unknown" ? "1px solid currentColor" : undefined,
              }}
              aria-hidden
            />
            {entity.state}
          </span>
        </div>

        <h3 className="mt-2 text-base font-semibold leading-snug text-[var(--map-ink)]">{entity.label}</h3>

        {/* THE MIDDLE SCROLLS, THE ACTIONS DO NOT. Cards share a height so the
            carousel reads as one set; a long asset summary must not push "Ask
            J4" off the bottom of the card it belongs to. */}
        <div className="mt-2.5 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
        {entity.detail && (
          <p className="text-[13px] leading-relaxed text-[var(--map-soft)]">{entity.detail}</p>
        )}

        {entity.facts.length > 0 && (
          <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-black/[.06] pt-2.5 text-[12px] dark:border-white/[.08]">
            {entity.facts.map((f) => (
              <div key={f.label} className="col-span-2 grid grid-cols-subgrid">
                <dt className="text-[var(--map-soft)]">{f.label}</dt>
                <dd className="text-right font-medium text-[var(--map-ink)] tabular-nums">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {/* ---- a real observation about THIS record, or nothing ------------ */}
        {noticed.length > 0 && (
          <div
            data-testid="entity-noticed"
            className="rounded-lg border border-[var(--map-inferred)]/25 bg-[var(--map-inferred)]/[.06] px-2.5 py-2"
          >
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--map-inferred)]">
              J4 noticed
            </p>
            {noticed.map((n) => (
              <p key={n} className="mt-1 text-[12px] leading-snug text-[var(--map-ink)]">{n}</p>
            ))}
          </div>
        )}

        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-black/[.06] pt-3 dark:border-white/[.08]">
          {/* ASK J4 LEADS. It is the one action that works for every entity on
              the map, including the ones with no screen behind them. */}
          {available && (
            <button
              type="button"
              data-testid="entity-ask"
              onClick={() => ask(askText(entity, domainLabel))}
              className="rounded-full bg-[var(--map-inferred)] px-3 py-1.5 text-[12px] font-medium text-white"
            >
              Ask J4 about this
            </button>
          )}
          {onConnect && (
            <button
              type="button"
              data-testid="entity-connect"
              onClick={onConnect}
              className="rounded-full border border-black/[.14] px-3 py-1.5 text-[12px] font-medium text-[var(--map-ink)] dark:border-white/[.22]"
            >
              Connect
            </button>
          )}
          {destination && (
            <Link
              href={destination.href}
              data-testid="entity-destination"
              className="rounded-full border border-black/[.14] px-3 py-1.5 text-[12px] font-medium text-[var(--map-ink)] dark:border-white/[.22]"
            >
              {destination.label}
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

export function EntityCarousel({
  entities,
  domainLabel,
  destination,
  noticed,
  onConnect,
}: {
  entities: MapEntity[];
  domainLabel: string;
  destination: DomainDestination | null;
  /** Real observations, keyed by the record they are about. */
  noticed: Record<string, string[]>;
  /** Opens the connection chooser for a prospect. Null when there is none. */
  onConnect: ((serviceId: string | null) => void) | null;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);

  const step = useCallback((dir: -1 | 1) => {
    const el = track.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>("[data-testid='entity-card']");
    el.scrollBy({ left: dir * ((card?.offsetWidth ?? el.clientWidth) + 16), behavior: "smooth" });
  }, []);

  // Which card is centred, read off the real scroll position rather than
  // tracked separately — so a native swipe and the arrows can never disagree.
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const onScroll = () => {
      const cards = Array.from(el.querySelectorAll<HTMLElement>("[data-testid='entity-card']"));
      const mid = el.scrollLeft + el.clientWidth / 2;
      let best = 0;
      let bestGap = Infinity;
      cards.forEach((c, i) => {
        const gap = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid);
        if (gap < bestGap) { bestGap = gap; best = i; }
      });
      setAt(best);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [entities]);

  if (entities.length === 0) {
    // HONEST EMPTY. Sean, from the start of this milestone: "If something isn't
    // actually known yet, represent that honestly rather than filling it in."
    return (
      <div data-testid="entity-empty" className="px-6 py-10 text-center">
        <p className="text-sm font-medium text-[var(--map-ink)]">
          J4 doesn&apos;t know anything about {domainLabel.toLowerCase()} yet.
        </p>
        <p className="mx-auto mt-1 max-w-sm text-[13px] leading-relaxed text-[var(--map-soft)]">
          Nothing has reached this part of your business. It fills in on its own as you work.
        </p>
        {destination && (
          <Link
            href={destination.href}
            data-testid="entity-destination"
            className="mt-3 inline-block rounded-full border border-black/[.14] px-3 py-1.5 text-[12px] font-medium text-[var(--map-ink)] dark:border-white/[.22]"
          >
            {destination.label}
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="entity-carousel">
      {/* THE CONTROLS SIT ABOVE THE CARDS (2026-09-02). At the bottom of
          the stage they were covered by J4's own summon orb, which floats
          over the page on a phone -- seen in a screenshot, not in any
          assertion. Here they also read as part of the branch heading:
          which of J4's six things am I looking at.  */}
      {/* ONE THING IS NOT A COLLECTION. "1 of 1" beside two dead arrows is
          chrome describing itself; a branch holding a single thing just shows
          the thing. */}
      <div className={`shrink-0 items-center justify-center gap-3 px-4 pb-2 ${entities.length > 1 ? "flex" : "hidden"}`}>
        <button
          type="button"
          data-testid="carousel-prev"
          onClick={() => step(-1)}
          disabled={at === 0}
          aria-label="Previous"
          className="rounded-full border border-black/[.10] px-2.5 py-1 text-[13px] leading-none text-[var(--map-soft)] disabled:opacity-35 dark:border-white/[.16]"
        >
          ‹
        </button>
        <p data-testid="carousel-position" className="text-[11px] tabular-nums text-[var(--map-soft)]">
          {at + 1} of {entities.length}
        </p>
        <button
          type="button"
          data-testid="carousel-next"
          onClick={() => step(1)}
          disabled={at >= entities.length - 1}
          aria-label="Next"
          className="rounded-full border border-black/[.10] px-2.5 py-1 text-[13px] leading-none text-[var(--map-soft)] disabled:opacity-35 dark:border-white/[.16]"
        >
          ›
        </button>
      </div>

      <div
        ref={track}
        // `overscroll-x-contain` so swiping past the last card does not walk
        // the browser back a page on iOS.
        className="flex min-h-0 flex-1 snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain scroll-smooth px-[max(1rem,calc((100%-27rem)/2))] pb-2 sm:px-[max(1rem,calc((100%-33rem)/2))]"
        role="group"
        aria-label={`${entities.length} in ${domainLabel}`}
      >
        {entities.map((e) => (
          <Card
            key={e.id}
            entity={e}
            domainLabel={domainLabel}
            destination={destination}
            noticed={(e.recordId && noticed[e.recordId]) || []}
            onConnect={
              onConnect && e.connectable ? () => onConnect(e.serviceId) : null
            }
          />
        ))}
      </div>

    </div>
  );
}
