import type { IntegrationProvider } from "@prisma/client";
import type { IntegrationConnector } from "@/lib/integrations/types";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
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
      const result = await connector.connect(ctx.storeId, ctx.userId!, input.params);
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

// Phase 3 Milestone 2 — the third adapter, same shape as
// connectExecutable/verifyExecutable above. Persists a connector's synced
// data into BusinessRecord via persistSyncedRecords (lib/businessModel/
// sync.ts), which does the real validation against the Foundation's Zod
// schemas — this function's own job is only the Executable/ExecutionLog
// bookkeeping, matching the other two adapters' division of labor.
export function syncExecutable(
  connector: IntegrationConnector
): Executable<void, { written: number; errors: number }> {
  return {
    action:
      SYNC_ACTIONS[connector.provider] ??
      `integration.${connector.provider.toLowerCase()}.sync`,
    requiredPermission: connector.requiredPermission,
    async run(_input, ctx) {
      if (!connector.sync) {
        return { message: `${connector.displayName} has nothing to sync` };
      }
      const records = await connector.sync(ctx.storeId);
      const result = await persistSyncedRecords(
        ctx.storeId,
        connector.provider.toLowerCase(),
        records
      );
      return {
        message: `Synced ${result.written} record(s) from ${connector.displayName}${
          result.errors.length > 0 ? ` (${result.errors.length} couldn't be saved)` : ""
        }`,
        metadata: { written: result.written, errors: result.errors.length },
        retryable: result.errors.length > 0,
      };
    },
  };
}
