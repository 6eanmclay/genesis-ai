"use client";

import { useEffect, useState } from "react";

// A real, honest proxy for "a fresh application launch" (see memory
// project_arrival_experience_milestone.md — no native web equivalent of an
// OS "app opened" event exists). sessionStorage clears when the real
// browser tab/window closes and survives in-app navigation/refresh within
// the same tab session — exactly the boundary the frozen design asks for
// ("never on normal navigation, only on fresh launch"). Deliberately not
// tied to sessionInstanceId (a 30-day JWT-lifetime concept, too coarse for
// "did this specific tab just open") — this is a separate, purely
// client-side signal for a separate purpose.
const FLAG_KEY = "genesis-arrival-played";

export function useFreshLaunch(): { isFreshLaunch: boolean; consume: () => void } {
  // Always starts false, matching the server-rendered pass (sessionStorage
  // doesn't exist during SSR) — reading it eagerly during the first client
  // render instead produces a real hydration mismatch (DashboardShell's
  // header vs. MobileArrivalOverlay), the same class of client-only-state
  // problem GenesisGreeting.tsx already works around for its own
  // time-of-day read. The real value is read in an effect, one tick after
  // mount — invisible in practice, and the only hydration-safe way to
  // surface real client-only state.
  const [isFreshLaunch, setIsFreshLaunch] = useState(false);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(FLAG_KEY) === null) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setIsFreshLaunch(true);
      }
    } catch {
      // Storage can throw in some private-browsing modes — treat as "not
      // fresh" (never blocks real usage over a decorative signal).
    }
  }, []);

  const consume = () => {
    try {
      window.sessionStorage.setItem(FLAG_KEY, "1");
    } catch {
      // Same non-blocking tolerance as above.
    }
  };

  return { isFreshLaunch, consume };
}
