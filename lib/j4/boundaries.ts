import type { OwnerRequirement } from "./officeActions";

// WHAT J4 CANNOT DO — THE CLOSED LIST, AS DATA.
//
// ============ WHY IT LEFT ownerCapability.ts (2026-09-14) ==============
//
// This list is a set of claims about the world. ownerCapability.ts is the
// capability CHECK, and it reaches for the live tool catalogue — which means it
// can never be imported by anything the browser loads.
//
// Observations now need the same list. The Office decides an observation's
// action in lib/j4/officeActions.ts, and lib/j4/officeBriefing.ts beside it is
// value-imported by app/j4/J4Workspace.tsx, a client component. So the data had
// to stop travelling with the server dependency, or the tool catalogue would
// have been pulled into a browser bundle to render a sentence.
//
// Same split, and the same reason, as lib/j4/officeSections.ts ("structurally
// typed so this file needs no imports that survive compilation") and
// lib/security/roleLabels.ts. ownerCapability.ts re-exports all three names, so
// nothing that already imported them had to change.
//
// ZERO VALUE IMPORTS. The one import above is a type and disappears at compile
// time; that is the property this file exists to keep.

/** Something J4 cannot do because the thing required is not software. */
export interface Boundary {
  id: string;
  /** Which kind of missing thing this is, for the Office. */
  missing: OwnerRequirement;
  /** Why J4 cannot supply it, in the owner's terms. Never an apology. */
  because: string;
}

/**
 * The closed list of boundaries.
 *
 * Closed on purpose. A boundary is a claim about the world, not about the
 * backlog, and adding one is a decision somebody makes rather than a default
 * anything falls into.
 */
export const J4_CANNOT: readonly Boundary[] = [
  {
    id: "photograph_physical_object",
    missing: "capability",
    because:
      "I can generate images, but I cannot photograph something that exists in your workshop. A picture of the real thing has to come from you.",
  },
  {
    id: "attest_to_owner_experience",
    missing: "capability",
    because:
      "I can write, but I cannot claim your experience as if it were mine. What you have actually done has to come from you.",
  },
  {
    id: "choose_owner_intent",
    missing: "decision",
    because:
      "I can lay out the options and what each would cost you. Which one you want the business to be is yours to settle.",
  },
  {
    id: "grant_access_on_owners_behalf",
    missing: "permission",
    because:
      "I cannot authorise myself against an account you own. Connecting it is something only you can do.",
  },
  // ============ THE FIFTH, ADDED ON EVIDENCE (2026-09-14) =============
  //
  // `missing: "information"` has been in the Office's vocabulary since it was
  // written — "J4 would act if it knew something only the owner knows" — and
  // no boundary had ever claimed it. This is the one that does.
  //
  // DETERMINED, NOT ASSUMED. The natural cron produced two real
  // commerce:orders_shipped_untracked observations on 2026-09-14. Both orders
  // were read from production: carrier NULL, labelClaimedAt NULL,
  // shippingCostInCents NULL — no label was ever bought through Genesis, so the
  // number exists only with the owner and the carrier. And the tool that exists
  // for this, attachTracking, TAKES a tracking number as input: J4 can apply
  // one and cannot discover one.
  //
  // NOT A GAP. Genesis has not failed to build something here — a fact held
  // outside the system is not an unshipped feature, which is the distinction
  // ownerCapability.ts exists to hold.
  {
    id: "know_information_only_the_owner_holds",
    missing: "information",
    because:
      "I can put it on the order the moment I have it, but the tracking number is between you and the carrier. It has to come from you.",
  },
] as const;

export type BoundaryId = (typeof J4_CANNOT)[number]["id"];
