import { prisma } from "@/lib/prisma";
import { declaredRead } from "@/lib/businessModel/declaredReads";
import { PERMISSIONS, requireBusinessPageOrActive } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import {
  CONNECTOR_CATALOG,
  CONNECTION_CATEGORY_ORDER,
  CONNECTION_CATEGORY_LABELS,
  type CatalogEntry,
} from "@/lib/integrations/catalog";
import { getConnectionGaps } from "@/lib/integrations/gaps";
import { connectionHealthOf, type ConnectionHealth } from "@/lib/integrations/connectionHealth";
import {
  connectExecutable,
  verifyExecutable,
  syncExecutable,
} from "@/lib/execution/adapters/integrationExecutable";
import { ConnectorCard } from "../ConnectorCard";
import { Panel, Eyebrow, SectionTitle, Figure, StateDot } from "../GenesisChrome";
import { buildDataConnections } from "@/lib/dashboard/dataConnections";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";
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
  /** The one true answer about this connection — see lib/integrations/connectionHealth.ts. */
  health: ConnectionHealth;
  statusDisplay: ExecutionLogDisplay | null;
  formFields: { name: string; label: string; type: string }[] | null;
  lastAttemptFailedMessage: string | null;
  connectedByLabel: string | null;
  connectedAt: Date | null;
}

async function resolveEntry(storeId: string, entry: CatalogEntry): Promise<ResolvedEntry> {
  if (!entry.connector || !entry.provider) {
    // KEPT IN THE CATALOG, MARKED HONESTLY (C2, 2026-08-25). A future provider
    // is not removed because it has no implementation yet — it simply must not
    // be presented as something that can be connected today.
    return {
      entry,
      health: connectionHealthOf({ available: false, row: null, recordsProduced: 0 }),
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

  // THE ONE ANSWER, computed here and rendered by the card (2026-08-25).
  //
  // `recordsProduced` is what makes "Connected — no data received" a real state
  // rather than a guess: Mailchimp has synced successfully every day with zero
  // failures and has never written a record, and until now that looked exactly
  // like a connection returning real data.
  const recordsProduced = await prisma.businessRecord.count({
    where: { storeId, sourceProvider: provider.toLowerCase() },
  });
  const health = connectionHealthOf({
    available: entry.connector.configured?.() ?? true,
    row: integration
      ? {
          status: integration.status,
          syncFailureCount: integration.syncFailureCount,
          lastSyncedAt: integration.lastSyncedAt,
          lastError: integration.lastError,
        }
      : null,
    recordsProduced,
    syncs: typeof entry.connector.sync === "function",
  });

  return {
    entry,
    health,
    statusDisplay,
    formFields,
    lastAttemptFailedMessage,
    connectedByLabel: integration?.connectedBy
      ? (integration.connectedBy.name ?? integration.connectedBy.email)
      : null,
    connectedAt: integration?.connectedAt ?? null,
  };
}

// MIGRATED to explicit business context (2026-08-20, BUSINESS_CONTEXT.md Phase
// C). The screen is unchanged; what changed is where it gets its business.
//
// A `slug` means it was reached at /b/[slug] and that business is
// authoritative. No slug means the legacy /dashboard route. `basePath` is what
// every link inside uses, so a page rendered for one business never links into
// another.
export async function ConnectionsScreen({
  slug,
  basePath: _basePath,
  searchParams,
}: {
  slug?: string;
  basePath: string;
  searchParams: Promise<{ integration_error?: string; integration_connected?: string }>;
}) {
  const { integration_error: integrationError, integration_connected: integrationConnected } =
    await searchParams;
  const { store } = await requireBusinessPageOrActive(PERMISSIONS.CONNECTIONS_MANAGE, slug);
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;

  // THE SUMMARIES COME FROM THE ONE CANONICAL ASSEMBLER, never a second read
  // of the same question — see CANONICAL_UNDERSTANDING_PLAN.md. This screen
  // shows what J4 can do with what is connected, so it has to be looking at
  // exactly what J4 looks at.
  const [resolved, gaps, understanding] = await Promise.all([
    Promise.all(CONNECTOR_CATALOG.map((entry) => resolveEntry(store.id, entry))),
    declaredRead("presentation", "the connections page shows which are missing", () =>
      getConnectionGaps(store.id)
    ),
    declaredRead("presentation", "Data & Connections shows what the connections let J4 do", () =>
      getBusinessUnderstanding(store.id)
    ),
  ]);
  const model = await buildDataConnections(store.id, understanding.connectedSummaries);
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
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Data &amp; Connections</h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Connect the software you already use and J4 learns from it. Each tool keeps doing its own
        day-to-day work; what changes is how much J4 understands about your business.
      </p>

      {/* ============ WHAT J4 KNOWS (2026-09-12) ======================
          The band the old page could not render, and the reason this is the
          first surface of the rebuild: a connector list with statuses cannot
          make the argument that connecting something FEEDS something.

          Every figure here is a real row count. The reference composition
          showed "24,831 Data Points" and "Data Health 92%" — the first is a
          countable thing so a count is honest; the second has no denominator
          anywhere in this system and is not rendered at all. See
          DATA_AND_CONNECTIONS.md. */}
      <section className="mt-8">
        <SectionTitle
          sub="Everything below came from a tool you connected. Nothing here is estimated."
        >
          What J4 knows
        </SectionTitle>
        {model.knows.length === 0 ? (
          <Panel className="p-5">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Nothing yet — no connected tool has sent J4 any business data. That is an accurate
              description of this business, not a problem with the connection.
            </p>
          </Panel>
        ) : (
          <Panel className="p-5">
            <div className="flex flex-wrap items-start gap-x-10 gap-y-5">
              <Figure value={model.totalRecords.toLocaleString()} label="records J4 has read" />
              {model.knows.map((k) => (
                <Figure
                  key={k.entityType}
                  value={k.count.toLocaleString()}
                  label={
                    <>
                      {k.label}
                      <span className="text-zinc-400 dark:text-zinc-600"> · {k.providers.join(", ")}</span>
                    </>
                  }
                />
              ))}
            </div>
          </Panel>
        )}
      </section>

      {/* WHAT IT BUYS. The consumption points are real — these are the same
          summaries getBusinessUnderstanding() hands J4 to reason over. A
          capability with nothing behind it is still named, with what would
          produce it: hiding a capability an owner could have is its own kind
          of dishonesty. */}
      <section className="mt-8">
        <SectionTitle sub="What J4 can do because of what is connected — and what it still cannot.">
          What that lets J4 do
        </SectionTitle>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {model.capabilities.map((c) => (
            <Panel key={c.label} accent={c.available} className="p-4">
              <div className="flex items-center gap-2">
                <StateDot state={c.available ? "connected" : "not_connected"} />
                <span className="text-sm font-medium text-black dark:text-zinc-50">{c.label}</span>
              </div>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{c.detail}</p>
            </Panel>
          ))}
        </div>
      </section>

      {/* THE TWO POPULATIONS, and the correction the reference needs.
          In the reference image every tool flows into the brain. Here most do
          not, deliberately: Stripe, PayPal, Printful, Twilio and AliExpress
          implement no sync at all. A rail that has written no records is
          working perfectly, and saying otherwise is the exact defect
          ConnectionEvidence.syncs was added to end. */}
      <section className="mt-8">
        {/* THE COUNT IS DERIVED, and it was not always. This sentence first
            said "Nine tools can send J4 business data" — a number I typed from
            the connector REGISTRY while the list beside it renders the
            CATALOG, which is a different set: Stripe and PayPal live on
            Payments, EasyPost behind shipping. The column showed eight. An
            invented figure sitting directly above the real list, on the page
            whose entire purpose is not doing that. Caught by this section's
            own sabotage. */}
        <SectionTitle
          sub={`${model.sources.length} of these can send J4 business data. The rest do a job without reporting back, which is how they are built.`}
        >
          Where it comes from
        </SectionTitle>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel className="p-5">
            <Eyebrow>Feeds J4</Eyebrow>
            <ul className="mt-3 flex flex-col divide-y divide-black/[.06] dark:divide-white/[.08]">
              {model.sources.map((s) => (
                <li key={s.entry.id} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="flex items-center gap-2 text-sm text-black dark:text-zinc-50">
                    <StateDot state={s.health.state} />
                    {s.entry.name}
                  </span>
                  <span className="text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                    {s.recordsProduced > 0
                      ? `${s.recordsProduced.toLocaleString()} records`
                      : s.health.label}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel className="p-5">
            <Eyebrow>Does a job, doesn&apos;t report back</Eyebrow>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Payments, fulfilment, messaging and sourcing. These never send J4 records, by design —
              nothing is missing when they don&apos;t.
            </p>
            <ul className="mt-3 flex flex-col divide-y divide-black/[.06] dark:divide-white/[.08]">
              {model.rails.map((r) => (
                <li key={r.entry.id} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="flex items-center gap-2 text-sm text-black dark:text-zinc-50">
                    <StateDot state={r.health.state} />
                    {r.entry.name}
                  </span>
                  <span className="text-right text-xs text-zinc-500 dark:text-zinc-400">
                    {r.health.label}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </section>

      {/* WHAT IS ACTUALLY WRONG. raisesAttention is the health model's own
          answer to "should this interrupt the owner" — not a threshold
          invented for a screen. The provider's own message is shown verbatim,
          never rewritten. */}
      {model.needsAttention.length > 0 && (
        <section className="mt-8">
          <SectionTitle>Needs you</SectionTitle>
          <div className="flex flex-col gap-3">
            {model.needsAttention.map((c) => (
              <Panel key={c.entry.id} className="p-4">
                <div className="flex items-center gap-2">
                  <StateDot state={c.health.state} />
                  <span className="text-sm font-medium text-black dark:text-zinc-50">
                    {c.entry.name} — {c.health.label}
                  </span>
                </div>
                {c.health.detail ? (
                  <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">{c.health.detail}</p>
                ) : null}
                {c.health.providerError ? (
                  <p className="mt-1.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {c.health.providerError}
                  </p>
                ) : null}
              </Panel>
            ))}
          </div>
        </section>
      )}

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
                  slug={slug}
                  key={entry.id}
                  entry={r.entry}
                  storeId={store.id}
                  health={r.health}
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
                    health={r.health}
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


// The legacy route — resolves the account's ACTIVE business and renders the same
// screen. Preserved rather than redirected; existing links point here.
export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ integration_error?: string; integration_connected?: string }>;
}) {
  return ConnectionsScreen({ basePath: LEGACY_BUSINESS_BASE, searchParams });
}
