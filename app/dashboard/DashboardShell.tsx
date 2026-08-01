"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { NavSection } from "@/lib/dashboard/navConfig";
import { PRIMARY_TAB_COUNT } from "@/lib/dashboard/navConfig";
import { NavIcon } from "./NavIcon";
import { signOutOfGenesis } from "./actions";
import { logClientEvent } from "./telemetry-actions";
import { GenesisAssistant } from "./GenesisAssistant";
import { GenesisDomicile } from "./GenesisDomicile";
import { LiveIntelligence } from "./LiveIntelligence";
import { GenesisLanguageLegend } from "./GenesisLanguageLegend";
import { MobileGenesisPresence } from "./MobileGenesisPresence";
import { MobileArrivalOverlay } from "./MobileArrivalOverlay";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { GENESIS_STATE_META } from "@/lib/dashboard/genesisState";
import { buildBriefing } from "@/lib/dashboard/genesisBriefing";
import { useFreshLaunch } from "@/lib/dashboard/useFreshLaunch";
import { useBeatSequence, type Beat } from "@/lib/dashboard/arrivalBeats";

type GenesisMessage = { id: string; role: string; content: string; changes: unknown };

// Contextual-review connection layer: one entry per still-pending approval
// that has a real owning section, resolved server-side in layout.tsx (see
// the comment there for why — this shell can't safely import
// ACTION_SECTIONS itself). `href` is the section's own route (without
// "?focus="), reused by both this shell's focus resolution and
// LiveIntelligence's decision rows.
interface FocusableApproval {
  id: string;
  section: string;
  href: string;
  summary: string;
  noticedSummary: string | null;
}

// Genesis Language propagating through navigation — approvals and
// observations merged into one list DashboardShell resolves "?focus="
// against (built in layout.tsx), `kind` distinguishing the two so
// GenesisAssistant's contextual banner knows whether a separate "what I
// recommend" line is honest to show (see GenesisAssistant.tsx).
interface FocusableItem extends FocusableApproval {
  kind: "approval" | "observation";
}

// Per-section (Identity/Website/Products, plus "home" for Your Business
// itself) Genesis Language state — computed once in layout.tsx from the
// same real approvals/observations data, never recomputed independently
// here. "idle" never renders a badge.
interface SectionNavState {
  state: "urgent" | "needs_decision" | "opportunity" | "idle";
  count: number;
  focusHref: string;
}

interface LiveObservation {
  dedupeKey: string;
  genesisState: string;
  summary: string;
  actionHref: string | null;
}

// The one place Genesis and "View Store" are instantiated for a live store
// — every section route renders as `children` inside this shell, so both
// are structurally present everywhere rather than something each new page
// has to remember to re-add. Active-section highlighting and the mobile
// "More" sheet need client state/usePathname, which is why this is a
// client component wrapping server-rendered children.
export function DashboardShell({
  sections,
  secondarySections,
  storeId,
  storeName,
  storefrontUrl,
  logoUrl,
  sectionBadgeCounts,
  sectionNavState,
  focusableItems,
  focusableApprovals,
  liveObservations,
  curiosityItems,
  userName,
  revenueInCents,
  orderCount,
  revenueTrend,
  newCustomerCount,
  genesisMessages,
  sendGenesisMessage,
  hasUrgentIssue,
  hasPendingDecision,
  hasOpportunity,
  hasCuriosity,
  children,
}: {
  sections: NavSection[];
  secondarySections: NavSection[];
  storeId: string;
  storeName: string;
  storefrontUrl: string | null;
  // Business Identity Generation (Arrival Experience milestone) — real
  // Store.logoUrl, honestly null until a business icon has been generated
  // (pre-milestone stores, or a forced generation failure). No stock-photo
  // placeholder: absence just means genesisIcon (Genesis's own mark) is the
  // only identity shown, same as before this milestone existed.
  logoUrl: string | null;
  sectionBadgeCounts: Record<string, number>;
  sectionNavState: Record<string, SectionNavState>;
  focusableItems: FocusableItem[];
  focusableApprovals: FocusableApproval[];
  liveObservations: LiveObservation[];
  curiosityItems: { id: string; summary: string }[];
  userName: string | null;
  revenueInCents: number | null;
  orderCount: number | null;
  revenueTrend: number[] | null;
  newCustomerCount: number | null;
  genesisMessages: GenesisMessage[];
  sendGenesisMessage: (formData: FormData) => void;
  hasUrgentIssue: boolean;
  hasPendingDecision: boolean;
  hasOpportunity: boolean;
  hasCuriosity: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [moreOpen, setMoreOpen] = useState(false); // mobile bottom sheet
  const [desktopMoreOpen, setDesktopMoreOpen] = useState(false); // top-bar dropdown

  // Arrival Experience V1 — returning-user "wake the office" (see memory
  // project_arrival_experience_milestone.md). isFreshLaunch starts false
  // (matching the server-rendered pass — see useFreshLaunch's own comment)
  // and flips true in an effect shortly after mount, at most once per real
  // fresh launch. dormant/returningActive below both start false too (for
  // the same hydration-safety reason) and pick up that flip using React's
  // documented "adjusting state when a value changes" pattern — the same
  // fix arrivalBeats.ts's useBeatSequence needed for its own autoStart
  // prop, and for the same reason: a plain mount-only effect keyed on
  // isFreshLaunch would only ever see its initial (always-false) value.
  const { isFreshLaunch, consume } = useFreshLaunch();

  // Desktop — a brief, independent wake (see GenesisDomicile/
  // LiveIntelligence's own dormant prop): starts dim, fades to full
  // opacity shortly after becoming true. Deliberately not tied to the
  // mobile beat sequence below — "briefly wake up," not the fuller mobile
  // ritual.
  const [dormant, setDormant] = useState(false);
  useEffect(() => {
    if (!dormant) return;
    const timer = setTimeout(() => setDormant(false), 1200);
    return () => clearTimeout(timer);
  }, [dormant]);

  // Mobile — the fuller "wake the office" ritual: a full-screen overlay
  // (shared with CreateBusinessArrival) playing a short, real beat
  // sequence, then fading out into MobileGenesisPresence's real position.
  const [returningActive, setReturningActive] = useState(false);
  const [returningLeaving, setReturningLeaving] = useState(false);

  const [prevIsFreshLaunch, setPrevIsFreshLaunch] = useState(isFreshLaunch);
  if (isFreshLaunch !== prevIsFreshLaunch) {
    setPrevIsFreshLaunch(isFreshLaunch);
    if (isFreshLaunch) {
      setDormant(true);
      setReturningActive(true);
    }
  }
  const returningBriefing = buildBriefing({ focusableApprovals, liveObservations, curiosityItems });
  const returningBeats: Beat[] = useMemo(
    () => [
      { text: userName ? `Welcome back, ${userName}.` : "Welcome back.", pauseBeforeMs: 300, holdMs: 1400 },
      { text: "Genesis has been watching over your business.", holdMs: 1400 },
      { text: returningBriefing ? returningBriefing.lead : "Everything's running smoothly today.", holdMs: 1600 },
      { text: `Let's open ${storeName}…`, holdMs: 1200 },
    ],
    [userName, returningBriefing, storeName]
  );
  const { activeBeat: returningBeat } = useBeatSequence(returningBeats, {
    autoStart: returningActive,
    onComplete: () => {
      setReturningLeaving(true);
      setTimeout(() => {
        setReturningActive(false);
        consume();
      }, 700);
    },
  });

  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);

  // Product Vision navigation correction — primary nav is exactly this
  // small at every breakpoint, not just on narrow screens. There is
  // deliberately no wider-screen tier that shows everything inline again
  // (the old xl:+ "no overflow needed" tier is gone) — "More" is a
  // permanent third primary destination, not a responsive overflow trick.
  const tabSections = sections.slice(0, PRIMARY_TAB_COUNT);
  const moreSections = sections.slice(PRIMARY_TAB_COUNT);
  const hasHiddenBadge = moreSections.some((s) => (sectionBadgeCounts[s.key] ?? 0) > 0);

  // Secondary nav only renders while the current route is genuinely one of
  // Your Business's own workspaces (Overview/Identity/Website/Products) —
  // never on Customers or anything under More.
  const isInYourBusiness = secondarySections.some((s) => isActive(s.href));

  // Contextual-review connection layer: a "?focus=<id>" is only honored
  // when it names a still-pending approval OR real observation (either
  // "kind" in the merged focusableItems list) AND that item's own section
  // matches where we actually are — an invalid, stale, resolved, or
  // mismatched-section id simply resolves to no context, never an error.
  const currentSecondarySection = secondarySections.find((s) => isActive(s.href));
  const focusId = searchParams.get("focus");
  const focusedItem =
    focusId && currentSecondarySection
      ? focusableItems.find((a) => a.id === focusId && a.section === currentSecondarySection.key)
      : undefined;

  // Family-beta instrumentation (v20) — navigation is otherwise completely
  // stateless (nothing records a page view today). Fire-and-forget, never
  // awaited by the caller and never blocking a real navigation — a failed
  // write here (see logProductEvent) can't break the page.
  const prevPathnameRef = useRef<string | null>(null);
  useEffect(() => {
    const fromSection = prevPathnameRef.current;
    prevPathnameRef.current = pathname;
    logClientEvent({
      storeId,
      name: "nav.section_view",
      category: "navigation",
      metadata: { section: pathname, fromSection },
    });
    // Only the pathname itself should re-trigger this — storeId is stable
    // for the life of this shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Whether a "?focus=" link actually resolved to a real item is currently
  // invisible (a stale/mismatched-section id silently no-ops) — this is the
  // one place that outcome becomes visible, both for reconstructing "did
  // v19's routing take the tester to the right place" and as a real latent-
  // bug signal (route_unresolved on a link Genesis itself just generated).
  useEffect(() => {
    if (!focusId || !currentSecondarySection) return;
    logClientEvent({
      storeId,
      name: focusedItem ? "focus.route_resolved" : "focus.route_unresolved",
      category: "navigation",
      attemptKey: focusId,
      outcome: focusedItem ? "success" : "failure",
      metadata: { section: currentSecondarySection.key },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, currentSecondarySection?.key, !!focusedItem]);

  const desktopTabLink = (section: NavSection) => {
    // Only "home" (Your Business) gets the color-aware treatment today —
    // every other primary section (Marketing/Payments/etc.) keeps its
    // existing flat Yellow-only badge from sectionBadgeCounts, unchanged.
    const nav = sectionNavState[section.key];
    const count = nav ? nav.count : sectionBadgeCounts[section.key] ?? 0;
    const meta = nav && nav.state !== "idle" ? GENESIS_STATE_META[nav.state] : GENESIS_STATE_META.needs_decision;
    return (
      <Link
        key={section.key}
        href={section.href}
        className={`flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors ${
          isActive(section.href)
            ? "bg-[var(--brand-accent,var(--foreground))]/10 font-medium text-[var(--brand-accent,var(--foreground))]"
            : "text-zinc-600 hover:bg-black/[.03] dark:text-zinc-400 dark:hover:bg-white/[.05]"
        }`}
      >
        <NavIcon section={section.key} className="h-4 w-4 shrink-0" />
        {section.label}
        {count > 0 && (
          <span
            className={`rounded-full ${meta.dotClassName.replace("animate-pulse ", "")} px-1.5 py-0.5 text-[10px] font-medium text-white`}
            aria-label={`${meta.label}: ${count}`}
          >
            {count}
          </span>
        )}
      </Link>
    );
  };

  // bg-foreground/text-background (not bg-[var(--brand-accent,...)]/text-white)
  // deliberately — this renders in DashboardShell's persistent chrome
  // (both the pre-lg: header and the TV-frame header below use this same
  // const), a separate DOM branch from any page's own themeCssVars(), so
  // --brand-accent is never actually in scope here and always falls back
  // to --foreground. --foreground flips light/dark (see globals.css) and
  // is meant for text, not "a bg white text stays readable on" — in dark
  // mode that fallback made this button white-on-near-white. The
  // foreground/background token pair (already used correctly elsewhere,
  // e.g. GenesisAssistant's user-message bubble) inverts correctly in
  // both modes automatically.
  const viewStoreLink = storefrontUrl ? (
    <a
      href={storefrontUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
    >
      View Store ↗
    </a>
  ) : (
    <span
      title="Publish your store to view it"
      className="flex cursor-not-allowed items-center gap-2 rounded-lg border border-black/[.08] px-3 py-2 text-sm text-zinc-400 dark:border-white/[.145] dark:text-zinc-600"
    >
      View Store
    </span>
  );

  // Genesis's own app icon (the canonical J4 brand asset — see
  // memory/project_j4_avatar_branding.md) — a fixed-identity badge, not
  // themed to light/dark like the surrounding chrome, the same way a real
  // app icon never adapts to its host's theme. Small and rounded so it
  // reads as a premium app icon next to the store name, not an
  // illustration competing with it. Shared so the desktop, TV-header, and
  // mobile homes below all render the exact same element.
  const genesisIcon = (
    <Image
      src="/brand/genesis-j4-avatar.png"
      alt="Genesis"
      width={28}
      height={28}
      className="shrink-0 rounded-[7px]"
    />
  );

  // Primary nav row content — storeName + tabs/More dropdown + View Store/
  // Sign out. Rendered from this one JSX value in two different homes (the
  // full-width bar below xl:, the framed TV's own header at xl:+ — see the
  // Genesis Environment shell below), the same "one value, multiple
  // mounted homes" pattern viewStoreLink above already uses. Sharing
  // `desktopMoreOpen` across both is safe since exactly one is ever
  // visible at a given viewport width — they never show simultaneously.
  const primaryNavRow = (
    <>
      {genesisIcon}
      <p className="shrink-0 truncate text-sm font-semibold text-black dark:text-zinc-50">{storeName}</p>
      {logoUrl && (
        // The business's own generated identity, distinct from Genesis's
        // (see the frozen design record's "Genesis and business have
        // separate visual identities" principle) — a small circular mark
        // beside the name, never replacing genesisIcon above. Plain <img>,
        // not next/image: real generated images live on Vercel Blob, an
        // arbitrary-per-deployment host next/image can't optimize without
        // remotePatterns config — the existing product-image gallery
        // (app/dashboard/products/page.tsx) already made this same call
        // for the same reason.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt={`${storeName} icon`}
          className="h-5 w-5 shrink-0 rounded-full object-cover"
        />
      )}

      <nav className="flex flex-1 items-center gap-1 overflow-hidden">
        {tabSections.map(desktopTabLink)}
        {moreSections.length > 0 && (
          <div className="relative shrink-0">
            <button
              onClick={() => setDesktopMoreOpen((open) => !open)}
              className={`relative flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                desktopMoreOpen
                  ? "bg-black/[.03] text-black dark:bg-white/[.05] dark:text-zinc-50"
                  : "text-zinc-600 hover:bg-black/[.03] dark:text-zinc-400 dark:hover:bg-white/[.05]"
              }`}
            >
              More
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-3.5 w-3.5">
                <path d="M6 9l6 6 6-6" />
              </svg>
              {hasHiddenBadge && (
                <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-400" />
              )}
            </button>
            {desktopMoreOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setDesktopMoreOpen(false)} />
                <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-lg border border-black/[.08] bg-white py-1 shadow-lg dark:border-white/[.145] dark:bg-zinc-900">
                  {moreSections.map((section) => {
                    // The row itself gets a subtle amber tint (not just the
                    // number pill) so the connection between the outer
                    // yellow "Decision" dot on the More button and the
                    // specific destination carrying it is unmistakable at
                    // a glance, not just a small badge easy to miss among
                    // plain-looking rows.
                    const hasBadge = (sectionBadgeCounts[section.key] ?? 0) > 0;
                    return (
                      <Link
                        key={section.key}
                        href={section.href}
                        onClick={() => setDesktopMoreOpen(false)}
                        className={`flex items-center gap-3 px-3 py-2 text-sm text-black dark:text-zinc-50 ${
                          hasBadge
                            ? "bg-amber-400/10 hover:bg-amber-400/15"
                            : "hover:bg-black/[.03] dark:hover:bg-white/[.05]"
                        }`}
                      >
                        <NavIcon section={section.key} className="h-4 w-4 shrink-0" />
                        <span className="flex-1">{section.label}</span>
                        {hasBadge && (
                          <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
                            {sectionBadgeCounts[section.key]}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </nav>

      <div className="flex shrink-0 items-center gap-2">
        {viewStoreLink}
        <form action={signOutOfGenesis}>
          <button
            type="submit"
            className="rounded-lg border border-black/[.08] px-3 py-2 text-sm text-zinc-600 hover:bg-black/[.03] dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.05]"
          >
            Sign out
          </button>
        </form>
      </div>
    </>
  );

  // Secondary nav — persistent, not a menu: rendered directly below the
  // primary bar (desktop) or mobile header, always visible the moment
  // you're anywhere inside Your Business, so switching Overview/Identity/
  // Website/Products never costs an extra click or a hidden state. Fixed
  // height (h-10) on both breakpoints so <main>'s padding math below stays
  // exact rather than measured at runtime.
  const secondaryNav = isInYourBusiness && (
    <nav
      className="fixed inset-x-0 top-[140px] z-30 flex h-10 items-center gap-1 overflow-x-auto border-b border-black/[.06] bg-white px-4 dark:border-white/[.1] dark:bg-zinc-950 md:top-14 lg:static lg:inset-auto lg:w-full lg:shrink-0 lg:px-4"
      aria-label="Your Business"
    >
      {secondarySections.map((section) => {
        // Badged secondary nav takes the owner to the work, not merely the
        // page — a section with an outstanding item deep-links straight to
        // its single highest-priority item (layout.tsx's sectionNavState,
        // reusing the same urgent > decision > opportunity priority the
        // rest of the Genesis Language already uses). Overview never gets
        // a badge — it aggregates/displays, it never "owns" an item (see
        // layout.tsx's audit comment). A colored, numbered pill (not just
        // a dot) so quantity and severity are both visible at a glance,
        // with an accessible label stating the real condition in words.
        const nav = section.key === "overview" ? undefined : sectionNavState[section.key];
        const hasBadge = !!nav && nav.state !== "idle";
        const href = hasBadge ? nav!.focusHref : section.href;
        return (
          <Link
            key={section.key}
            href={href}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1 text-sm transition-colors ${
              isActive(section.href)
                ? "bg-[var(--brand-accent,var(--foreground))]/10 font-medium text-[var(--brand-accent,var(--foreground))]"
                : "text-zinc-600 hover:bg-black/[.03] dark:text-zinc-400 dark:hover:bg-white/[.05]"
            }`}
          >
            {section.label}
            {hasBadge && (
              <span
                className={`rounded-full ${GENESIS_STATE_META[nav!.state].dotClassName.replace("animate-pulse ", "")} px-1.5 py-0.5 text-[10px] font-medium text-white`}
                aria-label={`${GENESIS_STATE_META[nav!.state].label}: ${nav!.count}`}
              >
                {nav!.count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  return (
    // The lg:bg-[#07060d] below is GENESIS_ATMOSPHERE.bg written literally,
    // not interpolated — Tailwind's class scanner works on static source
    // text, so a template-literal-interpolated arbitrary value like
    // `lg:bg-[${GENESIS_ATMOSPHERE.bg}]` never resolves to real CSS (the
    // scanner can't see through the JS expression). Every lg:-scoped
    // Tailwind color class in this file and GenesisAssistant.tsx is a
    // literal for the same reason; components that only ever render at
    // lg:+ to begin with (GenesisDomicile/LiveIntelligence/
    // GenesisLanguageLegend, all parent-gated via hidden lg:block) don't
    // have this problem and correctly use GENESIS_ATMOSPHERE via inline
    // `style` instead. Keep this value in sync with genesisAtmosphere.ts.
    <div className="min-h-screen bg-zinc-50 dark:bg-black lg:h-screen lg:overflow-hidden lg:bg-[#07060d]">
      {/* Genesis's environment backdrop — lg:+ only, fixed regardless of
          the owner's light/dark toggle (this is Genesis's own identity,
          not the app's dark mode; see genesisAtmosphere.ts). Purely
          decorative and non-interactive; a restrained radial wash for
          atmospheric depth, not a spotlight. The TV frame's own explicit
          background is unaffected — it reads as a bright object floating
          in this environment, not lit by it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none hidden lg:fixed lg:inset-0 lg:-z-10 lg:block"
        style={{
          background: `radial-gradient(ellipse 70% 55% at 8% 15%, ${GENESIS_ATMOSPHERE.violetGlow}, transparent 60%)`,
        }}
      />

      {/* Arrival Experience V1 — returning-user mobile ritual (see memory
          project_arrival_experience_milestone.md, "wake the office"). Fixed
          full-screen, so its position in the tree doesn't matter beyond
          being mounted; only renders on a real fresh launch, and only ever
          once per real sign-in (isFreshLaunch/consume above). */}
      {returningActive && (
        <MobileArrivalOverlay text={returningBeat?.text ?? ""} leaving={returningLeaving} />
      )}

      {/* Desktop top workspace bar — exactly the primary set (tabSections)
          plus one permanent "More". Below lg: this is the only nav
          chrome, exactly as already verified. At lg:+ it's hidden
          entirely — the Genesis Environment composition below replaces it
          with the same nav content moved into the framed Business
          workspace's own header, not a second competing nav system. */}
      <header className="fixed inset-x-0 top-0 z-40 hidden h-14 items-center gap-4 border-b border-black/[.06] bg-white px-4 dark:border-white/[.1] dark:bg-zinc-950 md:flex lg:hidden">
        {primaryNavRow}
      </header>

      {/* Mobile's own persistent Genesis presence — true mobile only, above
          the existing mobile header. Genesis speaks (this bar); the page
          identifies where you are (the header below it, and each page's
          own content) — two different layers, never merged into one. */}
      <MobileGenesisPresence
        hasUrgentIssue={hasUrgentIssue}
        hasPendingDecision={hasPendingDecision}
        hasOpportunity={hasOpportunity}
        hasCuriosity={hasCuriosity}
        focusableApprovals={focusableApprovals}
        liveObservations={liveObservations}
        curiosityItems={curiosityItems}
        userName={userName}
      />

      {/* Mobile top bar — explicit h-16 (not padding-driven) so the
          secondary nav below can stack under it at a known, exact offset.
          Offset by the new MobileGenesisPresence bar's own height (76px)
          above it. */}
      <header className="fixed inset-x-0 top-[76px] z-40 flex h-16 items-center justify-between border-b border-black/[.08] bg-white/90 px-4 backdrop-blur dark:border-white/[.145] dark:bg-zinc-950/90 md:hidden">
        {/* Business identity is the primary visual element here, not the
            View Store button — icon and store name both sized up from
            the shared desktop treatment so they read with real
            prominence at a glance. min-w-0 + truncate on the name (not
            the button) means if space ever runs out, the name is what
            gives way, never View Store. */}
        <div className="flex min-w-0 items-center gap-2.5">
          <Image
            src="/brand/genesis-j4-avatar.png"
            alt="Genesis"
            width={36}
            height={36}
            className="shrink-0 rounded-[8px]"
          />
          <p className="truncate text-lg font-bold text-black dark:text-zinc-50">{storeName}</p>
        </div>
        {viewStoreLink}
      </header>

      {/* Genesis Environment shell — lg:+ (1024px and up). Below lg:, this
          wrapper has no layout effect at all: secondaryNav/<main> render
          exactly as they do today (fixed, full width, unchanged padding
          math), and the old top bar above is what's actually visible.
          At lg:+, with that top bar hidden, this starts right at the top
          of the viewport (a deliberate lg:pt-10 for breathing room, not
          compensating for a header that no longer exists) as a
          height-contained composition — root's lg:h-screen
          lg:overflow-hidden above is the one true viewport boundary; only
          <main>'s own interior (below) is ever allowed to scroll. Left
          Genesis Domicile + center (Live Intelligence, unframed and
          ticker-style, directly above the framed Business "TV") render
          from lg: up; the right Genesis Language legend is the one piece
          that stays xl:-only (1280px+) — the lowest-priority region,
          deliberately the first (and only) thing to collapse as width
          decreases, per the grid template below. The TV houses its own
          primary + secondary navigation, replacing the old full-width bar
          rather than competing with it. */}
      <div className="lg:grid lg:h-full lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-6 lg:px-6 lg:pt-10 lg:pb-10 xl:mx-auto xl:max-w-[1600px] xl:grid-cols-[260px_minmax(0,1fr)_260px] xl:gap-8 xl:px-8">
        <aside
          className="hidden lg:block lg:border-r"
          style={{ borderColor: GENESIS_ATMOSPHERE.border }}
        >
          <GenesisDomicile
            hasUrgentIssue={hasUrgentIssue}
            hasPendingDecision={hasPendingDecision}
            hasOpportunity={hasOpportunity}
            hasCuriosity={hasCuriosity}
            dormant={dormant}
          />
        </aside>

        <div className="lg:flex lg:h-full lg:min-h-0 lg:min-w-0 lg:flex-col">
          <div className="hidden lg:block lg:shrink-0">
            <LiveIntelligence
              focusableApprovals={focusableApprovals}
              liveObservations={liveObservations}
              curiosityItems={curiosityItems}
              userName={userName}
              revenueInCents={revenueInCents}
              orderCount={orderCount}
              revenueTrend={revenueTrend}
              newCustomerCount={newCustomerCount}
              dormant={dormant}
            />
          </div>

          {/* Framed Business workspace ("the TV") — the border/background/
              flex-fill only ever apply at lg: (no `hidden` on this
              element, so secondaryNav's own fixed positioning and <main>
              keep rendering correctly below lg: exactly as before). Your
              Business / Customers / Marketing / Payments / Analytics /
              Settings live in this frame's own header now; when Your
              Business is active, Overview/Identity/Website/Products
              render directly beneath it as the second level, inside the
              same frame. A flex-grow *weight* (not lg:flex-1) deliberately
              caps this at roughly 80% of whatever's left below Live
              Intelligence — the empty spacer right after it claims the
              rest, so the environment reads as real, unclaimed space
              beneath an object ("the TV") rather than the TV filling the
              whole environment. <main>'s own lg:overflow-y-auto still
              makes it the one real scrolling surface if routed content is
              taller than this now-smaller footprint. */}
          <div className="lg:mt-4 lg:flex lg:min-h-0 lg:flex-[4] lg:flex-col lg:overflow-hidden lg:rounded-2xl lg:border lg:border-black/[.08] lg:bg-white dark:lg:border-white/[.145] dark:lg:bg-zinc-950">
            <div className="hidden lg:flex lg:h-14 lg:shrink-0 lg:items-center lg:gap-4 lg:border-b lg:border-black/[.08] lg:bg-black/[.02] lg:px-4 dark:lg:border-white/[.145] dark:lg:bg-white/[.03]">
              {primaryNavRow}
            </div>

            {secondaryNav}

            <main
              className={`pb-20 md:pb-0 lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:pb-0 ${
                isInYourBusiness ? "pt-[180px] md:pt-24 lg:pt-0" : "pt-[140px] md:pt-14 lg:pt-0"
              }`}
            >
              {children}
            </main>
          </div>

          {/* Deliberately open environment beneath the TV — empty, no
              border/background/content of its own; the page's own
              backdrop shows through. This is the "intentionally open"
              space from the wireframe review, not a placeholder for
              future content. */}
          <div className="hidden lg:block lg:flex-[1]" aria-hidden="true" />
        </div>

        <aside
          className="hidden xl:block xl:border-l xl:pl-6"
          style={{ borderColor: GENESIS_ATMOSPHERE.border }}
        >
          <GenesisLanguageLegend />
        </aside>
      </div>

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-black/[.08] bg-white/95 backdrop-blur dark:border-white/[.145] dark:bg-zinc-950/95 md:hidden">
        {tabSections.map((section) => (
          <Link
            key={section.key}
            href={section.href}
            className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${
              isActive(section.href)
                ? "text-[var(--brand-accent,var(--foreground))]"
                : "text-zinc-500 dark:text-zinc-400"
            }`}
          >
            <NavIcon section={section.key} className="h-5 w-5" />
            {section.label}
            {(sectionBadgeCounts[section.key] ?? 0) > 0 && (
              <span className="absolute right-4 top-1 h-2 w-2 rounded-full bg-amber-400" />
            )}
          </Link>
        ))}
        {moreSections.length > 0 && (
          <button
            onClick={() => setMoreOpen((open) => !open)}
            className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${
              moreOpen ? "text-[var(--brand-accent,var(--foreground))]" : "text-zinc-500 dark:text-zinc-400"
            }`}
          >
            <span className="text-base leading-none">•••</span>
            More
            {hasHiddenBadge && (
              <span className="absolute right-4 top-1 h-2 w-2 rounded-full bg-amber-400" />
            )}
          </button>
        )}
      </nav>

      {/* Mobile "More" sheet */}
      {moreOpen && (
        <div className="fixed inset-0 z-50 md:hidden" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-white p-4 pb-8 dark:bg-zinc-950"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative mb-3 flex items-center justify-center">
              <button
                onClick={() => setMoreOpen(false)}
                aria-label="Close menu"
                className="absolute inset-y-0 left-0 flex items-center px-1 text-zinc-400 hover:text-black dark:text-zinc-500 dark:hover:text-zinc-50"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-5 w-5">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
              <button
                onClick={() => setMoreOpen(false)}
                aria-label="Close menu"
                className="h-1.5 w-10 rounded-full bg-black/[.15] dark:bg-white/[.2]"
              />
            </div>
            <nav className="flex flex-col gap-1">
              {moreSections.map((section) => {
                // Same amber row-tint reasoning as the desktop dropdown
                // above — keeps the two "More" surfaces consistent.
                const hasBadge = (sectionBadgeCounts[section.key] ?? 0) > 0;
                return (
                  <Link
                    key={section.key}
                    href={section.href}
                    onClick={() => setMoreOpen(false)}
                    className={`flex items-center gap-3 rounded-lg px-2 py-2.5 text-sm text-black dark:text-zinc-50 ${
                      hasBadge ? "bg-amber-400/10" : ""
                    }`}
                  >
                    <NavIcon section={section.key} className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{section.label}</span>
                    {hasBadge && (
                      <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        {sectionBadgeCounts[section.key]}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>
            {/* Visually separated from navigation on purpose — a divider and
                red text so this never reads as "the way to close the menu"
                (tapping the handle, the ✕, "More" again, or the backdrop
                does that instead). */}
            <form action={signOutOfGenesis} className="mt-3 border-t border-black/[.08] pt-3 dark:border-white/[.145]">
              <button
                type="submit"
                className="w-full rounded-lg px-2 py-2.5 text-left text-sm text-red-600 hover:bg-red-500/5 dark:text-red-400"
              >
                Log out
              </button>
            </form>
          </div>
        </div>
      )}

      <GenesisAssistant
        storeName={storeName}
        messages={genesisMessages}
        sendMessage={sendGenesisMessage}
        hasUrgentIssue={hasUrgentIssue}
        hasPendingDecision={hasPendingDecision}
        hasOpportunity={hasOpportunity}
        hasCuriosity={hasCuriosity}
        focusedContext={
          focusedItem
            ? { summary: focusedItem.summary, noticedSummary: focusedItem.noticedSummary, kind: focusedItem.kind }
            : null
        }
      />
    </div>
  );
}
