import { randomUUID } from "node:crypto";
import { prismaSystem } from "@/lib/prisma";
import { reportIssue } from "@/lib/observability/reportIssue";
import { discoverIfWorthwhile, type DiscoveryLifecycleOutcome } from "./discoveryLifecycle";
import { refreshEconomicsIfStale } from "./economicsProducer";
import {
  SourcingBudget,
  currentSourcingBudget,
  isBudgetExhausted,
  withSourcingBudget,
  type SourcingBudgetPolicy,
} from "./sourcingBudget";

// SOURCING, UNATTENDED — a stage on the scheduler that already exists.
//
// Discovery and the economics refresh have run only on a Home load since they
// were built, so a business whose owner never opened Home was never searched and
// never refreshed. That was the deliberate scope of the catalog milestone and
// the one limitation it recorded.
//
// THIS IS NOT A NEW SCHEDULER. `app/api/cron/sync/route.ts` already runs four
// independent stages behind one CRON_SECRET-gated trigger — auth-attempt
// pruning, connector syncs, Growth Point refreshes and first-party intelligence
// cycles — each bounded by its own limit and isolated so one failure cannot
// abandon the others. This is a fifth stage in exactly that shape.
//
// NO SECOND OPINION ABOUT WHEN TO LOOK. `discoverIfWorthwhile` and
// `refreshEconomicsIfStale` already hold the gates, and they are called here
// unchanged. This module decides only WHICH businesses to consider, never
// whether one is due — two answers to that question would drift, and the one
// nobody maintained would be the one that got it wrong.

/** What a whole pass did, including why it stopped. */
export interface SourcingRunReport {
  runId: string;
  policyVersion: string;
  stores: SourcingRunSummary[];
  spent: { businesses: number; requests: number };
  /**
   * Why the pass ended.
   *
   * `budget_exhausted` is NOT a failure and must never read as one: a run that
   * stopped exactly where it was told to has done its job, and the businesses it
   * did not reach are still due. Saying "completed" for it would make a
   * truncated pass indistinguishable from one that found nothing to do.
   */
  stoppedBecause: "nothing_due" | "completed" | "budget_exhausted";
}

export interface SourcingRunSummary {
  storeId: string;
  discovery: DiscoveryLifecycleOutcome;
  economics: { ran: string[]; skipped: { sourceKey: string; reason: string }[] } | null;
  /** Set when the store's own pass threw. The others still ran. */
  error: string | null;
}

/**
 * Which businesses are worth considering this pass.
 *
 * A SUPERSET OF WHAT THE GATES WILL ACCEPT, deliberately. The filter here is
 * only what can be decided in one indexed query — a business that has said
 * something about itself — and everything finer is left to the gates, which
 * already own it. Getting this wrong in the narrow direction would silently
 * exclude a business that was genuinely due; getting it wrong in the wide
 * direction costs two cheap queries and an honest "not run".
 *
 * Ordered least-recently-looked-at first, nulls first, so a business nobody has
 * ever searched for is reached before one searched last week — and so a bounded
 * pass works through a backlog rather than revisiting the same head of the queue.
 *
 * `prismaSystem` because this is inherently cross-tenant, the same reason
 * `getDueSyncs` uses it.
 */
export async function getStoresDueForSourcing(limit: number, skipStoreIds?: Iterable<string>) {
  const skip = new Set(skipStoreIds ?? []);

  const rows = await prismaSystem.$queryRaw<{ id: string }[]>`
    SELECT s.id,
           MAX(sp."discoveredAt") AS last_looked
      FROM "Store" s
      LEFT JOIN "SourcedProduct" sp ON sp."storeId" = s.id
     WHERE (COALESCE(s.description, '') <> '' OR COALESCE(s.tagline, '') <> '')
     GROUP BY s.id
     ORDER BY last_looked ASC NULLS FIRST
     LIMIT ${limit + skip.size}`;

  return rows.map((r) => r.id).filter((id) => !skip.has(id)).slice(0, limit);
}

/**
 * Run the sourcing pass for every business due one.
 *
 * Per-store isolation, for the reason `runDueSyncs` records: this loop is
 * cross-tenant, and one store's bad row must not be able to hold the queue.
 * Both halves are attempted for every store — a discovery that could not run is
 * no reason to leave the supplier's own figures stale.
 */
export async function runDueSourcing(
  limit?: number,
  opts: { skipStoreIds?: Iterable<string>; policy?: SourcingBudgetPolicy; runId?: string } = {}
): Promise<SourcingRunReport> {
  const policy = opts.policy ?? currentSourcingBudget();
  // The budget's own ceiling is the limit unless a caller asks for less. Two
  // numbers that could disagree about how many businesses a pass may touch is
  // one number too many.
  const take = Math.min(limit ?? policy.maxBusinesses, policy.maxBusinesses);
  const runId = opts.runId ?? randomUUID();
  const budget = new SourcingBudget(runId, policy);

  // ONE MORE THAN CAN BE AFFORDED, deliberately. Selecting exactly the budget
  // meant a truncated pass and a complete one looked identical from inside: the
  // loop simply ran out of candidates and reported "completed" while businesses
  // were still waiting. Looking one further is how a page knows it is not the
  // last page — the extra candidate is never processed, only counted.
  const due = await getStoresDueForSourcing(take + 1, opts.skipStoreIds);
  const stores: SourcingRunSummary[] = [];
  let stoppedBecause: SourcingRunReport["stoppedBecause"] =
    due.length === 0 ? "nothing_due" : "completed";

  await withSourcingBudget(budget, async () => {
    for (const storeId of due) {
      // ASKED BEFORE THE BUSINESS IS STARTED, not after it has spent. A pass
      // that begins a store it cannot afford would make at least one request it
      // was not allowed to make.
      if (!budget.canStartBusiness()) {
        stoppedBecause = "budget_exhausted";
        break;
      }
      budget.startBusiness(storeId);

      try {
        // The gates live inside these two. Nothing here second-guesses them.
        const discovery = await discoverIfWorthwhile(storeId);
        const economics = await refreshEconomicsIfStale(storeId);
        stores.push({ storeId, discovery, economics, error: null });
      } catch (error) {
        // THE CEILING STOPS THE PASS; IT DOES NOT FAIL IT. The store is left
        // exactly as it was — nothing partial is written, because the refusal
        // happened before the request rather than during it — so the next
        // scheduled pass finds it still due and picks up where this one left off.
        if (isBudgetExhausted(error)) {
          stoppedBecause = "budget_exhausted";
          break;
        }

        reportIssue("the unattended sourcing pass threw for one store", error, {
          subsystem: "sourcing",
          stage: "schedule.sourcing",
          storeId,
        });
        stores.push({
          storeId,
          discovery: { ran: false, reason: "failed" },
          economics: null,
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
      }
    }
  });

  return { runId, policyVersion: policy.version, stores, spent: budget.spent(), stoppedBecause };
}
