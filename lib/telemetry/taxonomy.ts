// WHAT GENESIS IS ALLOWED TO SAY ABOUT ITSELF.
//
// ============ THE AUDIT THAT PRODUCED THIS (2026-08-30) ================
//
// Measured, not assumed. Every emission site in the repository, and the
// production row counts behind them:
//
//   2,090 ProductEvent rows in 34 days — and 1,604 of them (77%) are
//     `nav.section_view`. Telemetry is three quarters page views.
//   21 creation events in 34 days. Six `creation.started`.
//   ZERO from execution, storage, jobs, webhooks, the integrations framework,
//     Growth Points, orders, image providers, or social.
//   `performance` is a declared category with a live emit site
//     (`perf.action_pending`) and NO ROWS AT ALL — it has never fired.
//
// A correction to an earlier note in this milestone: `journey` was called dead
// and is not — it has 20 rows. Only `performance` is.
//
// ============ AND THE THREE THAT HAD NO CODE AT ALL (2026-09-01) =======
//
// A later sweep asked the other direction of the same question — not "which
// declared events have no rows" but "which have no EMIT SITE" — and found
// three: `webhook.processed`, `creation.product_created`, `creation.design_saved`.
// Declarations with nothing behind them, which is why they had no rows.
//
// All three are wired now. The sweep is `scripts/verify-telemetry-gaps-db.ts`
// and it runs on every commit, so this cannot recur silently: an event added
// below without an emit site fails that suite immediately.
//
// ============ WHY A REGISTRY AND NOT FREE STRINGS =====================
//
// `logProductEvent` takes any string. That is how a system ends up with
// `creation.started` and `creation.confirmed` but no `creation.failed`, and it
// is why nobody could tell from the outside which events were meant to exist.
//
// Every name below is declared with the QUESTION IT ANSWERS. An event that
// cannot state its purpose does not belong here — instrumentation that exists
// to raise a count is noise that makes the real signal harder to find, and this
// system already spends 77% of its rows on one such event.
//
// ============ WHAT THIS IS NOT =======================================
//
// Not the audit trail, not the security record, not the money.
//
//   ExecutionLog    what an action did, and whether it verified. Authoritative.
//   SecuritySignal  what a security layer reads. Separate on purpose.
//   GrowthPointTransaction  the ledger. Money.
//   OutboundOperation       whether an external effect happened. Authoritative.
//
// Telemetry is the OBSERVATION layer over those: it says a thing happened, when,
// how long it took, and how it turned out, so somebody can ask "what is Genesis
// doing" without reading four authoritative tables. It is never the source of
// truth for any of them, and it is correlated to them by correlationId rather
// than by duplicating their contents.

/** Which part of Genesis acted. Answers "what system touched this". */
export const SUBSYSTEMS = [
  "execution",
  "creation",
  "storage",
  "jobs",
  "outbound",
  "webhooks",
  "integrations",
  "business",
  "j4",
  "api",
  "auth",
] as const;
export type Subsystem = (typeof SUBSYSTEMS)[number];

/**
 * Who set it going.
 *
 * `userId` alone could not distinguish "J4 did this on its own authority" from
 * "nobody was signed in" — both are a null user, and they are opposite facts.
 */
export const ACTOR_KINDS = ["user", "genesis", "system", "provider", "anonymous"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface EventDefinition {
  subsystem: Subsystem;
  /** The question this event exists to answer. Not a description of the code. */
  purpose: string;
  /** Keys this event's metadata may carry. Anything else is dropped. */
  metadataKeys: readonly string[];
}

/**
 * Every event Genesis may emit, and why.
 *
 * ============ THE METADATA ALLOWLIST IS THE PRIVACY BOUNDARY ==========
 *
 * `metadata` was free-form JSON reaching a table nobody prunes. Today's entries
 * are benign — provider error kinds, durations, booleans — but nothing stopped
 * the next one carrying a customer's address, an owner's brand copy, or a token.
 *
 * So each event declares the keys it may carry, and emit() drops the rest
 * silently. Dropping rather than throwing is deliberate: telemetry must never
 * break the feature it observes, and a developer who adds a key gets a missing
 * field in a dashboard rather than a broken checkout.
 */
export const EVENTS = {
  // ---- execution: what J4 and owners actually did ----------------------
  "execution.completed": {
    subsystem: "execution",
    purpose: "Did this action succeed, was it verified, and how long did it take?",
    metadataKeys: ["action", "status", "verified", "retryable"],
  },

  // ---- jobs: is background work flowing or piling up -------------------
  "job.completed": {
    subsystem: "jobs",
    purpose: "Is queued work draining, and how long does each kind take?",
    metadataKeys: ["kind", "attempts"],
  },
  "job.failed": {
    subsystem: "jobs",
    purpose: "Which kinds fail, how often, and do they recover on retry?",
    metadataKeys: ["kind", "attempts", "willRetry"],
  },
  "job.dead_lettered": {
    subsystem: "jobs",
    purpose: "What gave up entirely, so somebody looks before a customer notices.",
    metadataKeys: ["kind", "attempts"],
  },

  // ---- outbound: did an external effect happen, once ------------------
  "outbound.performed": {
    subsystem: "outbound",
    purpose: "An external side effect actually occurred, for the first time.",
    metadataKeys: ["operation", "hasExternalRef"],
  },
  "outbound.replayed": {
    subsystem: "outbound",
    purpose: "A retry correctly did NOT repeat an external effect. Proof idempotency is working.",
    metadataKeys: ["operation"],
  },
  "outbound.indeterminate": {
    subsystem: "outbound",
    purpose: "We called a provider and never learned the outcome. Needs a person or a reconciler.",
    metadataKeys: ["operation"],
  },

  // ---- storage: is the ledger tracking what is actually stored --------
  "storage.recorded": {
    subsystem: "storage",
    purpose: "A file landed and was accounted for. The counterpart to a reservation.",
    metadataKeys: ["prefix", "lifecycle", "source", "bytes"],
  },
  "storage.refused": {
    subsystem: "storage",
    purpose: "An upload was refused, or would have been. Measures enforcement before enabling it.",
    metadataKeys: ["reason", "enforced", "batchBytes"],
  },

  // ---- webhooks: is a provider reaching us, and is it signed ----------
  "webhook.received": {
    subsystem: "webhooks",
    purpose: "A provider reached us and the signature checked out.",
    metadataKeys: ["provider", "duplicate"],
  },
  "webhook.rejected": {
    subsystem: "webhooks",
    purpose: "A delivery failed verification. A burst is a rotated secret or a prober.",
    metadataKeys: ["provider"],
  },
  "webhook.processed": {
    subsystem: "webhooks",
    purpose: "The handler finished, or did not. The gap between received and processed is the leak.",
    metadataKeys: ["provider", "ok"],
  },

  // ---- creation: the product the business is actually building --------
  "creation.product_created": {
    subsystem: "creation",
    purpose: "A design became a real product at a supplier. The end of the Creation Station funnel.",
    metadataKeys: ["supplier", "variantCount"],
  },
  "creation.design_saved": {
    subsystem: "creation",
    purpose: "Work was preserved. Distinguishes abandonment from failure.",
    metadataKeys: ["surfaceCount"],
  },
} as const satisfies Record<string, EventDefinition>;

export type EventName = keyof typeof EVENTS;

/** Every declared name, for the registry cross-check. */
export const EVENT_NAMES = Object.keys(EVENTS) as EventName[];
