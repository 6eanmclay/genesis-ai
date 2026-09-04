// WHAT J4 HAS ASKED THE SURFACE TO BRING FORWARD (2026-09-03).
//
// P2's `focus.nodeIds` travels back with a tool result. This is where it lands
// so the Business Map can read it, and it is deliberately the same shape as
// lib/dashboard/genesisActivity.ts — publish/subscribe over
// useSyncExternalStore — because that pattern already exists for exactly this
// job and a second one would be a second thing to keep in step.
//
// PRESENTATION STATE, AND ONLY THAT. Focus is what is currently lit up, not a
// fact about the business:
//
//   - never persisted, so a reload starts with nothing focused
//   - never sent back to the server, so it cannot become an input to anything
//   - holds ids and nothing else, so it cannot become a second answer to what
//     J4 knows about a thing
//
// The ids are ALREADY VALIDATED by the time they arrive: the server resolved
// them against this store's own map before returning them, which is where the
// tenant boundary lives. Nothing is re-checked here, and nothing here could
// re-check it — this module has no map and should not acquire one.

export interface J4FocusSnapshot {
  /** Business Map node ids, in the order J4 named them. Empty means nothing. */
  nodeIds: readonly string[];
}

const EMPTY: J4FocusSnapshot = { nodeIds: [] };

let snapshot: J4FocusSnapshot = EMPTY;
const listeners = new Set<() => void>();

function commit(next: J4FocusSnapshot) {
  // Same identity check genesisActivity does: an unchanged focus must not
  // re-render the map, and "the same three things again" is a real case —
  // J4 repeating itself should not make the surface flicker.
  if (
    next.nodeIds.length === snapshot.nodeIds.length &&
    next.nodeIds.every((id, i) => id === snapshot.nodeIds[i])
  ) {
    return;
  }
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/** J4 asked for these to be brought forward. Replaces whatever was focused. */
export function setJ4Focus(nodeIds: readonly string[]): void {
  commit({ nodeIds: [...nodeIds] });
}

/** Nothing is focused any more — the owner navigated away, or dismissed it. */
export function clearJ4Focus(): void {
  commit(EMPTY);
}

export function subscribeJ4Focus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getJ4FocusSnapshot(): J4FocusSnapshot {
  return snapshot;
}

// Nothing is ever focused during SSR — focus arrives from a tool result, and
// there is no tool result on the server render. Matching every other
// hydration-safe read here.
export function getJ4FocusServerSnapshot(): J4FocusSnapshot {
  return EMPTY;
}

/** Test-only reset, so one suite's focus cannot leak into the next assertion. */
export function resetJ4FocusForTests(): void {
  snapshot = EMPTY;
  listeners.clear();
}
