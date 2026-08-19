import type { IntegrationProvider } from "@prisma/client";
import type { IntegrationConnector } from "@/lib/integrations/types";
import { persistSyncedRecords, type PersistSyncResult } from "@/lib/businessModel/sync";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

// Phase 3 Milestone 2 — named EXECUTION_ACTIONS constants for the 3 proof
// integrations, alongside Stripe's pre-existing special case. PayPal (and
// any future provider not listed here) falls through to the template
// string below, unchanged pre-existing behavior — not touched by this
// milestone. New providers with real sync support add one line here.
const SYNC_ACTIONS: Partial<Record<IntegrationProvider, string>> = {
  GOOGLE_CALENDAR: EXECUTION_ACTIONS.INTEGRATION_GOOGLE_CALENDAR_SYNC,
  QUICKBOOKS: EXECUTION_ACTIONS.INTEGRATION_QUICKBOOKS_SYNC,
  MAILCHIMP: EXECUTION_ACTIONS.INTEGRATION_MAILCHIMP_SYNC,
};

// PH-02's IntegrationConnector and PH-03's Executable stay separate
// contracts, composed via this thin adapter rather than folded into one —
// ConnectResult's `redirect`/`form`/`connected` cases don't map cleanly
// onto a single run() call, and forcing them to would bloat Executable with
// integration-only concepts. IntegrationConnector stays the source of truth
// for how an integration works; Executable stays the source of truth for
// how any action reports its outcome. See ARCHITECTURE.md.

interface ConnectInput {
  params?: Record<string, string>;
}

interface ConnectMetadata {
  fields?: { name: string; label: string; type: "text" | "password" }[];
}

// Phase 3 Milestone 2 — Stripe's own pre-existing special case is left
// exactly as it was (out of scope); the 3 new providers get real constants
// added alongside it via these maps rather than growing the ternary.
const CONNECT_ACTIONS: Partial<Record<IntegrationProvider, string>> = {
  GOOGLE_CALENDAR: EXECUTION_ACTIONS.INTEGRATION_GOOGLE_CALENDAR_CONNECT,
  QUICKBOOKS: EXECUTION_ACTIONS.INTEGRATION_QUICKBOOKS_CONNECT,
  MAILCHIMP: EXECUTION_ACTIONS.INTEGRATION_MAILCHIMP_CONNECT,
};
const VERIFY_ACTIONS: Partial<Record<IntegrationProvider, string>> = {
  GOOGLE_CALENDAR: EXECUTION_ACTIONS.INTEGRATION_GOOGLE_CALENDAR_VERIFY,
  QUICKBOOKS: EXECUTION_ACTIONS.INTEGRATION_QUICKBOOKS_VERIFY,
  MAILCHIMP: EXECUTION_ACTIONS.INTEGRATION_MAILCHIMP_VERIFY,
};

export function connectExecutable(
  connector: IntegrationConnector
): Executable<ConnectInput, ConnectMetadata> {
  return {
    action:
      connector.provider === "STRIPE"
        ? EXECUTION_ACTIONS.INTEGRATION_STRIPE_CONNECT
        : (CONNECT_ACTIONS[connector.provider] ??
          `integration.${connector.provider.toLowerCase()}.connect`),
    requiredPermission: connector.requiredPermission,
    async run(input, ctx) {
      // Phase 0 — the connector needs to sign this attempt's own id into the
      // OAuth `state`, so the callback can close exactly this ExecutionLog row
      // instead of guessing at the most recent PENDING one. Passed through
      // params rather than by widening connect()'s signature across ten
      // connectors that mostly don't care.
      const result = await connector.connect(ctx.storeId, ctx.userId!, {
        ...input.params,
        ...(ctx.executionId ? { executionId: ctx.executionId } : {}),
      });
      if (result.kind === "redirect") {
        return { message: `Redirecting to ${connector.displayName}`, redirectUrl: result.url };
      }
      if (result.kind === "form") {
        // Nothing was connected yet — a form was returned, awaiting more
        // input. Equally non-terminal as a redirect handoff, so PENDING.
        return {
          message: `Additional information required for ${connector.displayName}`,
          metadata: { fields: result.fields },
          pending: true,
        };
      }
      return { message: `${connector.displayName} connected` };
    },
  };
}

export function verifyExecutable(
  connector: IntegrationConnector
): Executable<void, Record<string, never>> {
  return {
    action:
      connector.provider === "STRIPE"
        ? EXECUTION_ACTIONS.INTEGRATION_STRIPE_VERIFY
        : (VERIFY_ACTIONS[connector.provider] ??
          `integration.${connector.provider.toLowerCase()}.verify`),
    requiredPermission: connector.requiredPermission,
    async run(_input, ctx) {
      const result = await connector.verify(ctx.storeId);
      return result.ok
        ? { message: `${connector.displayName} verified` }
        : { message: result.error ?? "Verification failed", retryable: true };
    },
  };
}

export interface SyncMetadata {
  written: number;
  errors: number;
  // Phase 3 Milestone 3 — the scheduler's own input to Change Detection.
  // Included here (not a separate return channel) because execute()'s
  // ExecutionResult is what actually reaches the caller in-memory; the
  // same object also lands in ExecutionLog.metadata, matching the existing
  // precedent of GENESIS_RECOMMENDATIONS_GENERATE storing its full result
  // there too ("nothing reads this yet" there; here the scheduler is the
  // real, immediate reader). Sync volumes for a real small business are
  // small (the same assumption reasoning.ts's findRelated already makes),
  // so this isn't the storage risk it would be at a different scale.
  changes: PersistSyncResult["changes"];
}

// Phase 3 Milestone 2 — the third adapter, same shape as
// connectExecutable/verifyExecutable above. Persists a connector's synced
// data into BusinessRecord via persistSyncedRecords (lib/businessModel/
// sync.ts), which does the real validation against the Foundation's Zod
// schemas — this function's own job is only the Executable/ExecutionLog
// bookkeeping, matching the other two adapters' division of labor.
export function syncExecutable(
  connector: IntegrationConnector
): Executable<void, SyncMetadata> {
  return {
    action:
      SYNC_ACTIONS[connector.provider] ??
      `integration.${connector.provider.toLowerCase()}.sync`,
    requiredPermission: connector.requiredPermission,
    async run(_input, ctx) {
      // Phase 0 — renew before reading. QuickBooks, Google Calendar and
      // Printful all expire tokens and each hand-rolled its own refresh with
      // nothing on the interface saying so; a connector that forgot simply
      // failed at sync time looking like a provider outage. Failures here are
      // deliberately not swallowed: a token that cannot be renewed IS the sync
      // failure, and reporting it honestly beats an empty successful sync.
      if (connector.refresh) {
        await connector.refresh(ctx.storeId);
      }
      if (!connector.sync) {
        return {
          message: `${connector.displayName} has nothing to sync`,
          metadata: { written: 0, errors: 0, changes: [] },
        };
      }
      const records = await connector.sync(ctx.storeId);
      const result = await persistSyncedRecords(
        ctx.storeId,
        connector.provider.toLowerCase(),
        records
      );
      // Social Connections & Business Intelligence (2026-08-09) — real
      // interpretation, not just storage, but never at the cost of the
      // sync's own honest success/failure report. Fire-and-await, but
      // caught: a real Claude-call failure here degrades to "the sync
      // worked, the insight didn't," never the reverse.
      if (connector.interpretSync && result.written > 0) {
        try {
          await connector.interpretSync(ctx.storeId);
        } catch (error) {
          console.error(`[interpretSync] ${connector.provider} failed:`, error);
        }
      }
      return {
        message: `Synced ${result.written} record(s) from ${connector.displayName}${
          result.errors.length > 0 ? ` (${result.errors.length} couldn't be saved)` : ""
        }`,
        metadata: { written: result.written, errors: result.errors.length, changes: result.changes },
        retryable: result.errors.length > 0,
      };
    },
  };
}
