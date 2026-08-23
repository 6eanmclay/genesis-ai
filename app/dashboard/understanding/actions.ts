"use server";

import { revalidatePath } from "next/cache";
import { PERMISSIONS, requireBusinessOrActive } from "@/lib/permissions";
import { businessBasePath, LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { contradictBelief, restoreBelief, type ContradictOutcome } from "@/lib/intelligence/beliefReview";

// SAYING "NO, THAT'S WRONG" TO J4 (2026-08-22, U4).
//
// GUARDED TWICE, on purpose, and neither guard is redundant.
//
// requireBusinessOrActive enforces that the caller may act on this business at
// all, and is what makes the screen's own rendering a presentation detail
// rather than the enforcement — a control that is not drawn is not a control
// that cannot be called.
//
// contradictBelief then enforces that the actor is the OWNER specifically, which
// STORE_MANAGE does not imply on its own. That check lives in the library rather
// than here because it is a property of the operation, not of this route: any
// future caller inherits it.
//
// Business-scoped and slug-bound, following the pattern the rest of the
// dashboard holds: an action submitted from one business's page acts on THAT
// business, never on whichever one the account last made active.

function understandingPath(slug?: string) {
  return `${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/understanding`;
}

export async function contradictBeliefAction(
  formData: FormData,
  slug?: string
): Promise<ContradictOutcome> {
  const { storeId, userId } = await requireBusinessOrActive(PERMISSIONS.STORE_MANAGE, slug);
  const outcome = await contradictBelief({
    storeId,
    userId,
    beliefId: String(formData.get("beliefId") ?? ""),
    // The owner's own words, passed through untouched. Nothing parses this; it
    // is there so a person reading the belief later can see why it was rejected
    // rather than only that it was.
    note: String(formData.get("note") ?? ""),
  });
  revalidatePath(understandingPath(slug));
  return outcome;
}

export async function restoreBeliefAction(
  formData: FormData,
  slug?: string
): Promise<ContradictOutcome> {
  const { storeId, userId } = await requireBusinessOrActive(PERMISSIONS.STORE_MANAGE, slug);
  const outcome = await restoreBelief({
    storeId,
    userId,
    beliefId: String(formData.get("beliefId") ?? ""),
  });
  revalidatePath(understandingPath(slug));
  return outcome;
}
