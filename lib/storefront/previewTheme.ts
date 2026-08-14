import { prisma } from "@/lib/prisma";
import type { Theme } from "@/lib/theme";
import {
  applyRefinementsToTheme,
  type RefineStorefrontChange,
} from "@/lib/execution/executables/refineStorefront";
import { PROPOSAL_STATUS } from "./proposals";

// Rendering the storefront as a proposal would leave it (2026-08-14).
//
// Sean's principle: "every meaningful visual change J4 proposes must be
// visually inspectable before the owner accepts it." The only honest way to
// show that is the real storefront renderer with the proposed theme applied —
// not a mock, not a description, not a screenshot of something adjacent.
//
// This follows the precedent app/store/[slug]/page.tsx already set for
// `previewOrder`: privileged preview state, owner and employee only, never
// persisted, and silently ignored when absent, unauthorized or malformed. A
// bad value here is never an error, because this is a way of looking at the
// store rather than a feature of it.
//
// The theme transform itself is imported, never reimplemented. Two copies
// would be a preview that lies, and the lie would only surface after the owner
// had already approved it.

/**
 * The theme a given proposal would produce, or null.
 *
 * Null for every reason a caller should simply fall back to the real stored
 * theme: no id supplied, the viewer is not an owner or employee, the proposal
 * belongs to another store, it is not a kind with a visual preview, or its
 * stored input no longer validates. None of those is an error worth showing
 * anyone; all of them mean "show the storefront as it actually is."
 */
export async function resolvePreviewTheme({
  storeId,
  currentTheme,
  proposalId,
  viewerIsStaff,
}: {
  storeId: string;
  currentTheme: Theme;
  proposalId: string | undefined;
  /** Owner or employee. Anyone else must never see unapplied proposals. */
  viewerIsStaff: boolean;
}): Promise<Theme | null> {
  if (!proposalId || !viewerIsStaff) return null;

  // storeId is in the query, not checked after it, so one store's proposal can
  // never render on another store's page.
  const row = await prisma.approvalRequest.findFirst({
    where: {
      storeId,
      proposalId,
      status: PROPOSAL_STATUS.pending,
    },
    orderBy: { revision: "desc" },
    select: { actionType: true, input: true },
  });
  if (!row) return null;

  // Only refine_storefront has a theme-shaped proposal today. Other action
  // types are previewed by their own means (update_section_order already has
  // previewOrder) or not yet at all, and must not be guessed at here.
  if (row.actionType !== "refine_storefront") return null;

  const changes = (row.input as { changes?: unknown })?.changes;
  if (!Array.isArray(changes)) return null;

  try {
    // applyRefinementsToTheme validates every dimension and value itself, and
    // throws on anything it does not recognise. Stored input is read back long
    // after it was written, so it gets the same gate a fresh tool call does.
    return applyRefinementsToTheme(currentTheme, changes as RefineStorefrontChange[]);
  } catch {
    // A proposal whose input no longer validates is shown as the real
    // storefront rather than as an error page. The owner is looking at their
    // shop; a stale proposal must not be able to break that view.
    return null;
  }
}
