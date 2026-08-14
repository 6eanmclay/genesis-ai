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
  // Matches on either the proposal chain id or a bare ApprovalRequest id, so
  // a proposal predating the revision chain (every approval written before
  // 2026-08-14) previews the same way as one created after it. Same store in
  // the query, never checked afterwards, so one store's proposal can never
  // render on another store's page.
  const row = await prisma.approvalRequest.findFirst({
    where: {
      storeId,
      status: PROPOSAL_STATUS.pending,
      OR: [{ proposalId }, { id: proposalId }],
    },
    orderBy: { revision: "desc" },
    select: { actionType: true, input: true },
  });
  if (!row) return null;

  try {
    // update_theme's input IS the theme — see its executable, which writes
    // `data: { theme: input }` unchanged. So the preview is the input, and
    // there is no transform that could drift.
    if (row.actionType === "update_theme") {
      const proposed = row.input as Theme | null;
      // A theme needs at least the shape the renderer reads. Anything else
      // falls back rather than rendering a half-themed shop.
      if (!proposed || typeof proposed !== "object") return null;
      return proposed;
    }

    if (row.actionType === "refine_storefront") {
      const changes = (row.input as { changes?: unknown })?.changes;
      if (!Array.isArray(changes)) return null;
      // applyRefinementsToTheme validates every dimension and value itself,
      // and throws on anything it does not recognise. Stored input is read
      // back long after it was written, so it gets the same gate a fresh tool
      // call does.
      return applyRefinementsToTheme(currentTheme, changes as RefineStorefrontChange[]);
    }

    // Everything else writes the blueprint rather than the theme, and is
    // previewed by its own means: update_section_order through the
    // longstanding previewOrder parameter, the rest through a field-level
    // comparison in the conversation. Deliberately not guessed at here — a
    // preview that silently shows the unchanged storefront while claiming to
    // show a proposal is worse than no preview.
    return null;
  } catch {
    // A proposal whose input no longer validates is shown as the real
    // storefront rather than as an error page. The owner is looking at their
    // shop; a stale proposal must not be able to break that view.
    return null;
  }
}
