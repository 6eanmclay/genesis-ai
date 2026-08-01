import type { Beat } from "./arrivalBeats";

// The real content behind the returning-user arrival ritual, kept out of
// DashboardShell.tsx specifically so a future business switcher can call
// this with mode: "switching" without duplicating any copy — see memory
// project_genesis_avatar_v2.md and the milestone that added this file for
// the fuller reasoning. "switching" is real code today, but nothing in the
// app currently triggers it (no business switcher exists) — "architect
// for, don't build," the same discipline the original Arrival Experience
// design record already applied to multi-business.
//
// Timing is deliberately tight — Sean's explicit call: "~1-2 seconds,
// polished not slow... the animation isn't there to hide loading, it
// represents Genesis becoming active." Nothing here is ever really
// "still loading" (the dashboard's own data is already server-rendered by
// the time this mounts) — this is an honest, deliberate pause, not a
// progress indicator, just a brief one. Exact milliseconds are expected to
// move after being experienced live, same as every other beat sequence
// this milestone.
export type ArrivalMode = "opening" | "switching";

export function buildArrivalBeats({
  mode,
  userName,
  storeName,
  hasRealBriefing,
}: {
  mode: ArrivalMode;
  userName: string | null;
  storeName: string;
  // Real signal (from buildBriefing — see lib/dashboard/genesisBriefing.ts)
  // — keeps the closing beat honest instead of a generic "priorities" line
  // when there's genuinely nothing pending.
  hasRealBriefing: boolean;
}): Beat[] {
  if (mode === "switching") {
    return [
      { text: `Switching to ${storeName}…`, pauseBeforeMs: 120, holdMs: 480 },
      { text: "Loading business intelligence…", holdMs: 380 },
      { text: "Checking overnight activity…", holdMs: 380 },
      { text: "Preparing your workspace…", holdMs: 380 },
    ];
  }

  const greeting = userName ? `Welcome back, ${userName}.` : "Welcome back.";
  return [
    { text: greeting, pauseBeforeMs: 120, holdMs: 480 },
    { text: `Opening ${storeName}…`, holdMs: 380 },
    { text: "Preparing today's workspace…", holdMs: 380 },
    {
      text: hasRealBriefing ? "Reviewing what changed while you were away…" : "Everything's running smoothly…",
      holdMs: 380,
    },
  ];
}
