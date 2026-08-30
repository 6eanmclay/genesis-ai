import { prisma } from "@/lib/prisma";
import { reportIssue } from "@/lib/observability/reportIssue";

// HOW MUCH A BUSINESS IS ALLOWED TO STORE.
//
// ============ THE PLANLESS DECISION (2026-08-29) =======================
//
// Sean: "Planless stores use the Starter 5 GB allowance." And, earlier and just
// as firmly: "Do not silently assign Starter, Growth, Business Partner, or any
// other default."
//
// Those are not in tension, and the difference is the whole of this file. A
// store with no plan RESOLVES to Starter's allowance when the question is
// asked. Nothing is written to it: `planId` stays null, billing is untouched,
// and the store is still, factually, on no plan. All 16 stores are in exactly
// that state today.
//
// ============ THE NUMBER IS DATA, NOT A CONSTANT ======================
//
// Plan.includedStorageBytes, seeded from STORAGE.md §9 — 5 / 15 / 50 GB. An
// allowance can then change without a deploy, which matters for a figure the
// document itself calls a product decision rather than an engineering one.
//
// ============ AND "Starter" IS A MIRRORED REGISTRY ====================
//
// A name in code pointing at a row in a table is exactly the shape
// ARCHITECTURE.md's standing invariant is about: the compiler cannot check it,
// and renaming or deleting that row would make every planless store's allowance
// undefined — silently, and in the direction that refuses uploads. So
// scripts/verify-storage-allowance.ts asserts the row exists and carries a
// non-null allowance.

/** The plan a store with no plan borrows its allowance from. */
export const PLANLESS_FALLBACK_PLAN = "Starter";

export class NoAllowanceConfiguredError extends Error {
  constructor(detail: string) {
    super(`Storage allowance is not configured: ${detail}`);
    this.name = "NoAllowanceConfiguredError";
  }
}

export interface Allowance {
  bytes: number;
  /** The plan the number came from — never null, even when the store has none. */
  fromPlan: string;
  /** True when the store itself is on no plan and borrowed the fallback. */
  borrowed: boolean;
}

/**
 * What this store may store.
 *
 * THROWS rather than defaulting when nothing can be resolved. A zero would
 * refuse every upload and a large number would refuse none; both are worse than
 * an error naming the misconfiguration, and neither is a fact.
 */
export async function allowanceFor(storeId: string): Promise<Allowance> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { plan: { select: { name: true, includedStorageBytes: true } } },
  });

  if (store?.plan) {
    if (store.plan.includedStorageBytes === null) {
      throw new NoAllowanceConfiguredError(`plan "${store.plan.name}" has no includedStorageBytes`);
    }
    return {
      bytes: Number(store.plan.includedStorageBytes),
      fromPlan: store.plan.name,
      borrowed: false,
    };
  }

  // No plan. Read the fallback's allowance — do not assign it.
  const fallback = await prisma.plan.findUnique({
    where: { name: PLANLESS_FALLBACK_PLAN },
    select: { name: true, includedStorageBytes: true },
  });
  if (!fallback || fallback.includedStorageBytes === null) {
    throw new NoAllowanceConfiguredError(
      `no plan on the store and the "${PLANLESS_FALLBACK_PLAN}" fallback is ${fallback ? "missing an allowance" : "absent"}`,
    );
  }
  return { bytes: Number(fallback.includedStorageBytes), fromPlan: fallback.name, borrowed: true };
}

/**
 * The same question, asked in a way that cannot stop a business working.
 *
 * ============ FAIL OPEN ON CONFIGURATION, CLOSED ON CAPACITY ===========
 *
 * Sean, 2026-08-29: "a missing/misconfigured allowance should not break Product
 * Creation, but it must generate a clear system-level warning. A known
 * quota/over-allocation still fails closed."
 *
 * The two are genuinely different failures and deserve opposite answers:
 *
 *   a KNOWN allowance that is exceeded  — the owner's problem, and refusing is
 *                                         the honest thing to do
 *   an allowance nobody configured      — OUR problem, and refusing would stop
 *                                         a merchant creating products because
 *                                         of a row missing from our own plan
 *                                         table
 *
 * Blocking creation platform-wide because storage accounting is misconfigured
 * would make a bookkeeping feature a single point of failure for the product.
 * So this returns null bytes, reports loudly, and every caller treats null as
 * "cannot enforce" rather than "no space".
 */
export interface AllowanceResolution {
  /** Null when it could not be resolved. Never a guess, never a zero. */
  bytes: number | null;
  fromPlan: string | null;
  borrowed: boolean;
  /** Why it is unknown, when it is. */
  problem: string | null;
}

export async function resolveAllowance(storeId: string): Promise<AllowanceResolution> {
  try {
    const allowance = await allowanceFor(storeId);
    return { bytes: allowance.bytes, fromPlan: allowance.fromPlan, borrowed: allowance.borrowed, problem: null };
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    // LOUD, because this is a platform misconfiguration rather than a merchant
    // one, and the symptom — storage silently unenforced — is invisible.
    reportIssue(`storage allowance could not be resolved for ${storeId}`, error, {
      subsystem: "storage",
      stage: "allowance.unresolved",
      storeId,
    });
    return { bytes: null, fromPlan: null, borrowed: false, problem };
  }
}
