"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { J4State } from "./J4Character";
import {
  getGenesisActivityServerSnapshot,
  getGenesisActivitySnapshot,
  subscribeGenesisActivity,
} from "@/lib/dashboard/genesisActivity";
import { getJ4FocusSnapshot, subscribeJ4Focus } from "@/lib/dashboard/j4Focus";

/**
 * What J4 is doing, for whichever J4 is on screen.
 *
 * ONE DERIVATION, TWO PLACES (2026-09-04). The dock owned this logic, and the
 * Office was about to get its own copy. Two components deciding independently
 * what "thinking" means is the mirrored-registry failure this codebase keeps
 * writing runtime cross-checks for - except here there is nothing to
 * cross-check, because a face that disagrees with itself in two corners of the
 * same screen breaks nothing and just looks broken.
 *
 * So the rule lives here and both read it. J4 in the corner and J4 in his
 * Office are the same character having the same day.
 *
 * IT OWNS NO STATE OF ITS OWN. It reads the activity store the real composer
 * already drives and the focus store the map already drives; there is nothing
 * here to keep in step with the conversation, because none of it is a copy.
 */
export function useJ4State(): { state: J4State; justFocused: boolean } {
  const activity = useSyncExternalStore(
    subscribeGenesisActivity,
    getGenesisActivitySnapshot,
    getGenesisActivityServerSnapshot,
  );

  // POINTING IS AN EVENT, NOT A RENDER. J4 noticing something is a thing that
  // HAPPENS; deriving it from focus state on every render would re-trigger the
  // look whenever anything else re-rendered the page.
  const [justFocused, setJustFocused] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = subscribeJ4Focus(() => {
      if (getJ4FocusSnapshot().nodeIds.length === 0) return;
      setJustFocused(true);
      clearTimeout(timer);
      timer = setTimeout(() => setJustFocused(false), 2600);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, []);

  const state: J4State = activity.isWorking
    ? "thinking"
    : activity.isComposing
      ? "listening"
      : justFocused
        ? "success"
        : "idle";

  return { state, justFocused };
}
