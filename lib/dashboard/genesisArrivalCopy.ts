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
// Timing was originally tight (~1-2s) and got walked back after Sean saw it
// live: "the pacing is still too fast... allow each message to remain on
// screen long enough to actually be read... think calm confidence, not fast
// loading." Nothing here is ever really "still loading" (the dashboard's
// own data is already server-rendered by the time this mounts) — this is an
// honest, deliberate pause, not a progress indicator, now given real room to
// breathe: roughly 5-8 seconds total, matching the beat "Genesis awakens ->
// greets you -> prepares your business -> opens your workspace," not "load
// dashboard." The opening mode's first pauseBeforeMs is sized to line up
// with GenesisAvatar's own wakeOnMount ramp (~1.7s) so the greeting lands
// right as the orb finishes waking, not mid-ramp or long after it settles.
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
      { text: `Switching to ${storeName}…`, pauseBeforeMs: 400, holdMs: 1300 },
      { text: "Loading business intelligence…", holdMs: 1100 },
      { text: "Checking overnight activity…", holdMs: 1100 },
      { text: "Preparing your workspace…", holdMs: 1100 },
    ];
  }

  const greeting = userName ? `Welcome back, ${userName}.` : "Welcome back.";
  return [
    { text: greeting, pauseBeforeMs: 1700, holdMs: 1500 },
    { text: `Opening ${storeName}…`, holdMs: 1300 },
    { text: "Preparing today's workspace…", holdMs: 1300 },
    {
      text: hasRealBriefing ? "Reviewing what changed while you were away…" : "Everything's running smoothly…",
      holdMs: 1300,
    },
  ];
}
