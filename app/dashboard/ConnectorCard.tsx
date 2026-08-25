import type { CatalogEntry } from "@/lib/integrations/catalog";
import type { ConnectionHealth } from "@/lib/integrations/connectionHealth";
import { ExecutionStatusCard } from "./ExecutionStatusCard";
import { SubmitButton } from "./SubmitButton";
import {
  connectIntegration,
  disconnectIntegration,
  verifyIntegration,
  syncIntegration,
  submitIntegrationCredentials,
} from "./connectionsActions";

const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";

interface ExecutionLogDisplay {
  status: string;
  message: string;
  verified: boolean;
  createdAt: Date;
  retryable: boolean;
}

// Phase 3 Milestone 2 — the one generic card every catalog entry renders
// through, in every category, connected or not. This is the concrete
// "framework, not special cases" decision for the UI: a 4th real connector
// added later needs zero new JSX, only a new lib/integrations/*.ts module
// and a CONNECTOR_CATALOG entry.
export function ConnectorCard({
  slug,
  entry,
  storeId,
  health,
  statusDisplay,
  formFields,
  lastAttemptFailedMessage,
  connectedByLabel,
  connectedAt,
  recommendationReason,
}: {
  /**
   * The business this card belongs to, when it was rendered inside one.
   *
   * Bound into disconnect so the supplier is cut from THIS business.
   * Disconnecting the wrong one is not recoverable by the owner — the
   * credentials are gone.
   */
  slug?: string;
  entry: CatalogEntry;
  storeId: string;
  /**
   * The one true answer about this connection — lib/integrations/connectionHealth.ts.
   *
   * The raw `integrationStatus` column used to be passed here too, and was what
   * decided whether to draw a connected card. It is deliberately gone: it
   * answers a narrower question than the card was asking, and leaving it
   * beside `health` would invite someone to read it again.
   */
  health: ConnectionHealth;
  statusDisplay: ExecutionLogDisplay | null;
  formFields: { name: string; label: string; type: string }[] | null;
  lastAttemptFailedMessage: string | null;
  connectedByLabel: string | null;
  connectedAt: Date | null;
  // Integrations (Chapter 4) — the real, evidence-based reason
  // lib/integrations/gaps.ts's getConnectionGaps computed for THIS store,
  // when this card is rendered in the real "Recommended for your
  // business" section. Undefined/null everywhere else — never a generic
  // "recommended" label with nothing real behind it.
  recommendationReason?: string | null;
}) {
  // UNAVAILABLE, AND SAID SO (C2, 2026-08-25). Two different reasons land here
  // and neither is "connect me": a provider with no implementation, and one
  // whose OAuth credentials do not exist in this deployment. The second used to
  // render a working-looking Connect button that could only ever throw.
  //
  // The entry stays in the catalog either way — a future provider is not deleted
  // for not being ready.
  if (health.state === "unavailable" || !entry.connector || !entry.provider) {
    return (
      <div className="rounded-lg border border-dashed border-black/[.08] p-4 dark:border-white/[.145]">
        <p className="font-medium text-zinc-500 dark:text-zinc-400">{entry.name}</p>
        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{entry.description}</p>
        <p className="mt-2 text-xs font-medium text-zinc-400 dark:text-zinc-500">{health.label}</p>
      </div>
    );
  }

  const provider = entry.provider;
  // Only the two states that actually need the owner. A working connection
  // showing a Reconnect button would invite an owner to re-run an OAuth flow
  // for no reason, and re-consent is not free — it is a trip through the
  // provider's own screens.
  const needsOwnerAction =
    health.state === "needs_reconnection" || health.state === "failed";
  // NOT `status !== "DISCONNECTED"` any more. That treated FAILED as connected,
  // so a connection the provider had rejected rendered the same card as a
  // working one, with Recheck and Sync buttons and no indication anything was
  // wrong.
  const isConnected = health.state !== "not_connected";
  const attemptKey = `${provider.toLowerCase()}_connect:${storeId}`;

  if (isConnected) {
    return (
      <div className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
        <ConnectionStateLine health={health} />
        <ExecutionStatusCard
          title={entry.name}
          log={statusDisplay}
          actions={
            <>
              {needsOwnerAction && (
                // THE ACTION THE STATE ASKS FOR (2026-08-25).
                //
                // C1 made the system say "it needs reconnecting" and left the
                // owner with Recheck, Sync now and Disconnect. Nothing
                // reconnected. The only route back was Disconnect first — an
                // action whose own comment two files away says "disconnecting
                // the wrong one is not recoverable by the owner" — and then
                // Connect. Being told what is wrong and given no way to fix it
                // is its own kind of dishonesty.
                //
                // This is connectIntegration unchanged, not a second mechanism.
                // Every OAuth callback here upserts, so re-consent replaces the
                // stored credentials in place; that is what reconnection IS.
                <form action={connectIntegration.bind(null, slug, provider)}>
                  <SubmitButton
                    pendingText="Reconnecting..."
                    className="rounded-full bg-black px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
                    trackPerf={{ label: `Reconnect ${entry.name}`, storeId, attemptKey }}
                  >
                    Reconnect
                  </SubmitButton>
                </form>
              )}
              <form action={verifyIntegration.bind(null, slug, provider)}>
                <SubmitButton
                  pendingText="Checking..."
                  className="rounded-full border border-black/[.08] px-4 py-1.5 text-xs disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
                  trackPerf={{ label: `Recheck ${entry.name}`, storeId, attemptKey }}
                >
                  Recheck
                </SubmitButton>
              </form>
              <form action={syncIntegration.bind(null, slug, provider)}>
                <SubmitButton
                  pendingText="Syncing..."
                  className="rounded-full border border-black/[.08] px-4 py-1.5 text-xs disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
                  trackPerf={{ label: `Sync ${entry.name}`, storeId, attemptKey }}
                >
                  Sync now
                </SubmitButton>
              </form>
              <form action={disconnectIntegration.bind(null, slug, provider)}>
                <SubmitButton
                  pendingText="Disconnecting..."
                  className="rounded-full border border-black/[.08] px-4 py-1.5 text-xs text-red-600 disabled:opacity-50 dark:border-white/[.145] dark:text-red-400"
                >
                  Disconnect
                </SubmitButton>
              </form>
            </>
          }
        />
        {connectedByLabel && connectedAt && (
          <p className="mt-1 text-xs text-zinc-500">
            Connected by {connectedByLabel} on {connectedAt.toLocaleDateString()}
          </p>
        )}
      </div>
    );
  }

  if (formFields) {
    return (
      <div className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
        <p className="font-medium text-black dark:text-zinc-50">{entry.name}</p>
        <p className="mt-1 text-xs text-zinc-500">{entry.description}</p>
        <form
          action={submitIntegrationCredentials.bind(null, slug, provider)}
          className="mt-3 flex flex-col gap-2"
        >
          {formFields.map((field) => (
            <input
              key={field.name}
              name={field.name}
              type={field.type}
              placeholder={field.label}
              required={field.name !== "environment"}
              className="rounded-lg border border-black/[.08] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
            />
          ))}
          <SubmitButton
            pendingText="Connecting..."
            className={`self-start px-4 py-1.5 text-xs ${ACCENT_BUTTON}`}
            trackPerf={{ label: `Connect ${entry.name}`, storeId, attemptKey }}
          >
            Connect {entry.name}
          </SubmitButton>
        </form>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
      <p className="font-medium text-black dark:text-zinc-50">{entry.name}</p>
      <p className="mt-1 text-xs text-zinc-500">{entry.description}</p>
      {recommendationReason && (
        <p className="mt-2 rounded-md bg-[var(--brand-accent)]/[0.06] px-2.5 py-2 text-xs text-zinc-700 dark:bg-[var(--brand-accent)]/[0.1] dark:text-zinc-300">
          <span className="font-medium">Genesis noticed:</span> {recommendationReason}
        </p>
      )}
      {lastAttemptFailedMessage && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          Last attempt failed: {lastAttemptFailedMessage}
        </p>
      )}
      <form action={connectIntegration.bind(null, slug, provider)} className="mt-3">
        <SubmitButton
          pendingText={entry.authMethod === "oauth" ? "Redirecting..." : "Connecting..."}
          className={`px-4 py-1.5 text-xs ${ACCENT_BUTTON}`}
          trackPerf={{ label: `Connect ${entry.name}`, storeId, attemptKey }}
        >
          Connect {entry.name}
        </SubmitButton>
      </form>
    </div>
  );
}

/**
 * What this connection actually is, in one line, before anything else.
 *
 * Above the execution log deliberately. The log says what the last *action*
 * did; this says what the connection *is*, and those are different questions —
 * a successful "Sync now" three weeks ago sitting above a connection that has
 * failed 14 times since is how the old screen managed to look fine.
 */
function ConnectionStateLine({ health }: { health: ConnectionHealth }) {
  const tone =
    health.state === "failed"
      ? "text-red-600 dark:text-red-400"
      : health.state === "needs_reconnection"
        ? "text-amber-700 dark:text-amber-400"
        : health.state === "connected_no_data"
          ? "text-zinc-500 dark:text-zinc-400"
          : "text-emerald-700 dark:text-emerald-400";
  return (
    <div className="mb-2">
      <p className={`text-xs font-semibold ${tone}`}>{health.label}</p>
      {health.detail && (
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{health.detail}</p>
      )}
    </div>
  );
}
