"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavSection } from "@/lib/dashboard/navConfig";
import { MOBILE_TAB_COUNT } from "@/lib/dashboard/navConfig";
import { NavIcon } from "./NavIcon";
import { signOutOfGenesis } from "./actions";
import { GenesisAssistant } from "./GenesisAssistant";

type GenesisMessage = { id: string; role: string; content: string; changes: unknown };

// The one place Genesis and "View Store" are instantiated for a live store
// — every section route renders as `children` inside this shell, so both
// are structurally present everywhere rather than something each new page
// has to remember to re-add. Active-section highlighting and the mobile
// "More" sheet need client state/usePathname, which is why this is a
// client component wrapping server-rendered children.
export function DashboardShell({
  sections,
  storeName,
  storefrontUrl,
  sectionBadgeCounts,
  genesisMessages,
  sendGenesisMessage,
  hasUrgentIssue,
  hasPendingDecision,
  hasOpportunity,
  children,
}: {
  sections: NavSection[];
  storeName: string;
  storefrontUrl: string | null;
  sectionBadgeCounts: Record<string, number>;
  genesisMessages: GenesisMessage[];
  sendGenesisMessage: (formData: FormData) => void;
  hasUrgentIssue: boolean;
  hasPendingDecision: boolean;
  hasOpportunity: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false); // mobile bottom sheet
  const [desktopMoreOpen, setDesktopMoreOpen] = useState(false); // md/lg top-bar dropdown

  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);

  // Same primary/overflow split mobile's bottom nav already uses — reused,
  // not reinvented, for the md/lg desktop tier below (see Workspace v1
  // plan: ~1230px is roughly what all 8 sections + store name + actions
  // need in one row, so only xl:+ shows them all inline).
  const tabSections = sections.slice(0, MOBILE_TAB_COUNT);
  const moreSections = sections.slice(MOBILE_TAB_COUNT);
  const hasHiddenBadge = moreSections.some((s) => (sectionBadgeCounts[s.key] ?? 0) > 0);

  const desktopTabLink = (section: NavSection) => (
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
      {(sectionBadgeCounts[section.key] ?? 0) > 0 && (
        <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
          {sectionBadgeCounts[section.key]}
        </span>
      )}
    </Link>
  );

  const viewStoreLink = storefrontUrl ? (
    <a
      href={storefrontUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-lg bg-[var(--brand-accent,var(--foreground))] px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
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

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      {/* Desktop top workspace bar — replaces the old left sidebar (Genesis
          Workspace v1). Two overflow tiers, both driven by the exact same
          `sections`/`sectionBadgeCounts` data as mobile: md/lg show the
          same primary-4 set as the mobile bottom nav plus a "More"
          dropdown; xl+ has room to show every section inline with no
          overflow at all (see the Workspace v1 plan for the width math). */}
      <header className="fixed inset-x-0 top-0 z-40 hidden h-14 items-center gap-4 border-b border-black/[.06] bg-white px-4 dark:border-white/[.1] dark:bg-zinc-950 md:flex">
        <p className="shrink-0 truncate text-sm font-semibold text-black dark:text-zinc-50">{storeName}</p>

        {/* md/lg tier */}
        <nav className="flex flex-1 items-center gap-1 overflow-hidden xl:hidden">
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
                  <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500" />
                )}
              </button>
              {desktopMoreOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setDesktopMoreOpen(false)} />
                  <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-lg border border-black/[.08] bg-white py-1 shadow-lg dark:border-white/[.145] dark:bg-zinc-900">
                    {moreSections.map((section) => (
                      <Link
                        key={section.key}
                        href={section.href}
                        onClick={() => setDesktopMoreOpen(false)}
                        className="flex items-center gap-3 px-3 py-2 text-sm text-black hover:bg-black/[.03] dark:text-zinc-50 dark:hover:bg-white/[.05]"
                      >
                        <NavIcon section={section.key} className="h-4 w-4 shrink-0" />
                        <span className="flex-1">{section.label}</span>
                        {(sectionBadgeCounts[section.key] ?? 0) > 0 && (
                          <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
                            {sectionBadgeCounts[section.key]}
                          </span>
                        )}
                      </Link>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </nav>

        {/* xl+ tier — no overflow needed at this width */}
        <nav className="hidden flex-1 items-center gap-1 xl:flex">
          {sections.map(desktopTabLink)}
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
      </header>

      {/* Mobile top bar */}
      <header className="fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-black/[.08] bg-white/90 px-4 py-3 backdrop-blur dark:border-white/[.145] dark:bg-zinc-950/90 md:hidden">
        <p className="truncate text-sm font-semibold text-black dark:text-zinc-50">{storeName}</p>
        {viewStoreLink}
      </header>

      <main className="pt-16 pb-20 md:pb-0 md:pt-14">{children}</main>

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
              <span className="absolute right-4 top-1 h-2 w-2 rounded-full bg-red-500" />
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
              <span className="absolute right-4 top-1 h-2 w-2 rounded-full bg-red-500" />
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
              {moreSections.map((section) => (
                <Link
                  key={section.key}
                  href={section.href}
                  onClick={() => setMoreOpen(false)}
                  className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-sm text-black dark:text-zinc-50"
                >
                  <NavIcon section={section.key} className="h-4 w-4 shrink-0" />
                  <span className="flex-1">{section.label}</span>
                  {(sectionBadgeCounts[section.key] ?? 0) > 0 && (
                    <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      {sectionBadgeCounts[section.key]}
                    </span>
                  )}
                </Link>
              ))}
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
      />
    </div>
  );
}
