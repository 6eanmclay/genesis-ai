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

// Every integration (Stripe today; PayPal, Google, Slack, USPS later)
// implements this same contract — see lib/integrations/stripe.ts for the
// reference implementation and lib/integrations/registry.ts for lookup.
export interface IntegrationConnector {
  provider: IntegrationProvider;
  displayName: string;
  requiredPermission: Permission;

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

  status(storeId: string): Promise<StoreIntegration | null>;

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
