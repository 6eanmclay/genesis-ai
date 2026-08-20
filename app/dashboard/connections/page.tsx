import { prisma } from "@/lib/prisma";
import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import {
  CONNECTOR_CATALOG,
  CONNECTION_CATEGORY_ORDER,
  CONNECTION_CATEGORY_LABELS,
  type CatalogEntry,
} from "@/lib/integrations/catalog";
import { getConnectionGaps } from "@/lib/integrations/gaps";
import {
  connectExecutable,
  verifyExecutable,
  syncExecutable,
} from "@/lib/execution/adapters/integrationExecutable";
import { ConnectorCard } from "../ConnectorCard";
import { DEFAULT_THEME, themeCssVars, type Theme } from "@/lib/theme";

interface ExecutionLogDisplay {
  status: string;
  message: string;
  verified: boolean;
  createdAt: Date;
  retryable: boolean;
}

interface ResolvedEntry {
  entry: CatalogEntry;
  integrationStatus: string | null;
  statusDisplay: ExecutionLogDisplay | null;
  formFields: { name: string; label: string; type: string }[] | null;
  lastAttemptFailedMessage: string | null;
  connectedByLabel: string | null;
  connectedAt: Date | null;
}

async function resolveEntry(storeId: string, entry: CatalogEntry): Promise<ResolvedEntry> {
  if (!entry.connector || !entry.provider) {
    return {
      entry,
      integrationStatus: null,
      statusDisplay: null,
      formFields: null,
      lastAttemptFailedMessage: null,
      connectedByLabel: null,
      connectedAt: null,
    };
  }

  const provider = entry.provider;
  const [integration, latestLog] = await Promise.all([
    prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider } },
      include: { connectedBy: { select: { name: true, email: true } } },
    }),
    prisma.executionLog.findFirst({
      where: {
        storeId,
        // Sync's own action was missing here — after a real "Sync now"
        // click, the log the card actually needs to show (e.g. "Synced 3
        // record(s) from Google Calendar") was silently never found, so
        // the card kept displaying the stale connect-time message instead
        // — indistinguishable from the sync having done nothing at all.
        action: {
          in: [
            connectExecutable(entry.connector).action,
            verifyExecutable(entry.connector).action,
            syncExecutable(entry.connector).action,
          ],
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const statusDisplay: ExecutionLogDisplay | null = latestLog
    ? {
        status: latestLog.status,
        message: latestLog.message,
        verified: latestLog.verified,
        createdAt: latestLog.createdAt,
        retryable: latestLog.retryable,
      }
    : integration
      ? {
          status:
            integration.status === "CONNECTED"
              ? "SUCCESS"
              : integration.status === "NEEDS_ATTENTION"
                ? "WARNING"
                : "FAILED",
          message: integration.lastError ?? `${entry.name} connected`,
          verified: integration.lastVerifiedAt !== null,
          createdAt: integration.lastVerifiedAt ?? integration.connectedAt ?? integration.createdAt,
          retryable: integration.status !== "CONNECTED",
        }
      : null;

  // Same 2-step reveal PayPal's own page already established: a form-kind
  // connect() result is only owed once the most recent action is a connect
  // attempt that got that far (no metadata.fields means either nothing
  // happened yet, or it fully completed).
  //
  // Capabilities beat a stale log row (2026-08-20). Mailchimp used to collect
  // an API key and now uses OAuth, so a store whose most recent attempt
  // predates the conversion still had a "paste your API Key" box on file — a
  // box that would take a live secret and discard it. A connector that
  // declares OAuth never asks for typed credentials, whatever an old log says.
  const formFields =
    entry.connector.capabilities.authKind !== "oauth" &&
    latestLog?.action === connectExecutable(entry.connector).action
      ? ((latestLog.metadata as { fields?: { name: string; label: string; type: string }[] } | null)
          ?.fields ?? null)
      : null;

  const lastAttemptFailedMessage =
    !integration || integration.status === "DISCONNECTED"
      ? (latestLog?.status === "FAILED" ? latestLog.message : null)
      : null;

  return {
    entry,
    integrationStatus: integration?.status ?? null,
    statusDisplay,
    formFields,
    lastAttemptFailedMessage,
    connectedByLabel: integration?.connectedBy
      ? (integration.connectedBy.name ?? integration.connectedBy.email)
      : null,
    connectedAt: integration?.connectedAt ?? null,
  };
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ integration_error?: string; integration_connected?: string }>;
}) {
  const { integration_error: integrationError, integration_connected: integrationConnected } =
    await searchParams;
  const { store } = await requireStorePageAccess(PERMISSIONS.CONNECTIONS_MANAGE);
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;

  const [resolved, gaps] = await Promise.all([
    Promise.all(CONNECTOR_CATALOG.map((entry) => resolveEntry(store.id, entry))),
    getConnectionGaps(store.id),
  ]);
  const resolvedById = new Map(resolved.map((r) => [r.entry.id, r]));

  const flashEntry = resolved.find(
    (r) =>
      r.entry.provider?.toLowerCase() === integrationError ||
      r.entry.provider?.toLowerCase() === integrationConnected
  );

  // Integrations (Chapter 4) — real, evidence-based recommendations
  // (lib/integrations/gaps.ts), replacing the old static
  // recommendedFor-only filter. reasonByEntryId threads each gap's real
  // reason into its ConnectorCard; recommended is just the matching
  // catalog entries, in the same real order getConnectionGaps produced
  // them (already filtered to real, working, not-yet-connected connectors).
  const reasonByEntryId = new Map(gaps.map((g) => [g.catalogId, g.reason]));
  const recommended = CONNECTOR_CATALOG.filter((e) => reasonByEntryId.has(e.id));

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Connections</h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Connect the software you already use so Genesis can understand what&apos;s happening in your
        business — answer questions, summarize your data, and surface what matters — while each tool
        keeps handling its own day-to-day work.
      </p>

      {integrationError && flashEntry && (
        <div className="mt-4 max-w-md rounded-lg border border-red-200 bg-red-50 p-4 text-sm dark:border-red-900/40 dark:bg-red-950/30">
          <p className="font-medium text-red-800 dark:text-red-300">{flashEntry.entry.name} couldn&apos;t connect.</p>
          <p className="mt-1 text-red-700 dark:text-red-400">
            {flashEntry.statusDisplay?.status === "FAILED"
              ? flashEntry.statusDisplay.message
              : "Something went wrong during the connection. Please try again."}
          </p>
        </div>
      )}
      {integrationConnected && flashEntry && (
        <div className="mt-4 max-w-md rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900/40 dark:bg-emerald-950/30">
          <p className="font-medium text-emerald-800 dark:text-emerald-300">{flashEntry.entry.name} connected.</p>
        </div>
      )}

      {recommended.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-black dark:text-zinc-50">
            Recommended for your business
          </h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recommended.map((entry) => {
              const r = resolvedById.get(entry.id)!;
              return (
                <ConnectorCard
                  key={entry.id}
                  entry={r.entry}
                  storeId={store.id}
                  integrationStatus={r.integrationStatus}
                  statusDisplay={r.statusDisplay}
                  formFields={r.formFields}
                  lastAttemptFailedMessage={r.lastAttemptFailedMessage}
                  connectedByLabel={r.connectedByLabel}
                  connectedAt={r.connectedAt}
                  recommendationReason={reasonByEntryId.get(entry.id)}
                />
              );
            })}
          </div>
        </div>
      )}

      {CONNECTION_CATEGORY_ORDER.map((category) => {
        const entries = CONNECTOR_CATALOG.filter((e) => e.category === category);
        if (entries.length === 0) return null;
        return (
          <div key={category} className="mt-8">
            <h2 className="text-sm font-semibold text-black dark:text-zinc-50">
              {CONNECTION_CATEGORY_LABELS[category]}
            </h2>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {entries.map((entry) => {
                const r = resolvedById.get(entry.id)!;
                return (
                  <ConnectorCard
                    key={entry.id}
                    entry={r.entry}
                    storeId={store.id}
                    integrationStatus={r.integrationStatus}
                    statusDisplay={r.statusDisplay}
                    formFields={r.formFields}
                    lastAttemptFailedMessage={r.lastAttemptFailedMessage}
                    connectedByLabel={r.connectedByLabel}
                    connectedAt={r.connectedAt}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
