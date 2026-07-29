"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import Link from "next/link";

// Reliability architecture (v21, Phase 1) — the safety net for the
// dashboard route tree, not the primary handler: every known Anthropic
// provider failure (auth/billing/rate-limit/overloaded/network) is now
// caught and turned into a graceful, in-conversation reply before it ever
// reaches here (see lib/genesisModel.ts's callGenesisModel + this file's
// bailOnProviderFailure in ai-actions.ts). This boundary exists for
// whatever isn't classified yet — a real bug, an unexpected exception
// elsewhere in the dashboard — so that failure mode also gets a real
// message instead of Next's generic crash page, which is what the
// 2026-07-28 incident actually looked like to a beta tester.
//
// `unstable_retry` (not `reset`) is this Next version's real API — added in
// v16.2.0, confirmed against the bundled docs rather than assumed.
export default function DashboardError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard-error-boundary]", error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-8 text-center dark:bg-black">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
        Something went wrong
      </h1>
      <p className="mt-3 max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
        Genesis ran into an unexpected problem. Anything you&apos;d already
        saved is safe — this only affects the page that just failed.
      </p>
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="rounded-full bg-foreground px-5 py-2 text-sm text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          Try again
        </button>
        <Link
          href="/dashboard"
          className="rounded-full border border-black/[.08] px-5 py-2 text-sm text-black transition-colors hover:bg-black/[.03] dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-white/[.05]"
        >
          Back to Home
        </Link>
      </div>
    </div>
  );
}
