import Link from "next/link";
import { readSignalPage, tallySignals, MAX_PAGE } from "@/lib/security/signals";
import type { Severity, ActorKind } from "@/lib/security/signals";
import { signalFootprint } from "@/lib/security/retention";

// INVESTIGATING SECURITY ACTIVITY.
//
// ============ THE STREAM HAD ONE READER (2026-08-30) ===================
//
// A tally on /admin/operations: how many of each kind, in the last week. Useful
// for noticing something and useless for looking into it. There was no way to
// ask which account, which business, which route, or what happened around one
// request — even though readSignals could already answer most of it.
//
// This page is that read layer and nothing else. It computes no counts of its
// own and holds no query: every number comes from readSignalPage, tallySignals
// or signalFootprint, so what an operator sees and what a future security
// intelligence would read are the same answers from the same code.
//
// ============ AND IT SHOWS LESS THAN THE DATABASE HOLDS ===============
//
// Addresses are withheld unless asked for, `detail` is redacted, and the
// browser identifier never comes back at all. Those rules live in the read
// layer, so this page could not expose them by accident even if it tried.

export const dynamic = "force-dynamic";

const SEVERITIES: Severity[] = ["info", "warning", "critical"];
const ACTOR_KINDS: ActorKind[] = ["user", "system", "genesis", "anonymous", "provider"];

const when = (d: Date | string | null) =>
  d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) : "—";

function toneFor(severity: string): string {
  if (severity === "critical") return "text-rose-700 dark:text-rose-400";
  if (severity === "warning") return "text-amber-700 dark:text-amber-400";
  return "text-zinc-600 dark:text-zinc-300";
}

const FILTERS: [string, string][] = [
  ["kind", "kind, e.g. authz.denied"],
  ["severity", "severity"],
  ["store", "store id"],
  ["actor", "actor id"],
  ["actorKind", "actor kind"],
  ["surface", "surface prefix, e.g. http:"],
  ["correlation", "correlation id"],
  ["since", "since (ISO)"],
  ["until", "until (ISO)"],
];

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const q = await searchParams;

  // Every filter is optional and each narrows. Parsed defensively — a query
  // string is caller-supplied, and a bad date must produce no filter rather
  // than an exception on an operator's page during an incident.
  const parseDate = (raw?: string) => {
    if (!raw) return undefined;
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? undefined : at;
  };

  const includeAddress = q.address === "1";
  const query = {
    kinds: q.kind ? [q.kind] : undefined,
    severities:
      q.severity && (SEVERITIES as string[]).includes(q.severity)
        ? [q.severity as Severity]
        : undefined,
    storeId: q.store || undefined,
    actorId: q.actor || undefined,
    actorKind:
      q.actorKind && (ACTOR_KINDS as string[]).includes(q.actorKind)
        ? (q.actorKind as ActorKind)
        : undefined,
    surface: q.surface || undefined,
    correlationId: q.correlation || undefined,
    since: parseDate(q.since),
    until: parseDate(q.until),
    after: q.after || undefined,
    // Opt-in, and the opting-in is visible in the URL — which is the record
    // that somebody chose to look at addresses.
    includeAddress,
    limit: 100,
  };

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [page, tally, footprint] = await Promise.all([
    readSignalPage(query),
    tallySignals(weekAgo),
    signalFootprint(),
  ]);

  const keep = (extra: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...q, ...extra })) {
      if (v) params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `/admin/security?${s}` : "/admin/security";
  };

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Security activity</h1>
        <Link href="/admin/operations" className="text-xs text-zinc-500 underline dark:text-zinc-400">Operations</Link>
      </div>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Addresses are hidden and details redacted unless asked for. Browser identifiers are never shown.
      </p>

      {/* WHAT IS HAPPENING, before what happened. The tally is the reason to
          start looking; the list below is the looking. */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Last seven days</h2>
        {tally.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-black/[.12] bg-white p-5 text-sm text-zinc-500 dark:border-white/[.12] dark:bg-zinc-950 dark:text-zinc-400">
            Nothing recorded. On a quiet platform that is the expected answer.
          </p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {tally.map((t) => (
              <li key={`${t.kind}-${t.severity}`}>
                <Link
                  href={keep({ kind: t.kind, severity: t.severity, after: undefined })}
                  className={`inline-flex items-center gap-2 rounded-lg border border-black/[.08] bg-white px-3 py-1.5 text-sm dark:border-white/[.1] dark:bg-zinc-950 ${toneFor(t.severity)}`}
                >
                  <span className="tabular-nums font-semibold">{t.count}</span>
                  <span>{t.kind}</span>
                  <span className="text-xs text-zinc-400">{when(t.lastSeenAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Narrow it</h2>
        <form method="get" className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {FILTERS.map(([name, placeholder]) => (
            <input
              key={name}
              name={name}
              defaultValue={q[name] ?? ""}
              placeholder={placeholder}
              className="rounded-lg border border-black/[.12] bg-white px-3 py-2 text-sm text-black dark:border-white/[.15] dark:bg-zinc-950 dark:text-zinc-100"
            />
          ))}
          <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
            <input type="checkbox" name="address" value="1" defaultChecked={includeAddress} />
            show addresses
          </label>
          <button type="submit" className="rounded-lg border border-black/[.12] px-4 py-2 text-sm font-medium dark:border-white/[.15] dark:text-zinc-100">
            Search
          </button>
        </form>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Signals {page.rows.length > 0 ? `· showing ${page.rows.length}` : ""}
        </h2>
        {page.rows.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-black/[.12] bg-white p-5 text-sm text-zinc-500 dark:border-white/[.12] dark:bg-zinc-950 dark:text-zinc-400">
            Nothing matches those filters.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-black/[.08] bg-white dark:border-white/[.1] dark:bg-zinc-950">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <tr>
                  <th className="p-3">When</th><th className="p-3">Kind</th><th className="p-3">Actor</th>
                  <th className="p-3">Surface</th><th className="p-3">Store</th>
                  {includeAddress && <th className="p-3">Address</th>}
                  <th className="p-3">Detail</th><th className="p-3">Trace</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <tr key={row.id} className="border-t border-black/[.06] dark:border-white/[.08]">
                    <td className="p-3 whitespace-nowrap tabular-nums text-zinc-500 dark:text-zinc-400">{when(row.occurredAt)}</td>
                    <td className={`p-3 ${toneFor(row.severity)}`}>{row.kind}</td>
                    <td className="p-3 text-xs text-zinc-500 dark:text-zinc-400">
                      {row.actorKind}
                      {row.actorId && (
                        <Link href={keep({ actor: row.actorId, after: undefined })} className="ml-1 underline">
                          {row.actorId.slice(0, 8)}…
                        </Link>
                      )}
                    </td>
                    <td className="p-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">{row.surface ?? "—"}</td>
                    <td className="p-3 text-xs">
                      {row.storeId ? (
                        <Link href={keep({ store: row.storeId, after: undefined })} className="underline">
                          {row.storeId.slice(0, 8)}…
                        </Link>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    {includeAddress && (
                      <td className="p-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">{row.ipAddress ?? "—"}</td>
                    )}
                    <td className="max-w-xs truncate p-3 text-xs text-zinc-500 dark:text-zinc-400" title={JSON.stringify(row.detail)}>
                      {row.detail ? JSON.stringify(row.detail) : "—"}
                    </td>
                    <td className="p-3 text-xs">
                      {/* ============ INTO THE SURROUNDING STORY =========
                          A signal on its own says a request was refused. The
                          trace says what that request was doing — which
                          execution, which webhook, which job. */}
                      {row.correlationId ? (
                        <Link href={`/admin/operations?trace=${encodeURIComponent(row.correlationId)}`} className="underline">open</Link>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {page.nextCursor && (
          <p className="mt-3">
            <Link href={keep({ after: page.nextCursor })} className="text-sm underline">Older signals →</Link>
          </p>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">What is kept, and for how long</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Horizons differ by what a signal is for. Pruning runs as a queued job and defaults to a dry run.
        </p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-black/[.08] bg-white dark:border-white/[.1] dark:bg-zinc-950">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              <tr><th className="p-3">Class</th><th className="p-3">Kept</th><th className="p-3">Held</th><th className="p-3">Past its horizon</th></tr>
            </thead>
            <tbody>
              {footprint.byClass.map((c) => (
                <tr key={c.class} className="border-t border-black/[.06] dark:border-white/[.08]">
                  <td className="p-3 text-black dark:text-zinc-100">{c.class}</td>
                  <td className="p-3 tabular-nums text-zinc-500 dark:text-zinc-400">{c.keepDays} days</td>
                  <td className="p-3 tabular-nums">{c.count}</td>
                  <td className={`p-3 tabular-nums ${c.overdue > 0 ? "text-amber-700 dark:text-amber-400" : "text-zinc-500 dark:text-zinc-400"}`}>{c.overdue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          {footprint.total} signals held · oldest {when(footprint.oldest)} · a page shows at most {MAX_PAGE}
        </p>
      </section>
    </main>
  );
}
