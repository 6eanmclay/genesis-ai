// WHAT IS ACTUALLY TRUE OF A CONNECTION — one definition, every caller.
//
// The Connections screen and the attention path each used to decide this for
// themselves, and they disagreed. The screen asked `status !== "DISCONNECTED"`
// and drew a connected card, so a FAILED integration rendered as working. The
// attention path asked `status in (FAILED, NEEDS_ATTENTION)` and never looked at
// the scheduler's own failure counter, so QuickBooks — 14 consecutive failures,
// no sync since 2026-08-01 — read CONNECTED, showed a connected card, and raised
// nothing for 24 days.
//
// Both were reading one field that answers a narrower question than either was
// asking. `status` is the result of the last VERIFICATION: a point-in-time
// credential check, written by each connector's own verify path, and re-run only
// when somebody presses Recheck. `syncFailureCount` is the SCHEDULER's
// consecutive-failure counter, reset to zero by any successful sync. Neither
// alone is "is this connection working".
//
// So this file is the answer, once, and both callers read it. Same rule as
// needsDatabase and hasWorkingPaymentMethod already follow here: one definition,
// two consumers, so what the owner is shown and what J4 raises cannot drift.

/** How many consecutive scheduler failures before an owner is asked to act. */
export const CONSECUTIVE_FAILURES_BEFORE_RECONNECT = 3;

export type ConnectionState =
  /** No implementation, or its OAuth credentials are not configured. */
  | "unavailable"
  /** Never connected, or deliberately disconnected. */
  | "not_connected"
  /** Verification failed — the provider said why, and that message is kept. */
  | "failed"
  /** Authenticated once, but syncing has failed repeatedly since. */
  | "needs_reconnection"
  /** Working, authenticated, and has never returned any business data. */
  | "connected_no_data"
  /** Working, and has produced data. */
  | "connected";

export interface ConnectionHealth {
  state: ConnectionState;
  /** What the owner sees. Their words, not the schema's. */
  label: string;
  /** One sentence: what is true, and what to do when there is something to do. */
  detail: string | null;
  /**
   * The provider's own message, verbatim.
   *
   * Never rewritten or summarised — "the account was a test account created with
   * a testmode key" tells an owner exactly what to fix, and no sentence this
   * codebase could generate would be more useful.
   */
  providerError: string | null;
  /** Whether this should interrupt the owner. */
  raisesAttention: boolean;
}

export interface ConnectionEvidence {
  /** Is connecting this provider possible at all right now? */
  available: boolean;
  /** The stored connection, or null when there has never been one. */
  row: {
    status: string;
    syncFailureCount: number;
    lastSyncedAt: Date | null;
    lastError: string | null;
  } | null;
  /**
   * How many BusinessRecords this provider has ever written for this store.
   *
   * Zero is a real answer and NOT a failure — see the `connected_no_data` case.
   */
  recordsProduced: number;
  /**
   * Does this connector import business data at all? (R2, 2026-08-25)
   *
   * `IntegrationConnector.sync` is optional and several connectors deliberately
   * do not implement it. stripe.ts says so in as many words — "the absence of
   * `sync` here is the answer" — and printful.ts likewise. They are payment and
   * fulfilment rails, not sources of the store's own records, and they will
   * never write one.
   *
   * Without this, seven production connections were told "Connected and
   * syncing. This provider has not returned any business data yet", which is
   * false on both halves and implies something pending that never arrives.
   *
   * Defaults to true when the caller does not say, which keeps every existing
   * call site meaning exactly what it meant before.
   */
  syncs?: boolean;
}

/**
 * The state of one connection, from evidence only.
 *
 * Pure: no reads, no clock beyond what the caller passes in the row. Ordered by
 * precedence because more than one condition can be true at once — a connection
 * can have failed verification AND produced nothing, and "failed" is the more
 * useful thing to say.
 */
export function connectionHealthOf(evidence: ConnectionEvidence): ConnectionHealth {
  const { available, row, recordsProduced, syncs = true } = evidence;

  if (!available) {
    return {
      state: "unavailable",
      label: "Coming later",
      // NOT "coming soon" with a connect button behind it. A provider whose
      // credentials do not exist cannot be connected today, and offering the
      // button anyway spends an owner's attention on a flow that will fail.
      detail: "Not available to connect yet.",
      providerError: null,
      raisesAttention: false,
    };
  }

  if (!row || row.status === "DISCONNECTED") {
    return {
      state: "not_connected",
      label: "Not connected",
      detail: null,
      providerError: null,
      raisesAttention: false,
    };
  }

  // VERIFICATION FAILED, and the provider explained why. Highest precedence:
  // it is the most specific thing known, and the only one carrying an
  // instruction the owner can follow.
  if (row.status === "FAILED" || row.status === "NEEDS_ATTENTION") {
    return {
      state: "failed",
      label: "Failed",
      detail: row.lastError ?? "This connection could not be verified.",
      providerError: row.lastError,
      raisesAttention: true,
    };
  }

  // AUTHENTICATED, AND NOT SYNCING. This is the case that read CONNECTED for
  // three weeks. Three consecutive failures, not one: a single failure is
  // ordinary, the scheduler backs off and retries, and raising it would be
  // noise on something that fixes itself.
  if (row.syncFailureCount >= CONSECUTIVE_FAILURES_BEFORE_RECONNECT) {
    const since = row.lastSyncedAt
      ? `has not synced since ${row.lastSyncedAt.toLocaleDateString()}`
      : "has never synced";
    return {
      state: "needs_reconnection",
      label: "Needs reconnection",
      detail: `${since} — ${row.syncFailureCount} attempts have failed. It needs reconnecting.`,
      providerError: row.lastError,
      raisesAttention: true,
    };
  }

  // WORKING, AND THE PROVIDER HAS RETURNED NOTHING.
  //
  // This is NOT a fault, and it deliberately does not raise attention. An
  // account with no campaigns, no invoices, no appointments is an ordinary
  // thing to have, and telling an owner their connection is broken because
  // their Mailchimp is empty would be wrong.
  //
  // What it does is stop the two cases looking identical. Mailchimp has synced
  // successfully every day with zero failures and has never written a record —
  // and until now that was indistinguishable from a connection returning real
  // data, because nothing reported what a sync actually produced.
  // ONLY FOR A CONNECTOR THAT ACTUALLY IMPORTS DATA (R2). A payment or
  // fulfilment rail has nothing to report here and never will, so telling its
  // owner that nothing has arrived "yet" describes a wait that does not exist.
  if (syncs && recordsProduced === 0) {
    return {
      state: "connected_no_data",
      label: "Connected — no data received",
      detail: "Connected and syncing. This provider has not returned any business data yet.",
      providerError: null,
      raisesAttention: false,
    };
  }

  return {
    state: "connected",
    label: "Connected",
    // Two different true sentences, because these are two different facts. A
    // data source reports what arrived; a rail reports that arriving is not its
    // job. Neither invents a count it does not have.
    detail: syncs
      ? `${recordsProduced} record${recordsProduced === 1 ? "" : "s"} received.`
      : "Connected. This provider does not send business data to Genesis.",
    providerError: null,
    raisesAttention: false,
  };
}
