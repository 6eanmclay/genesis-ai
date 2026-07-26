import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, resolveUserStore } from "@/lib/permissions";
import { NAV_SECTIONS } from "@/lib/dashboard/navConfig";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { ACTION_SECTIONS } from "@/lib/execution/genesisActions";
import { getBaseUrl } from "@/lib/integrations/util";
import { sendStoreMessage } from "./ai-actions";
import { signOutOfGenesis } from "./actions";
import { DashboardShell } from "./DashboardShell";

// Two entirely different chrome states share this one layout: a user with
// no live store yet (still in the draft/onboarding wizard, page.tsx's own
// two early-return branches) gets just the minimal sign-out chrome it
// always had — the wizard is a linear flow, not a nav destination, so it
// stays outside the section shell. A user with a live store gets the full
// multi-section app shell. Both branches re-check auth/resolve the store
// themselves rather than threading data down, matching this codebase's
// existing per-component-fetches-its-own-data convention.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const resolved = await resolveUserStore(session.user.id);

  if (!resolved) {
    return (
      <div className="relative">
        <form action={signOutOfGenesis} className="fixed top-3 right-3 z-50">
          <button
            type="submit"
            className="rounded-full border border-black/[.08] bg-white/90 px-3 py-1.5 text-xs font-medium text-zinc-600 shadow-sm backdrop-blur transition-colors hover:bg-white dark:border-white/[.145] dark:bg-zinc-900/90 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Sign out
          </button>
        </form>
        {children}
      </div>
    );
  }

  const { store, role } = resolved;
  // Filtering by real hasPermission belongs here, not in navConfig.ts —
  // that file is imported directly by the client-side DashboardShell, and
  // a value import of hasPermission would drag lib/permissions.ts's
  // prisma dependency into the browser bundle.
  const sections = NAV_SECTIONS.filter(
    (section) => !section.permission || hasPermission(role, section.permission)
  );

  const [storeMessages, pendingApprovals, activeObservations] = await Promise.all([
    prisma.storeMessage.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "asc" } }),
    hasPermission(role, PERMISSIONS.ANALYTICS_VIEW) ? getPendingApprovals(store.id) : Promise.resolve([]),
    // Phase 4 — the real, deduplicated Purple/Red signals. A cheap, indexed
    // read (same status/storeId index every other approval query already
    // uses the shape of) — never an AI call.
    prisma.genesisObservation.findMany({
      where: { storeId: store.id, status: "ACTIVE" },
      select: { genesisState: true },
    }),
  ]);
  const hasUrgentIssue = activeObservations.some((o) => o.genesisState === "urgent");
  const hasOpportunity = activeObservations.some((o) => o.genesisState === "opportunity");

  // The owner/employee can now preview their own storefront whether it's
  // published or not (app/store/[slug]/page.tsx allows owner/employee
  // preview of an unpublished store) — so View Store is always a real,
  // working link, not just once the store goes live.
  const storefrontUrl = `${await getBaseUrl()}/store/${store.slug}`;

  // Each pending approval's real Approve/Reject/Regenerate controls live on
  // its owning section (see ACTION_SECTIONS), so that section's nav item
  // gets the badge — but Home also keeps the total, since "does my business
  // need me?" is Home's whole job even though the decision itself happens
  // elsewhere. Phase 4: counted by distinct (groupId ?? id), not raw row
  // count — one Genesis thought with 3 proposals is one pending decision,
  // not three, everywhere a badge/count is shown.
  const seenGroupsPerSection = new Map<string, Set<string>>();
  const seenGroupsTotal = new Set<string>();
  for (const approval of pendingApprovals) {
    const groupKey = approval.groupId ?? approval.id;
    seenGroupsTotal.add(groupKey);
    const key = ACTION_SECTIONS[approval.actionType]?.key;
    if (key) {
      if (!seenGroupsPerSection.has(key)) seenGroupsPerSection.set(key, new Set());
      seenGroupsPerSection.get(key)!.add(groupKey);
    }
  }
  const sectionBadgeCounts: Record<string, number> = { home: seenGroupsTotal.size };
  for (const [key, groupSet] of seenGroupsPerSection) {
    sectionBadgeCounts[key] = groupSet.size;
  }

  return (
    <DashboardShell
      sections={sections}
      storeName={store.name}
      storefrontUrl={storefrontUrl}
      sectionBadgeCounts={sectionBadgeCounts}
      genesisMessages={storeMessages}
      sendGenesisMessage={sendStoreMessage}
      // The real Genesis Language signals — Yellow reuses the same grouped
      // count computed above; Purple/Red are real, deduplicated
      // GenesisObservation rows (Phase 4), never faked.
      hasUrgentIssue={hasUrgentIssue}
      hasPendingDecision={seenGroupsTotal.size > 0}
      hasOpportunity={hasOpportunity}
    >
      {children}
    </DashboardShell>
  );
}
