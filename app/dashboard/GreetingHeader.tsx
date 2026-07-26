"use client";

import { useEffect, useState } from "react";

function greetingForHour(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// Client component specifically so the greeting reflects the visitor's own
// clock, not the server's — a server-rendered greeting would say "Good
// morning" at 9pm for a merchant outside the server's timezone, undercutting
// the warmth it's going for. Starts with a neutral fallback and swaps to the
// real time-of-day greeting after mount, avoiding a hydration mismatch.
export function GreetingHeader({
  storeName,
  tagline,
}: {
  storeName: string;
  tagline: string | null;
}) {
  const [greeting, setGreeting] = useState("Welcome back");

  useEffect(() => {
    // Genuinely external state (the visitor's clock) that can't be known
    // during SSR — there's no way to derive this without an effect, unlike
    // the cases this lint rule is meant to catch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGreeting(greetingForHour(new Date().getHours()));
  }, []);

  return (
    <div className="rounded-2xl bg-gradient-to-r from-[var(--brand-primary)]/5 via-[var(--brand-accent)]/5 to-transparent p-4">
      <p className="font-[var(--font-heading)] text-xl font-semibold text-black dark:text-zinc-50">
        {greeting}.
      </p>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Here&apos;s what&apos;s happening with {storeName} today.
      </p>
      {tagline && <p className="mt-3 text-xs text-zinc-500">{tagline}</p>}
    </div>
  );
}
