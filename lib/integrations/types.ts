import type { IntegrationProvider, StoreIntegration } from "@prisma/client";
import type { Permission } from "@/lib/permissions";
import type { EntityType } from "@/lib/businessModel/entities";

// Phase 3 Milestone 2 — the Foundation's mapping contract, made real. A
// connector's sync() output, before validation: entityType/data are
// checked against lib/businessModel/entities.ts's real Zod schema by
// persistSyncedRecords, never trusted here. externalId is the provider's
// own id for the record, so a re-sync updates BusinessRecord in place
// (matching its @@unique([storeId, entityType, sourceProvider,
// externalId]) constraint) rather than duplicating.
export interface SyncedRecord {
  entityType: EntityType;
  externalId: string;
  data: unknown;
}

// The framework never assumes how a connector authenticates — the
// connector decides, and tells the caller what to do next via `kind`.
export type ConnectResult =
  // OAuth-style: send the merchant to the provider's own hosted flow.
  | { kind: "redirect"; url: string }
  // API-key-style (a future USPS/ERP-shaped provider): collect input from
  // the merchant, then call connect() again with the submitted values.
  | { kind: "form"; fields: { name: string; label: string; type: "text" | "password" }[] }
  // Done in one step (e.g. a device-flow completion, or the second call of
  // an OAuth exchange once the provider's callback has round-tripped).
  | { kind: "connected" };

// Phase 0 — what a connection is allowed to do, declared rather than implied.
//
// Sean's requirement: "explicit scopes/permissions and a clear definition of
// exactly what Genesis can read/write." Before this, the only way to answer
// that was to read each connector's authorize URL. Now every connector states
// it, so the answer is data — quotable to the owner on a consent screen, and
// checkable in a test.
export interface IntegrationCapabilities {
  /**
   * OAuth wherever the provider offers it. "api_key" is a real, allowed
   * exception — EasyPost genuinely issues keys and has no OAuth — but it must
   * be justified rather than chosen for convenience.
   */
  authKind: "oauth" | "api_key";
  /** Required when authKind is "api_key": why OAuth is not an option here. */
  apiKeyExceptionReason?: string;
  /** The exact scopes requested at the provider. Empty for api_key connectors. */
  scopes: string[];
  /**
   * Required when authKind is "oauth" and `scopes` is empty: why there are none
   * to name. Some providers genuinely take no scope parameter and grant whole-
   * account access on consent, which the owner deserves to be told plainly —
   * an empty array must mean "none exist", never "nobody filled this in".
   */
  noScopesReason?: string;
  /** Canonical entity types this connector's sync() produces. */
  reads: EntityType[];
  /**
   * What Genesis can CHANGE at the provider, in plain words. Empty means
   * read-only, which is the default posture and true of most connectors.
   */
  writes: string[];
  /**
   * Does disconnect() end the grant AT THE PROVIDER, not just locally?
   *
   * Declared rather than assumed, because the honest answer was no for six
   * connectors and nobody could tell from the outside. Deleting a stored token
   * is not revoking it: the token stays valid at the provider while the owner
   * has just been told access ended. Intuit and Google both require real
   * revocation; every provider that offers an endpoint should use it.
   *
   * False is an allowed, honest answer — some providers (a bare API key) have
   * nothing to revoke. It must never be true unless disconnect really calls the
   * provider.
   */
  revokesOnDisconnect: boolean;
}

// Phase 0 — status() never returns credentials.
//
// The old signature returned the raw StoreIntegration row, encrypted
// credentials blob included. It had no callers, so nothing leaked; this makes
// that safety structural rather than lucky.
export interface IntegrationStatusView {
  provider: IntegrationProvider;
  status: StoreIntegration["status"];
  externalAccountId: string | null;
  connectedAt: Date | null;
  lastVerifiedAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  syncFailureCount: number;
}

/** Strips a StoreIntegration row down to what is safe to hand out. */
export function toStatusView(row: StoreIntegration | null): IntegrationStatusView | null {
  if (!row) return null;
  return {
    provider: row.provider,
    status: row.status,
    externalAccountId: row.externalAccountId,
    connectedAt: row.connectedAt,
    lastVerifiedAt: row.lastVerifiedAt,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
    syncFailureCount: row.syncFailureCount,
  };
}

// Phase 0 — the webhook contract.
//
// Signature verification existed for Stripe, hand-built in its own route,
// outside this interface entirely. A connector that supports webhooks now
// declares how to verify one, so the generic route can refuse an unsigned or
// forged delivery before any handler sees it.
//
// IDEMPOTENCY IS BY CONSTRUCTION, not by a dedupe table: handlers write through
// persistSyncedRecords, whose @@unique([storeId, entityType, sourceProvider,
// externalId]) makes a replayed delivery an update in place rather than a
// duplicate.
export interface WebhookVerification {
  ok: boolean;
  /** The provider's own event id, for logging and replay reasoning. */
  eventId?: string;
  /** Provider account id, used to resolve which store this delivery belongs to. */
  externalAccountId?: string;
  error?: string;
}

export interface IntegrationWebhooks {
  /** Verifies signature and shape. Must not throw on a hostile payload. */
  verify(rawBody: string, headers: Headers): Promise<WebhookVerification> | WebhookVerification;
  /** Applies a verified delivery. Only ever called after verify() returns ok. */
  handle(storeId: string, rawBody: string): Promise<void>;
}

// Every integration (Stripe today; PayPal, Google, Slack, USPS later)
// implements this same contract — see lib/integrations/stripe.ts for the
// reference implementation and lib/integrations/registry.ts for lookup.
export interface IntegrationConnector {
  provider: IntegrationProvider;
  displayName: string;
  requiredPermission: Permission;
  /** Declared, not implied — see IntegrationCapabilities. */
  capabilities: IntegrationCapabilities;

  // Called once with no params to kick off a connection; called again with
  // whatever params that step produced (an OAuth `code`, a submitted API
  // key, ...) to continue/complete it. The connector owns its own steps.
  connect(
    storeId: string,
    userId: string,
    params?: Record<string, string>
  ): Promise<ConnectResult>;

  // Re-checkable at any time — on connect, and on demand (e.g. a "Recheck"
  // action). No background scheduler exists yet, so "Monitor" today means
  // "verifiable whenever asked," not a cron job.
  verify(storeId: string): Promise<{ ok: boolean; error?: string }>;

  disconnect(storeId: string): Promise<void>;

  status(storeId: string): Promise<IntegrationStatusView | null>;

  // Phase 0 — the refresh contract.
  //
  // QuickBooks, Google Calendar and Printful each hand-rolled token refresh and
  // Meta does its own long-lived exchange, with nothing on this interface
  // saying so. A connector whose tokens expire implements this; the sync
  // adapter calls it before reading, so an expired token is renewed rather than
  // surfacing as a mysterious sync failure.
  //
  // Optional because it is genuinely not universal: a Stripe Connect access
  // token does not expire, and an API-key connector has nothing to refresh.
  // Saying "not applicable" by omission is honest; a no-op implementation
  // everywhere would hide which connectors really need it.
  refresh?(storeId: string): Promise<void>;

  /** Present only for providers that actually deliver webhooks. */
  webhooks?: IntegrationWebhooks;

  // Optional — not every connector produces business data (a future
  // notification-only integration might not). When present, fetches this
  // connector's own current data and maps it into the Foundation's
  // canonical shape. Read-only: never writes back to the provider,
  // matching this phase's "leaving the underlying software responsible
  // for its own operational workflows" non-goal.
  sync?(storeId: string): Promise<SyncedRecord[]>;

  // Social Connections & Business Intelligence (2026-08-09) — optional,
  // general-purpose (not social-specific): called once by syncExecutable
  // right after this sync's own records are persisted, for a connector
  // that wants to do more than store raw data — "J4 should be able to
  // interpret the data rather than simply display it" (Sean's own words,
  // about social specifically, but the hook itself is a real framework
  // capability any connector could adopt later). Failures here are caught
  // and swallowed by the caller: a broken interpretation must never turn a
  // genuinely successful sync into a reported failure.
  interpretSync?(storeId: string): Promise<void>;
}
