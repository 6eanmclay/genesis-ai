import Link from "next/link";
import { platformHealth, needsAttention } from "@/lib/admin/platformHealth";
import { traceFor, recentTraces, findTraces } from "@/lib/admin/trace";
import { replayableDeliveries } from "@/lib/webhooks/delivery";
import { replayableProviders } from "@/lib/webhooks/replayHandlers";
import { ReplayButton } from "./ReplayButton";

// WHAT FAILED, WHERE, WHY — AND THE ONE BUTTON THAT FIXES IT.
//
// ============ NOTHING IS COMPUTED ON THIS PAGE (2026-08-30) ============
//
// platformHealth, traceFor, findTraces, replayableDeliveries and
// replayDelivery were all built and proven before this file existed. Every
// number and every decision here comes from one of them. A page that
// re-derived "is this replayable" would be a second opinion that agreed until
// it did not, and the read layer — not the render — is where the suite points.
//
// ============ AND IT IS NOT THE SECURITY BOUNDARY =====================
//
// The layout gates this page; the ACTION gates itself. Hiding the replay button
// protects nobody, because a server action is a POST endpoint anyone holding
// the id can call directly. See actions.ts.

export const dynamic = "force-dynamic";

function Card({ label, value, sub, alarm }: { label: string; value: string; sub?: string; alarm?: boolean }) {
  return (
    <div className={`rounded-xl border p-5 ${alarm
      ? "border-rose-300 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30"
      : "border-black/[.08] bg-white dark:border-white/[.1] dark:bg-zinc-950"}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold tabular-nums ${alarm
        ? "text-rose-700 dark:text-rose-300" : "text-black dark:text-zinc-50"}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{sub}</p>}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h2>
      {note && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-black/[.12] bg-white p-5 text-sm text-zinc-500 dark:border-white/[.12] dark:bg-zinc-950 dark:text-zinc-400">
      {children}
    </p>
  );
}

/** Intervals read as words here; milliseconds are for the registry, not a person. */
function humanInterval(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const when = (d: Date | string | null) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) : "—");

export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ trace?: string; q?: string }>;
}) {
  const { trace: traceId, q } = await searchParams;

  const [health, replayable, recent, found, trace] = await Promise.all([
    platformHealth(),
    replayableDeliveries(undefined, 50),
    recentTraces(25),
    q ? findTraces(q) : Promise.resolve([]),
    traceId ? traceFor(traceId) : Promise.resolve(null),
  ]);

  const attention = needsAttention(health);
  const canReplay = new Set(replayableProviders());

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Operations</h1>
        <Link href="/admin" className="text-xs text-zinc-500 underline dark:text-zinc-400">AI cost &amp; usage</Link>
      </div>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Generated {when(health.generatedAt)} · reads live, never cached
      </p>

      {/* The verdict before the numbers. On a healthy platform this says so
          plainly rather than leaving an operator to read seven cards. */}
      {attention.length > 0 ? (
        <div className="mt-6 rounded-xl border border-rose-300 bg-rose-50 p-5 dark:border-rose-900 dark:bg-rose-950/30">
          <p className="text-sm font-semibold text-rose-800 dark:text-rose-300">Needs a person</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-rose-700 dark:text-rose-300">
            {attention.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>
      ) : (
        <div className="mt-6 rounded-xl border border-emerald-300 bg-emerald-50 p-5 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
          Nothing needs attention. Work is flowing, no external outcome is unknown, and no delivery is awaiting replay.
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card label="Queued" value={`${health.queue.depth.pending}`} sub={`${health.queue.depth.running} running`} />
        <Card label="Gave up" value={`${health.queue.deadLetters.length}`} alarm={health.queue.deadLetters.length > 0} sub="dead letters" />
        <Card label="Stalled" value={`${health.queue.stalled}`} alarm={health.queue.stalled > 0} sub="claimed, never finished" />
        <Card label="Unknown outcome" value={`${health.indeterminate.length}`} alarm={health.indeterminate.length > 0} sub="external effects" />
      </div>

      {/* ============ THE MOST IMPORTANT LIST HERE ==================
          Each row is a call to a provider whose result we never learned.
          Possibly a charge, possibly nothing. Never retried automatically —
          a person has to go and look. */}
      <Section title="External operations with an unknown outcome"
        note="Never retried automatically. Check the provider, then resolve it deliberately.">
        {health.indeterminate.length === 0 ? (
          <Empty>None. Every external effect we started, we know the result of.</Empty>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-black/[.08] bg-white dark:border-white/[.1] dark:bg-zinc-950">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <tr><th className="p-3">Operation</th><th className="p-3">Key</th><th className="p-3">Attempts</th><th className="p-3">Started</th><th className="p-3">Last error</th></tr>
              </thead>
              <tbody>
                {health.indeterminate.map((o) => (
                  <tr key={o.key} className="border-t border-black/[.06] dark:border-white/[.08]">
                    <td className="p-3 text-black dark:text-zinc-100">{o.operation}</td>
                    <td className="p-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">{o.key}</td>
                    <td className="p-3 tabular-nums">{o.attempts}</td>
                    <td className="p-3 tabular-nums text-zinc-500 dark:text-zinc-400">{when(o.createdAt)}</td>
                    <td className="p-3 text-zinc-500 dark:text-zinc-400">{o.lastError ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ============ THE ONLY SECTION ABOUT WORK THAT DID NOT HAPPEN ====
          Everything else on this page describes something the platform did.
          A scheduler that silently stops produces no rows anywhere, which is
          why its health is asserted rather than inferred. */}
      <Section title="Scheduled tasks"
        note="Each task states the interval it needs. Today one daily trigger offers every lane a chance — a gap that is infrastructure, not design.">
        <div className="overflow-x-auto rounded-xl border border-black/[.08] bg-white dark:border-white/[.1] dark:bg-zinc-950">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              <tr><th className="p-3">Task</th><th className="p-3">Lane</th><th className="p-3">Wants</th><th className="p-3">Last success</th><th className="p-3">Last run</th><th className="p-3">State</th></tr>
            </thead>
            <tbody>
              {health.scheduler.map((task) => {
                const late = task.overdueByMs !== null || !!task.stuckSince || task.lastOutcome === "failed";
                return (
                  <tr key={task.key} className="border-t border-black/[.06] dark:border-white/[.08]">
                    <td className="p-3 text-black dark:text-zinc-100" title={task.purpose}>{task.key}</td>
                    <td className="p-3 text-xs uppercase tracking-wide text-zinc-400">{task.lane}</td>
                    <td className="p-3 tabular-nums text-zinc-500 dark:text-zinc-400">{humanInterval(task.everyMs)}</td>
                    <td className="p-3 tabular-nums text-zinc-500 dark:text-zinc-400">{task.lastSuccessAt ? when(task.lastSuccessAt) : "never"}</td>
                    <td className="p-3 text-zinc-500 dark:text-zinc-400">
                      {task.lastOutcome ?? "—"}{task.lastDurationMs != null ? ` · ${task.lastDurationMs}ms` : ""}
                    </td>
                    <td className={`p-3 text-xs ${late ? "text-rose-700 dark:text-rose-400" : "text-zinc-500 dark:text-zinc-400"}`}>
                      {/* A task that is off is not a problem. Saying so plainly
                          keeps the red text meaning something. */}
                      {!task.enabled ? "off by decision"
                        : task.stuckSince ? `started ${when(task.stuckSince)}, never finished`
                        : task.overdueByMs !== null ? `overdue by ${humanInterval(task.overdueByMs)}`
                        : task.lastOutcome === "failed" ? "failed last run"
                        : "on schedule"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Failed webhook deliveries"
        note={`Replayable providers today: ${replayableProviders().join(", ") || "none"}. Every route answers 200, so a provider will not redeliver on its own.`}>
        {replayable.length === 0 ? (
          <Empty>No failed deliveries on file.</Empty>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-black/[.08] bg-white dark:border-white/[.1] dark:bg-zinc-950">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <tr><th className="p-3">Provider</th><th className="p-3">Event</th><th className="p-3">Received</th><th className="p-3">Why it failed</th><th className="p-3">Trace</th><th className="p-3 text-right">Action</th></tr>
              </thead>
              <tbody>
                {replayable.map((d) => (
                  <tr key={d.id} className="border-t border-black/[.06] dark:border-white/[.08]">
                    <td className="p-3 text-black dark:text-zinc-100">
                      {d.provider}
                      {/* An unverified delivery is never replayable, and saying so
                          here is more useful than a button that always refuses. */}
                      {!d.signatureValid && <span className="ml-2 rounded bg-rose-100 px-1.5 py-0.5 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-300">unverified</span>}
                    </td>
                    <td className="p-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">{d.externalEventId ?? "—"}</td>
                    <td className="p-3 tabular-nums text-zinc-500 dark:text-zinc-400">{when(d.receivedAt)}</td>
                    <td className="p-3 text-zinc-500 dark:text-zinc-400">{d.error ?? "—"}</td>
                    <td className="p-3">
                      {d.correlationId
                        ? <Link href={`/admin/operations?trace=${encodeURIComponent(d.correlationId)}`} className="text-xs underline">open</Link>
                        : <span className="text-xs text-zinc-400">—</span>}
                    </td>
                    <td className="p-3 text-right">
                      <ReplayButton deliveryId={d.id} replayable={d.signatureValid && canReplay.has(d.provider)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {health.queue.deadLetters.length > 0 && (
        <Section title="Jobs that gave up" note="Exhausted every retry. These will not run again on their own.">
          <div className="overflow-x-auto rounded-xl border border-black/[.08] bg-white dark:border-white/[.1] dark:bg-zinc-950">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <tr><th className="p-3">Kind</th><th className="p-3">Attempts</th><th className="p-3">Created</th><th className="p-3">Last error</th></tr>
              </thead>
              <tbody>
                {health.queue.deadLetters.map((j) => (
                  <tr key={j.id} className="border-t border-black/[.06] dark:border-white/[.08]">
                    <td className="p-3 text-black dark:text-zinc-100">{j.kind}</td>
                    <td className="p-3 tabular-nums">{j.attempts}</td>
                    <td className="p-3 tabular-nums text-zinc-500 dark:text-zinc-400">{when(j.createdAt)}</td>
                    <td className="p-3 text-zinc-500 dark:text-zinc-400">{j.lastError ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* ============ SEARCH, NOT A FEED ============================
          A successful chain is reachable — but only by naming something.
          The list below it stays failure-first for exactly that reason. */}
      <Section title="Find a chain"
        note="Paste a correlation id, execution id, provider reference, provider event id, or idempotency key. Successful chains are found this way too.">
        <form method="get" className="flex gap-2">
          <input
            type="search" name="q" defaultValue={q ?? ""} placeholder="an identifier you already have"
            className="w-full max-w-md rounded-lg border border-black/[.12] bg-white px-3 py-2 text-sm text-black dark:border-white/[.15] dark:bg-zinc-950 dark:text-zinc-100"
          />
          <button type="submit" className="rounded-lg border border-black/[.12] px-4 py-2 text-sm font-medium dark:border-white/[.15] dark:text-zinc-100">Find</button>
        </form>
        {q && (
          <div className="mt-3">
            {found.length === 0 ? (
              <Empty>Nothing matched that. Only exact identifiers are matched — a partial one finds nothing rather than guessing.</Empty>
            ) : (
              <ul className="space-y-1 text-sm">
                {found.map((r) => (
                  <li key={r.correlationId}>
                    <Link href={`/admin/operations?trace=${encodeURIComponent(r.correlationId)}`} className="underline">{r.label}</Link>
                    <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">{when(r.at)} · matched on {r.matchedOn}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Section>

      {trace && (
        <Section title={`Trace ${trace.correlationId}`}
          note={trace.entries.length === 0
            ? "No records carry this correlation id."
            : `${trace.entries.length} entries from ${trace.sources.length} of 6 sources · ${when(trace.startedAt)} → ${when(trace.endedAt)}`}>
          {trace.entries.length === 0 ? (
            <Empty>Nothing is recorded against this id. It is not an error — an unknown chain is simply empty.</Empty>
          ) : (
            <ol className="overflow-hidden rounded-xl border border-black/[.08] bg-white dark:border-white/[.1] dark:bg-zinc-950">
              {trace.entries.map((e, i) => (
                <li key={i} className="flex gap-4 border-t border-black/[.06] p-3 text-sm first:border-t-0 dark:border-white/[.08]">
                  <span className="w-40 shrink-0 font-mono text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{when(e.at)}</span>
                  {/* Each source keeps its own vocabulary — an execution's
                      FAILED is not a job's dead, and flattening them would lose
                      the distinctions worth reading. */}
                  <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-zinc-400">{e.source}</span>
                  <span className="flex-1 text-black dark:text-zinc-100">{e.label}</span>
                  <span className="w-28 shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{e.outcome ?? "—"}</span>
                  <span className="max-w-sm flex-1 truncate text-xs text-zinc-500 dark:text-zinc-400" title={JSON.stringify(e.detail)}>
                    {JSON.stringify(e.detail)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Section>
      )}

      <Section title="Recent chains that failed"
        note="Failure-first on purpose. One row per chain, however many things went wrong inside it.">
        {recent.length === 0 ? (
          <Empty>No failed chains recorded.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {recent.map((r) => (
              <li key={r.correlationId}>
                <Link href={`/admin/operations?trace=${encodeURIComponent(r.correlationId)}`} className="underline">{r.label}</Link>
                <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">{when(r.at)} · {r.source}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Webhook delivery health" note="Last 7 days. Replay exists because every route answers 200.">
        {health.webhooks.health.length === 0 ? (
          <Empty>No deliveries received in the window.</Empty>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-black/[.08] bg-white dark:border-white/[.1] dark:bg-zinc-950">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <tr><th className="p-3">Provider</th><th className="p-3">Received</th><th className="p-3">Processed</th><th className="p-3">Failed</th><th className="p-3">Rejected</th><th className="p-3">Last seen</th></tr>
              </thead>
              <tbody>
                {health.webhooks.health.map((h) => (
                  <tr key={h.provider} className="border-t border-black/[.06] dark:border-white/[.08]">
                    <td className="p-3 text-black dark:text-zinc-100">{h.provider}</td>
                    <td className="p-3 tabular-nums">{h.received}</td>
                    <td className="p-3 tabular-nums">{h.processed}</td>
                    <td className="p-3 tabular-nums">{h.failed}</td>
                    {/* Rejected means the signature did not verify. Not a bug —
                        possibly somebody probing. */}
                    <td className={`p-3 tabular-nums ${h.rejected > 0 ? "text-rose-700 dark:text-rose-400" : ""}`}>{h.rejected}</td>
                    <td className="p-3 tabular-nums text-zinc-500 dark:text-zinc-400">{when(h.lastReceivedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Security signals" note="Observed and counted here. Enforcement lives with the systems themselves, never on this page.">
        {health.security.length === 0 ? (
          <Empty>No signals in the window.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {health.security.map((s) => (
              <li key={`${s.kind}-${s.severity}`} className={s.severity === "critical" ? "text-rose-700 dark:text-rose-400" : "text-zinc-600 dark:text-zinc-300"}>
                <span className="tabular-nums font-semibold">{s.count}</span> × {s.kind}
                <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">{s.severity} · last {when(s.lastSeenAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </main>
  );
}
