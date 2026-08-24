import { prisma } from "@/lib/prisma";
import { namedKeyMismatches, verifiedUnless, type VerificationOutcome } from "./verification";

// READING PERSISTED STATE BACK, for verification.
//
// Separate from verification.ts on purpose: that file is pure comparison logic
// and stays testable without a database, while this one is the data access. The
// split matters because the comparison rules — especially the Class B
// named-keys rule — are the part most worth asserting directly.
//
// EVERY FUNCTION HERE RE-READS. None of them accepts a value that `run()`
// returned, because the whole point of verification is to distrust exactly that
// value: a write can return without throwing and still not be what was asked
// for.

interface BlueprintShape {
  [section: string]: unknown;
}

/**
 * Class B — a merge into one section of the store's blueprint.
 *
 * Compares ONLY the keys the input named. This is the rule most likely to be
 * got wrong, and getting it wrong is expensive in a quiet way: a blueprint
 * section holds keys from several different actions, so comparing the whole
 * section against one action's input would report every untouched key as a
 * mismatch and turn every successful merge into a WARNING.
 */
export async function verifyBlueprintSection(
  storeId: string,
  section: string,
  named: object
): Promise<VerificationOutcome> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { blueprint: true },
  });
  if (!store) {
    return { state: "failed", mismatches: [`the store no longer exists`] };
  }
  const blueprint = (store.blueprint as BlueprintShape | null) ?? {};
  const stored = (blueprint[section] as Record<string, unknown> | undefined) ?? undefined;
  if (!stored) {
    return { state: "failed", mismatches: [`${section}: nothing was stored`] };
  }
  return verifiedUnless(namedKeyMismatches(named, stored, `${section}.`));
}

/**
 * Class A — columns on the store row, compared to the values asked for.
 */
export async function verifyStoreColumns(
  storeId: string,
  named: object
): Promise<VerificationOutcome> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    return { state: "failed", mismatches: [`the store no longer exists`] };
  }
  return verifiedUnless(namedKeyMismatches(named, store as unknown as Record<string, unknown>));
}

/**
 * Class C — a row that should now exist, with the values asked for.
 *
 * Absence is a mismatch in its own right: a create that silently wrote nothing
 * is the defect this catches, and it does not throw.
 */
export async function verifyRowExists(
  label: string,
  find: () => Promise<Record<string, unknown> | null>,
  named: object = {}
): Promise<VerificationOutcome> {
  const row = await find();
  if (!row) return { state: "failed", mismatches: [`${label}: no such row after the write`] };
  return verifiedUnless(namedKeyMismatches(named, row, `${label}.`));
}

/**
 * Class C, the other direction — a row that should now be gone.
 *
 * A delete that matched nothing is the same defect arriving from the opposite
 * side, and Prisma's deleteMany reports a count rather than throwing.
 */
export async function verifyRowAbsent(
  label: string,
  find: () => Promise<unknown | null>
): Promise<VerificationOutcome> {
  const row = await find();
  if (row) return { state: "failed", mismatches: [`${label}: still present after the delete`] };
  return { state: "verified" };
}
