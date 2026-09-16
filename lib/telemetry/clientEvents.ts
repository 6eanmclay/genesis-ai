import type { ProductEventCategory } from "./events";

// WHAT A BROWSER IS ALLOWED TO SAY HAPPENED.
//
// ============ THE GAP THIS CLOSES (gap 8, 2026-09-16) ==================
//
// `logClientEvent` is a "use server" action, which means it is an HTTP
// endpoint any signed-in person can call with any arguments they like. It took
// `name: string` and `category: ProductEventCategory` straight from the caller
// and wrote them into ProductEvent.
//
// So the analytics catalog was writable by the client. Not a privilege
// escalation — userId and sessionInstanceId have always been resolved from the
// real session and never trusted from the browser — but every `name` ever
// written becomes a row somebody groups by, and a caller could mint unbounded
// distinct ones, or file a navigation event under "creation" and quietly move
// a number on a screen an owner reads.
//
// ============ WHY THE GENERIC WRITER IS LEFT ALONE ====================
//
// lib/telemetry/events.ts says plainly that `name` there is "a plain, freely-
// growing string catalog (same reasoning as EXECUTION_ACTIONS)". That is a
// deliberate design for SERVER call sites, which are code somebody wrote and
// reviewed. It is not changed here and should not be.
//
// The difference is who is holding the pen. This registry governs exactly one
// entry point: the one a browser can reach.
//
// ============ DERIVED, NOT INVENTED ===================================
//
// These four are every name the product actually sends, read off the two call
// sites that exist — DashboardShell (three) and SubmitButton (one). Nothing is
// listed here in anticipation of being useful later; an event earns its entry
// when something sends it.

/** One event a browser may report, and the whole truth about it. */
export interface ClientEventShape {
  /** Decided HERE, not by the caller — so a nav event cannot file as creation. */
  category: ProductEventCategory;
  /**
   * The metadata keys this event carries. Anything else is dropped.
   *
   * KEYS, NOT VALUES. `section` really is a route path and route paths are
   * bounded by the routes that exist; what must not be open is the SHAPE, so a
   * caller cannot attach arbitrary fields to a row nobody expected them on.
   */
  metadata: readonly string[];
}

export const CLIENT_EVENTS = {
  "nav.section_view": { category: "navigation", metadata: ["section", "fromSection"] },
  "focus.route_resolved": { category: "navigation", metadata: ["section"] },
  "focus.route_unresolved": { category: "navigation", metadata: ["section"] },
  "perf.action_pending": { category: "performance", metadata: ["label", "feltSlow"] },
} as const satisfies Record<string, ClientEventShape>;

export type ClientEventName = keyof typeof CLIENT_EVENTS;

/** The outcomes ProductEvent records. Restated so a caller cannot invent one. */
const OUTCOMES = ["success", "failure", "abandoned"] as const;
export type ClientEventOutcome = (typeof OUTCOMES)[number];

export interface ClientEventInput {
  storeId?: string | null;
  name: string;
  attemptKey?: string | null;
  outcome?: string | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown> | null;
}

/** What actually gets written, once the claim has been checked. */
export interface ResolvedClientEvent {
  name: ClientEventName;
  category: ProductEventCategory;
  storeId: string | null;
  attemptKey: string | null;
  outcome: ClientEventOutcome | null;
  durationMs: number | null;
  metadata: Record<string, unknown> | null;
}

/**
 * The claim, checked — or null, which means write nothing.
 *
 * PURE, AND THAT IS THE POINT. The types above stop a mistake in our own code;
 * they stop nothing at all coming over HTTP, where the argument is whatever
 * JSON somebody sent. So the check is a real runtime one, and it lives in a
 * function a suite can call directly rather than inside the action, where
 * proving it would need a session.
 *
 * SILENT REFUSAL, deliberately. Telemetry must never break the feature it is
 * attached to — logProductEvent already swallows its own write failures for
 * exactly that reason — so an unrecognised event is dropped rather than thrown
 * at somebody who was trying to do something else entirely.
 */
export function resolveClientEvent(input: ClientEventInput): ResolvedClientEvent | null {
  // Object.hasOwn, NOT a plain lookup — and this is not defensive decoration.
  // `CLIENT_EVENTS["constructor"]` resolves to Object's own constructor and
  // `CLIENT_EVENTS["__proto__"]` to Object.prototype: both truthy, so a bare
  // `if (!shape)` accepted either as a registered event and then read
  // `shape.category` off it as undefined. Found by the suite, not by reading.
  if (!Object.hasOwn(CLIENT_EVENTS, input.name)) return null;
  const shape = (CLIENT_EVENTS as Record<string, ClientEventShape>)[input.name];
  const name = input.name as ClientEventName;

  // ONLY THE DECLARED KEYS. An absent metadata object stays absent rather than
  // becoming an empty one — "nothing was sent" and "nothing survived" are
  // different facts and the row should not blur them.
  let metadata: Record<string, unknown> | null = null;
  if (input.metadata && typeof input.metadata === "object") {
    const kept: Record<string, unknown> = {};
    for (const key of shape.metadata) {
      if (Object.hasOwn(input.metadata, key)) kept[key] = input.metadata[key];
    }
    metadata = Object.keys(kept).length > 0 ? kept : null;
  }

  return {
    name,
    // FROM THE REGISTRY. The caller no longer has a say in this.
    category: shape.category,
    metadata,
    storeId: input.storeId ?? null,
    attemptKey: input.attemptKey ?? null,
    outcome: (OUTCOMES as readonly string[]).includes(input.outcome ?? "")
      ? (input.outcome as ClientEventOutcome)
      : null,
    // A duration has to be a real, finite, non-negative number of milliseconds.
    // NaN and Infinity are both `typeof "number"`, and both would reach the
    // column as something no arithmetic downstream survives.
    durationMs:
      typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0
        ? input.durationMs
        : null,
  };
}
