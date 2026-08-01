"use client";

import { useEffect, useState } from "react";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";

function greetingForHour(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// Client component specifically so the greeting reflects the visitor's own
// clock, not the server's (same reasoning the retired GreetingHeader used).
// Starts with a neutral fallback and swaps to the real time-of-day greeting
// after mount, avoiding a hydration mismatch. Deliberately minimal — just
// the salutation itself; LiveIntelligence composes the rest of the
// briefing (the state-dependent line + the top item) around this. This is
// the one moment Sean specifically called out as the strongest reference
// for how entering the environment should feel — sized and weighted as
// the clear visual lead of Live Intelligence, not a small header line.
export function GenesisGreeting({
  name,
  sizeClassName = "text-2xl font-semibold",
}: {
  name: string | null;
  // MobileGenesisPresence reuses this same greeting logic at a smaller
  // size for its compact bar — the salutation/time-of-day/name logic below
  // is the reusable part; only the type scale differs by context.
  sizeClassName?: string;
}) {
  const [greeting, setGreeting] = useState("Welcome back");

  useEffect(() => {
    // Genuinely external state (the visitor's clock) that can't be known
    // during SSR — there's no way to derive this without an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGreeting(greetingForHour(new Date().getHours()));
  }, []);

  return (
    <p
      className={`font-[var(--font-heading,inherit)] ${sizeClassName}`}
      style={{ color: GENESIS_ATMOSPHERE.text }}
    >
      {greeting}
      {name ? `, ${name}` : ""}
      <span aria-hidden="true"> ✨</span>
    </p>
  );
}
