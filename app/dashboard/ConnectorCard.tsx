import type { CatalogEntry } from "@/lib/integrations/catalog";
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
  entry,
  storeId,
  integrationStatus,
  statusDisplay,
  formFields,
  lastAttemptFailedMessage,
  connectedByLabel,
  connectedAt,
  recommendationReason,
}: {
  entry: CatalogEntry;
  storeId: string;
  integrationStatus: string | null; // StoreIntegration.status, or null if never connected
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
  if (!entry.connector || !entry.provider) {
    return (
      <div className="rounded-lg border border-dashed border-black/[.08] p-4 dark:border-white/[.145]">
        <p className="font-medium text-zinc-500 dark:text-zinc-400">{entry.name}</p>
        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{entry.description}</p>
        <p className="mt-2 text-xs font-medium text-zinc-400 dark:text-zinc-500">Coming soon</p>
      </div>
    );
  }

  const provider = entry.provider;
  const isConnected = integrationStatus && integrationStatus !== "DISCONNECTED";
  const attemptKey = `${provider.toLowerCase()}_connect:${storeId}`;

  if (isConnected) {
    return (
      <div className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
        <ExecutionStatusCard
          title={entry.name}
          log={statusDisplay}
          actions={
            <>
              <form action={verifyIntegration.bind(null, provider)}>
                <SubmitButton
                  pendingText="Checking..."
                  className="rounded-full border border-black/[.08] px-4 py-1.5 text-xs disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
                  trackPerf={{ label: `Recheck ${entry.name}`, storeId, attemptKey }}
                >
                  Recheck
                </SubmitButton>
              </form>
              <form action={syncIntegration.bind(null, provider)}>
                <SubmitButton
                  pendingText="Syncing..."
                  className="rounded-full border border-black/[.08] px-4 py-1.5 text-xs disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
                  trackPerf={{ label: `Sync ${entry.name}`, storeId, attemptKey }}
                >
                  Sync now
                </SubmitButton>
              </form>
              <form action={disconnectIntegration.bind(null, provider)}>
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
          action={submitIntegrationCredentials.bind(null, provider)}
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
      <form action={connectIntegration.bind(null, provider)} className="mt-3">
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
