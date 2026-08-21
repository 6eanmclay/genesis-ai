import { AsyncLocalStorage } from "node:async_hooks";
import { prismaSystem } from "@/lib/prisma";

// WHAT AN UNATTENDED SOURCING RUN IS ALLOWED TO SPEND.
//
// The scheduler stage makes outbound calls to third parties on its own
// initiative, with nobody watching. Every other cost in this codebase is either
// bounded by a person clicking something or metered by Growth Points; this one
// is neither, and until now nothing bounded it at all.
//
// THE CEILING IS AT THE OUTBOUND CALL, NOT IN A COUNTER READ AFTERWARDS. A
// budget that tallies requests once they have been made has already spent the
// money it was supposed to protect. `supplierRequest` asks BEFORE the fetch and
// refuses, so an exhausted budget cannot produce one more request.
//
// SCOPED TO A RUN, deliberately. The same connector serves order fulfilment —
// buying a label, creating an order — and those must never be refused because a
// discovery pass used up its allowance. An AsyncLocalStorage run context is what
// separates them: inside a sourcing run the budget applies, outside it there is
// no budget and nothing is recorded as scheduled spend.
//
// NOT AI COST AND NOT GROWTH POINTS. Supplier HTTP is a third axis. Folding it
// into `AiUsageEvent` would put network calls in a table whose every column is
// about tokens and models; folding it into `GrowthPointTransaction` would charge
// an owner for work Genesis chose to do unprompted. Both would be lies that
// balance.

export interface SourcingBudgetPolicy {
  /** Bumped whenever any value below changes. */
  version: string;
  /**
   * How many businesses one unattended pass may process.
   *
   * A ceiling, NOT a selection rule. Which businesses are due is still decided
   * by `getStoresDueForSourcing` and the gates; this only says when to stop.
   */
  maxBusinesses: number;
  /** How many supplier HTTP requests one whole pass may make. */
  maxSupplierRequests: number;
  /**
   * How many one business may make before the pass moves on.
   *
   * Without it, a single business with a large catalogue could consume the whole
   * pass's allowance and starve everything behind it in the queue — which is the
   * opposite of what a bounded backlog-working scheduler is for.
   */
  maxRequestsPerBusiness: number;
}

export const CURRENT_SOURCING_BUDGET: SourcingBudgetPolicy = {
  version: "2026-08-21.1",
  // Deliberately conservative on both axes. The cost of being too small is a
  // backlog that takes an extra pass to clear; the cost of being too large is
  // real money spent unattended on somebody else's API. Only one of those is
  // recoverable by waiting.
  maxBusinesses: 25,
  // A Printful discovery is up to 9 requests and an economics refresh is
  // 1 + 2 per adopted product, so this is roughly a dozen businesses' worth of
  // real work — comfortably more than one pass usually needs, and far short of
  // anything that could run away.
  maxSupplierRequests: 200,
  maxRequestsPerBusiness: 40,
};

export function currentSourcingBudget(): SourcingBudgetPolicy {
  return CURRENT_SOURCING_BUDGET;
}

/** Thrown at the call boundary, before any request is made. */
export class SourcingBudgetExhausted extends Error {
  readonly scope: "run" | "business";
  constructor(scope: "run" | "business") {
    super(
      scope === "run"
        ? "the sourcing run has spent its supplier-request budget"
        : "this business has spent its share of the sourcing run's budget"
    );
    this.name = "SourcingBudgetExhausted";
    this.scope = scope;
  }
}

export function isBudgetExhausted(error: unknown): error is SourcingBudgetExhausted {
  return error instanceof SourcingBudgetExhausted;
}

/** One run's ledger. Created per pass, never shared between them. */
export class SourcingBudget {
  readonly policy: SourcingBudgetPolicy;
  readonly runId: string;
  private runRequests = 0;
  private businessRequests = 0;
  private businesses = 0;
  private currentStoreId: string | null = null;

  constructor(runId: string, policy: SourcingBudgetPolicy = currentSourcingBudget()) {
    this.runId = runId;
    this.policy = policy;
  }

  /** Whether another business may be started at all. */
  canStartBusiness(): boolean {
    return (
      this.businesses < this.policy.maxBusinesses &&
      this.runRequests < this.policy.maxSupplierRequests
    );
  }

  /** Begin one business's share. Resets the per-business allowance. */
  startBusiness(storeId: string): void {
    this.businesses += 1;
    this.businessRequests = 0;
    this.currentStoreId = storeId;
  }

  /**
   * May one more supplier request be made?
   *
   * Consumes on success and refuses on failure — never both, and never after.
   */
  private take(): SourcingBudgetExhausted | null {
    if (this.runRequests >= this.policy.maxSupplierRequests) return new SourcingBudgetExhausted("run");
    if (this.businessRequests >= this.policy.maxRequestsPerBusiness) {
      return new SourcingBudgetExhausted("business");
    }
    this.runRequests += 1;
    this.businessRequests += 1;
    return null;
  }

  spent(): { businesses: number; requests: number } {
    return { businesses: this.businesses, requests: this.runRequests };
  }

  storeId(): string | null {
    return this.currentStoreId;
  }

  /** Internal — used by `supplierRequest` only. */
  consumeOrThrow(): void {
    const refusal = this.take();
    if (refusal) throw refusal;
  }
}

const runScope = new AsyncLocalStorage<SourcingBudget>();

/** Run something inside a budgeted sourcing pass. */
export function withSourcingBudget<T>(budget: SourcingBudget, run: () => Promise<T>): Promise<T> {
  return runScope.run(budget, run);
}

/** The budget for the pass currently running, if any. */
export function activeSourcingBudget(): SourcingBudget | null {
  return runScope.getStore() ?? null;
}

/** One recorded supplier request. Written per request, never batched away. */
export interface SupplierRequestRecord {
  storeId: string | null;
  sourceKey: string;
  operation: string;
  ok: boolean;
  durationMs: number;
  runId: string | null;
}

async function record(entry: SupplierRequestRecord): Promise<void> {
  try {
    await prismaSystem.supplierRequestEvent.create({
      data: {
        storeId: entry.storeId,
        sourceKey: entry.sourceKey,
        operation: entry.operation,
        ok: entry.ok,
        durationMs: entry.durationMs,
        runId: entry.runId,
      },
    });
  } catch {
    // Accounting must never be the reason a supplier call fails. A lost row is
    // a gap in a ledger; a thrown error here would be a discovery pass taken
    // down by its own bookkeeping.
  }
}

/**
 * THE OUTBOUND BOUNDARY. Every supplier HTTP request goes through here.
 *
 * Inside a sourcing run: the budget is asked first and refuses by throwing
 * BEFORE `run` is called, so an exhausted budget cannot produce one more
 * request. Outside a run — an owner clicking "what does it cost", an order being
 * fulfilled — there is no budget and the call proceeds untouched.
 *
 * Either way the request is recorded, because "how much did we ask this supplier
 * for" is worth knowing whoever asked.
 */
export async function supplierRequest<T>(
  params: { sourceKey: string; operation: string; storeId?: string | null },
  run: () => Promise<T>
): Promise<T> {
  const budget = activeSourcingBudget();
  // BEFORE the call. This line is the entire ceiling.
  if (budget) budget.consumeOrThrow();

  const startedAt = Date.now();
  try {
    const result = await run();
    await record({
      storeId: params.storeId ?? budget?.storeId() ?? null,
      sourceKey: params.sourceKey,
      operation: params.operation,
      ok: true,
      durationMs: Date.now() - startedAt,
      runId: budget?.runId ?? null,
    });
    return result;
  } catch (error) {
    await record({
      storeId: params.storeId ?? budget?.storeId() ?? null,
      sourceKey: params.sourceKey,
      operation: params.operation,
      ok: false,
      durationMs: Date.now() - startedAt,
      runId: budget?.runId ?? null,
    });
    throw error;
  }
}
