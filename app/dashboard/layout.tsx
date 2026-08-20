import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { resolveUserStore } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { signOutOfGenesis } from "./actions";
import { BusinessWorkspace } from "./BusinessWorkspace";


// Reliability hardening — Server Actions can only have their execution
// timeout raised at the PAGE/LAYOUT level (Next.js's own maxDuration route
// segment config), never per-action. Set here so it covers every Server
// Action used anywhere under /dashboard/* — chat send, "Review My
// Business" (runCognitiveReview, measured 15-40+ seconds live), and
// image regeneration (measured 30-56+ seconds live).
//
// Corrected 2026-08-05, real production evidence — the earlier comment
// here ("genuinely inert on Hobby, hard-capped at 10s") was wrong. Vercel's
// current docs (vercel.com/docs/functions/configuring-functions/duration,
// checked directly, not assumed) and the real "Fluid Active CPU" usage
// metric on this project's own dashboard both confirm Fluid Compute is
// enabled by default on every plan, including Hobby — real duration
// ceiling is 300s (5 minutes), not 10s. Empirically confirmed live: a real
// production call to /api/generate-store-draft ran 189.9s and succeeded.
//
// This setting was NEVER inert, and is genuinely load-bearing: a real
// content-changing chat turn (applyGenesisMessageToStore) runs a
// sequential CONTROL call followed by a CONTENT call, each individually
// the same class of call measured elsewhere in this codebase at 30-110+
// seconds — two of those in sequence can genuinely exceed 90s. Raised to
// match the real Vercel Hobby ceiling exactly (300s) rather than guessing
// a smaller number — there's no cost to using the full budget the plan
// already allows.
export const maxDuration = 300;

// Two entirely different chrome states share this one layout: a user with
// no live store yet (still in the draft/onboarding wizard, page.tsx's own
// two early-return branches) gets just the minimal sign-out chrome it
// always had — the wizard is a linear flow, not a nav destination, so it
// stays outside the section shell. A user with a live store gets the full
// multi-section app shell. Both branches re-check auth/resolve the store
// themselves rather than threading data down, matching this codebase's
// existing per-component-fetches-its-own-data convention.
// J4 is handed to the shell as rendered content, not routed to (2026-08-14).
//
// This replaced a parallel-route slot plus an intercepting route. Sean's
// correction: "J4 is not a destination or a separate page that the user
// navigates into and out of. J4 is a persistent intelligence layer within the
// business workspace." Routing could not express that — every summon was a
// navigation, with the scroll resets, history entries and remounts that come
// with one. See app/dashboard/J4Overlay.tsx for the four bugs that all traced
// back to it.
//
// So J4's real conversation is rendered here, once, and passed down as a
// prop. It is the same component /j4 renders (app/j4/J4Surface.tsx), so
// there remains exactly one J4 conversation, one set of server actions, and
// one Request → Execute → Verify → Record → Display path.
//
// WHAT IT COSTS, honestly. Every dashboard page now also renders J4Surface,
// which is not free: it repeats this layout's own auth/store resolution and
// three of its reads (pending approvals, observations, explanations), and
// adds one genuinely new one — the last 50 StoreMessages. All indexed reads
// on one store, none an AI call, so it is a real but small cost paid on
// every dashboard navigation. Open Tasks are deliberately not among them:
// the layer never shows them, so the layer never reads them.
//
// It is the right trade because it is the whole feature: a partner who has
// to be loaded before he can be spoken to is a page, and this correction was
// specifically that J4 is not a page. The conversation has to already be
// there when the owner summons him, mid-scroll, with a question about what
// is on screen.
//
// /j4 stays a real, directly-reachable route for a shared link or a refresh.
//
// SPLIT 2026-08-20 (BUSINESS_CONTEXT.md Phase A). What is left here is the one
// job this route actually has: work out which business the account is working
// in. Everything that renders moved to BusinessWorkspace, which /b/[slug] uses
// too — with the business taken from the route instead.
//
// This route stays, and keeps resolving the active business, because 28 screens
// still live under it. It is the legacy base, and it is preserved rather than
// redirected until those screens have moved; redirecting first would break every
// one of them at once.
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

  return (
    <BusinessWorkspace
      store={resolved.store}
      role={resolved.role}
      userName={session.user.name ?? null}
      basePath={LEGACY_BUSINESS_BASE}
    >
      {children}
    </BusinessWorkspace>
  );
}
