"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import Link from "next/link";

// Reliability architecture (v21, Phase 1 checklist item #1) — catches
// errors in the root marketing/auth pages (/, /login, /signup) without
// falling through to global-error.tsx, which replaces the entire
// <html>/<body> (the heaviest, least graceful fallback available). A
// segment's error.tsx never wraps its own layout, only what's nested
// inside it, so this sits at the root without touching app/layout.tsx.
// `unstable_retry` (not `reset`) is this Next version's real API — added
// in v16.2.0, confirmed against the bundled docs.
export default function RootError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[root-error-boundary]", error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-8 text-center dark:bg-black">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
        Something went wrong
      </h1>
      <p className="mt-3 max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
        Genesis ran into an unexpected problem. Please try again.
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
          href="/"
          className="rounded-full border border-black/[.08] px-5 py-2 text-sm text-black transition-colors hover:bg-black/[.03] dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-white/[.05]"
        >
          Start over
        </Link>
      </div>
    </div>
  );
}
