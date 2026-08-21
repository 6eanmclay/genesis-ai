import { prisma } from "@/lib/prisma";
import { reportIssue } from "@/lib/observability/reportIssue";
import { buildSourcingContext } from "./context";
import { discoverProducts } from "./discover";
import { isBudgetExhausted } from "./sourcingBudget";

// WHEN GENESIS GOES LOOKING, without anybody pressing anything.
//
// Discovery was complete and had no caller: `catalogView` reads SUGGESTED rows,
// and only the catalog's own "Look again" button ever wrote them. A business
// that never pressed it saw an empty catalog forever.
//
// THE SAME LIFECYCLE EVERYTHING ELSE USES, not a scheduler. Home already runs
// detection on every load and already defers the work that must not block a
// render (see `after()` around the journey logger). This is that second kind:
// discovery makes real HTTP calls to suppliers, so it can never be awaited on a
// page somebody is waiting for, and a suggestion arriving on the next load
// rather than this one costs nothing.
//
// GATED HARD, because it is the most expensive thing in this subsystem — real
// network calls to real suppliers. Three conditions, all cheap, all exact:
//
//   1. Genesis knows the business. Searching on a description nobody wrote
//      returns things nobody can be told a reason for.
//   2. Nothing is already on the list. Discovery is for filling an empty
//      catalog, not for refreshing a full one — refreshing is what the owner's
//      own "Look again" is, and it is their call.
//   3. It has not run recently. A business with nothing to find must not
//      re-search every time somebody opens Home.

/** How long after a run Genesis will go looking again on its own. */
const QUIET_DAYS = 7;

export type DiscoveryLifecycleOutcome =
  | { ran: true; suggested: number; ruledOut: number }
  /** Not run, and why — never silently skipped. */
  | { ran: false; reason: "no_description" | "already_has_suggestions" | "ran_recently" | "failed" };

/**
 * Go looking, but only if there is a reason to.
 *
 * Never throws: this is called from `after()`, where an exception is a crash
 * nobody sees and a page that already rendered. A supplier being unreachable is
 * reported and returns "failed" rather than taking anything down.
 */
export async function discoverIfWorthwhile(storeId: string): Promise<DiscoveryLifecycleOutcome> {
  const [existing, lastRun] = await Promise.all([
    prisma.sourcedProduct.count({
      where: { storeId, status: { in: ["SUGGESTED", "ADOPTED"] } },
    }),
    prisma.sourcedProduct.findFirst({
      where: { storeId },
      orderBy: { discoveredAt: "desc" },
      select: { discoveredAt: true },
    }),
  ]);

  if (existing > 0) return { ran: false, reason: "already_has_suggestions" };

  if (lastRun) {
    const days = (Date.now() - lastRun.discoveredAt.getTime()) / 86_400_000;
    // A business where everything found was ruled out has rows but no
    // suggestions, and must not be re-searched on every page load.
    if (days < QUIET_DAYS) return { ran: false, reason: "ran_recently" };
  }

  const context = await buildSourcingContext(storeId);
  // The same gate `scoreCandidate` uses to return "unknown" rather than a
  // verdict. Searching without it produces rows Genesis cannot explain.
  if ((context.ownWords ?? "").trim().length === 0) {
    return { ran: false, reason: "no_description" };
  }

  try {
    const result = await discoverProducts({ storeId, context });
    return { ran: true, suggested: result.suggested.length, ruledOut: result.ruledOut.length };
  } catch (error) {
    // A refused budget is the ceiling working, not discovery failing. Reporting
    // it as a failure would put an alert in front of an operator for a run that
    // did exactly what it was told, and would hide the reason the pass stopped.
    if (isBudgetExhausted(error)) throw error;
    reportIssue("discovery failed on its own initiative", error, {
      subsystem: "sourcing",
      stage: "discovery.lifecycle",
      storeId,
    });
    return { ran: false, reason: "failed" };
  }
}
