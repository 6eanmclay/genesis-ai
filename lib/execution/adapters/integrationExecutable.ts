import type { IntegrationProvider } from "@prisma/client";
import { unavailable } from "../verification";
import { prisma } from "@/lib/prisma";
import type { IntegrationConnector } from "@/lib/integrations/types";
import { persistSyncedRecords, type PersistSyncResult } from "@/lib/businessModel/sync";
import { RateLimitedError } from "@/lib/integrations/rateLimit";
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

    // CLASS E — the local half is verifiable, the remote half is not.
    //
    // A completed connect leaves a StoreIntegration row for this provider, and
    // that row is what every other part of the platform reads to decide the
    // business is connected. Re-reading it catches the real local failure: a
    // provider that said yes while nothing was persisted here.
    //
    // The remote half — whether the provider still considers the grant good —
    // is a live call, and verifyExecutable below is the action that exists to
    // make it. Re-asking here would be a second provider round trip on every
    // connect, which VERIFICATION_HARDENING_CONTRACT.md §6.4 puts out of scope.
    async verify(_input, ctx) {
      const row = await prisma.storeIntegration.findFirst({
        where: { storeId: ctx.storeId, provider: connector.provider },
        select: { status: true },
      });
      if (!row) {
        return {
          state: "failed" as const,
          mismatches: [`storeIntegration: no ${connector.displayName} record after connecting`],
        };
      }
      return { state: "verified" as const };
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

    // VERIFICATION UNAVAILABLE — and this is the clearest honest case of it.
    //
    // This action's entire job is to ask the provider whether the connection is
    // good. Its result IS the provider's answer. Re-asking would repeat the same
    // call rather than confirm it independently, which is not verification — it
    // is the same question twice, and it would double a live provider call on
    // every check.
    //
    // Declared rather than omitted. The mechanism that would be needed —
    // something able to confirm the provider's answer without asking the
    // provider — does not exist. That is a statement about the mechanism, not
    // about anybody's willingness to write code.
    async verify() {
      return unavailable(
        `${connector.displayName} reports its own connection state; re-asking would repeat the call rather than confirm it`
      );
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
  /**
   * Set only when the provider rate-limited us and told us how long to wait.
   *
   * A rate limit is a DEFERRAL, not a failure. Letting it fall through to the
   * generic failure path would increment syncFailureCount and push a perfectly
   * healthy connection toward the 24h backoff cap for the crime of being
   * popular — so it is reported separately and the scheduler waits exactly as
   * long as the provider asked.
   */
  retryAfterMs?: number | null;
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
      // No pre-sync refresh hook. Every connector whose tokens expire renews
      // them immediately before the call that needs a live one, which is where
      // that belongs — a hook here would refresh on a schedule unrelated to
      // actual use. Which connectors have an expiry problem at all is declared
      // in capabilities.tokenLifetime instead of implied by a method nobody
      // implemented. See the note in lib/integrations/types.ts.
      if (!connector.sync) {
        return {
          message: `${connector.displayName} has nothing to sync`,
          metadata: { written: 0, errors: 0, changes: [] },
        };
      }
      let records;
      try {
        records = await connector.sync(ctx.storeId);
      } catch (error) {
        if (error instanceof RateLimitedError) {
          // PARTIAL, not FAILED: nothing is broken, we were simply asked to
          // come back later. The wait travels in metadata because a thrown
          // error reaches the scheduler as a bare FAILED with no metadata at
          // all, which is exactly how the provider's own timing used to get
          // thrown away.
          return {
            message: error.message,
            metadata: { written: 0, errors: 0, changes: [], retryAfterMs: error.retryAfterMs },
            partial: true,
            retryable: true,
          };
        }
        throw error;
      }
      const result = await persistSyncedRecords(
        ctx.storeId,
        connector.provider.toLowerCase(),
        records,
        {
          // The one unambiguous case in the codebase: a connected system
          // published these and nothing interpreted them on the way in.
          provenance: "CONNECTOR",
          provenanceDetail: connector.provider.toLowerCase(),
          statedById: null,
          modelExtracted: false,
        }
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

    // CLASS E — the local half is verifiable and is verified.
    //
    // A sync's own claim is a count: it says it wrote N records. That count is
    // checkable against what is actually in the database for this provider,
    // which catches the failure worth catching — a sync that reported writing
    // and persisted nothing.
    //
    // What it cannot check is whether the provider's data was complete or
    // current; nothing local can answer that. A count that matches is not a
    // claim that the sync saw everything, and this reports only what it read.
    async verify(_input, ctx, metadata) {
      const claimed = metadata?.written ?? 0;
      if (claimed === 0) {
        // Nothing was claimed, so there is nothing to find. Verified rather
        // than unavailable: the mechanism worked, the answer was zero.
        return { state: "verified" as const };
      }
      const present = await prisma.businessRecord.count({
        where: { storeId: ctx.storeId, sourceProvider: connector.provider.toLowerCase() },
      });
      return present > 0
        ? { state: "verified" as const }
        : {
            state: "failed" as const,
            mismatches: [`businessRecord: the sync reported writing ${claimed}, and none is stored`],
          };
    },
  };
}
