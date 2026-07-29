"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";

// Reliability architecture (v21, Phase 1) — the ultimate fallback, for an
// error thrown inside the root layout itself (app/layout.tsx), which
// app/dashboard/error.tsx cannot catch (error.tsx never wraps its own
// segment's layout, only what's nested inside it — confirmed against this
// project's bundled Next docs). Expected to fire rarely; every AI-provider
// failure and every ordinary dashboard exception is caught closer to its
// source before reaching here. Must define its own <html>/<body> — it
// replaces the root layout when active.
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[global-error-boundary]", error);
  }, [error]);

  return (
    <html>
      <body className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-8 text-center dark:bg-black">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Something went wrong
        </h1>
        <p className="mt-3 max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
          Genesis hit an unexpected problem loading the page. Please try
          again.
        </p>
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="mt-6 rounded-full bg-foreground px-5 py-2 text-sm text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          Try again
        </button>
      </body>
    </html>
  );
}
