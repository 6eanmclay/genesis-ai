import type { BusinessUnderstanding } from "@/lib/businessModel/understanding";

// THE CLOSED REGISTRY OF WHAT THE CONTEXT PANE MAY SHOW (UI6 piece 1).
//
// "Whatever the owner happens to be looking at" is not the contract. That would
// make the pane an uncontrolled context surface whose boundaries nobody could
// reason about, and every future question — can it show this? is that scoped? —
// would be answered case by case. A closed set answers them once.
//
// MIRRORED-REGISTRY INVARIANT, the sixteenth instance in this codebase and
// guarded like the rest: every entry names a real reader over a real field of
// BusinessUnderstanding, and scripts/verify-context-pane.ts cross-checks that
// each one resolves. A type eligible for the pane is explicitly here or it is
// not eligible.
//
// READ-ONLY BY CONSTRUCTION, not by convention. A reader is a pure function of
// an already-fetched BusinessUnderstanding. It cannot write, cannot reach a
// database, and cannot create an approval, because it is handed a value and
// returns strings.
//
//   Context pane = understand. Action surface = change.
//
// CURRENT, NEVER A SNAPSHOT. The understanding passed in is the one the surface
// fetched for this render, so the pane shows what J4 knows NOW — the same rule
// conversations follow on resumption. A pane that reconstructed what was known
// when a conversation started would be a different feature and a worse one.

export interface ContextEntry {
  key: ContextTypeKey;
  label: string;
  /** Plain lines. No links, no controls, nothing actionable. */
  lines: string[];
}

/**
 * One kind of thing the pane may show.
 *
 * `read` takes the understanding and returns lines. That signature is the
 * read-only guarantee: there is nowhere in it to put a mutation.
 */
interface ContextType {
  label: string;
  read: (understanding: BusinessUnderstanding) => string[];
}

const MAX_LINES = 5;

export const CONTEXT_TYPES = {
  goals: {
    label: "What you're working toward",
    read: (u) =>
      u.profile.goals
        .map((g) => (g.data as { description?: string }).description)
        .filter((d): d is string => typeof d === "string" && d.length > 0)
        .slice(0, MAX_LINES),
  },
  challenges: {
    label: "What's in the way",
    read: (u) =>
      u.profile.challenges
        .map((c) => (c.data as { description?: string }).description)
        .filter((d): d is string => typeof d === "string" && d.length > 0)
        .slice(0, MAX_LINES),
  },
  assets: {
    label: "What you already have",
    read: (u) =>
      Object.entries(u.currentAssets)
        .map(([role]) => role)
        .slice(0, MAX_LINES),
  },
} as const satisfies Record<string, ContextType>;

export type ContextTypeKey = keyof typeof CONTEXT_TYPES;

/** Every key the pane may render. Nothing outside this is eligible. */
export const CONTEXT_TYPE_KEYS = Object.keys(CONTEXT_TYPES) as ContextTypeKey[];

/**
 * What the pane shows, for the business the conversation belongs to.
 *
 * Empty groups are dropped rather than rendered as empty headings: "nothing to
 * show" is an honest state for the pane as a whole, and a heading over nothing
 * is filler.
 */
export function buildContextEntries(understanding: BusinessUnderstanding): ContextEntry[] {
  const entries: ContextEntry[] = [];
  for (const key of CONTEXT_TYPE_KEYS) {
    const lines = CONTEXT_TYPES[key].read(understanding);
    if (lines.length > 0) entries.push({ key, label: CONTEXT_TYPES[key].label, lines });
  }
  return entries;
}

/**
 * Whether a key is eligible at all.
 *
 * `Object.hasOwn`, not a bare lookup: the registry is a plain object, and a
 * prototype key is not a context type. The same discipline every other closed
 * registry here uses, for the same reason — one of them once let "constructor"
 * reach a live model call.
 */
export function isContextType(key: string): key is ContextTypeKey {
  return Object.hasOwn(CONTEXT_TYPES, key);
}
