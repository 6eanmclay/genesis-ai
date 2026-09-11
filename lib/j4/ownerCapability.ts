import { buildStoreChatUnifiedTools } from "@/lib/execution/genesisTools";
import { sectionHref } from "@/lib/dashboard/navConfig";
import type { OfficeAction, OwnerRequirement } from "./officeActions";

/**
 * WHAT J4 CANNOT DO, AND WHOSE PROBLEM THAT IS.
 *
 * ============ THE INSTRUCTION (Sean, 2026-09-10) =======================
 *
 * "Build that as a real, explicit capability model rather than having the
 * language model arbitrarily decide that something is 'owner-only.' I want the
 * capability-gap system to be grounded in what J4 actually can and cannot do."
 *
 * And the constraint that shapes it more than any other: "Do not turn every
 * limitation, failure, or uncertainty into needs_owner."
 *
 * ============ THE DISTINCTION THIS MODULE EXISTS TO HOLD ===============
 *
 * There are two completely different reasons J4 might not do something, and
 * only one of them is the owner's business:
 *
 *   A BOUNDARY   J4 cannot do it and never will, because the thing required
 *                is not software. Photographing a real object. Attesting to
 *                experience J4 has not had. Choosing what the owner wants the
 *                business to be. These are needs_owner, and naming them is
 *                the honest version of the partnership.
 *
 *   A GAP        Genesis has not built it yet. J4 cannot publish a social
 *                post today - not because posting requires the owner, but
 *                because no publishing tool exists in the catalogue.
 *
 * Routing a GAP to needs_owner would tell an owner that they are the missing
 * piece when the missing piece is our unshipped feature. That is a lie with a
 * specific victim, and it is the exact failure this codebase already has a
 * standing rule about: never fake a publisher to make an offer render.
 *
 * So a gap resolves to `internal` and stays out of the Office entirely.
 *
 * ============ WHY THE TOOL NAMES ARE CROSS-CHECKED =====================
 *
 * ARCHITECTURE.md, standing invariant: "A registry that mirrors another must
 * carry a runtime cross-check asserting every referenced name resolves in the
 * registry it mirrors. Guard a mirror the day you write it."
 *
 * Every `tool` below names a tool buildStoreChatUnifiedTools() really emits, and
 * `unresolvedTools()` exists so a suite can prove it. Without that, this file
 * would drift into describing a J4 that does not exist - which is precisely
 * the capability fiction it was written to prevent.
 *
 * The check runs in BOTH directions, and the second one is the useful one: a
 * boundary claiming J4 cannot do something a tool now does is a stale boundary,
 * and it must fail loudly rather than keep telling an owner to do work J4 could
 * have done for them.
 */

/**
 * What J4 can actually do, asked of the thing that builds the tools.
 *
 * ============ THE LIST THAT LOOKED RIGHT AND WAS NOT (2026-09-10) ======
 *
 * This first read STORE_CHAT_UNIFIED_TOOL_NAMES, a 16-name exported const
 * sitting in the same file. It is NINE SHORT of what buildStoreChatUnifiedTools
 * really emits, and the nine missing are every creation tool plus navigation:
 *
 *     show_upload_options   analyze_design_reference   generate_brand_logo
 *     create_design         approve_design_as_product  create_composition
 *     approve_composition   improve_storefront         take_me_there
 *
 * So a model of "what J4 can do" built on it described a J4 that cannot make a
 * design or take you anywhere - and every need naming one of those tools would
 * have resolved to "Genesis has not built this yet", which is false about nine
 * shipped capabilities. The suite caught it, but caught it as a PASS: the
 * assertion asked whether a real tool avoided needs_owner, it did, and being
 * wrongly `internal` satisfied that just as well as being rightly `execute`.
 *
 * Two lessons, both already written down elsewhere in this repo: ask the
 * builder rather than a list that resembles one, and assert the outcome you
 * want rather than the outcome you fear.
 *
 * Derived on every call. The builder is a pure function over module constants,
 * and a cached snapshot is one more thing that can be stale about capability -
 * which is the entire failure this module exists to prevent.
 */
function catalogue(): Set<string> {
  return new Set(buildStoreChatUnifiedTools().map((t) => t.name));
}

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
 * anything falls into. Four, because four is what can currently be defended.
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
] as const;

export type BoundaryId = (typeof J4_CANNOT)[number]["id"];

/** A real business need, and what it would take to meet it. */
export interface BusinessNeed {
  id: string;
  /** What is needed, in the owner's terms. */
  what: string;
  /**
   * The boundary this runs into. Present means the owner is the source.
   *
   * A need with a boundary AND a tool is a contradiction the suite rejects:
   * if J4 has a tool for it, it is not a boundary.
   */
  boundary?: BoundaryId;
  /** The catalogue tool that does this, when J4 genuinely has one. */
  tool?: string;
  /** Where the owner supplies it, when such a place exists. */
  provideAt?: { section: string; label: string };
}

/**
 * What the Office should offer about one need.
 *
 * Pure, and deliberately total: every path returns something, and the paths
 * are the four states Sean named plus the one that keeps Genesis' own gaps
 * away from the owner.
 */
export function actionForNeed(need: BusinessNeed, basePath: string): OfficeAction {
  // 1. THE OWNER IS THE SOURCE. The only route to needs_owner, and it requires
  //    a declared boundary - so nothing arrives here by being difficult.
  if (need.boundary) {
    const boundary = J4_CANNOT.find((b) => b.id === need.boundary);
    if (!boundary) {
      // A need naming a boundary that does not exist is a bug in this file,
      // not a message for an owner.
      return { kind: "internal", because: `"${need.id}" cites an unknown boundary "${need.boundary}"` };
    }
    return {
      kind: "needs_owner",
      missing: boundary.missing,
      what: need.what,
      because: boundary.because,
      ...(need.provideAt
        ? { provideAt: { label: need.provideAt.label, href: sectionHref(need.provideAt.section, basePath) } }
        : {}),
    };
  }

  // 2. J4 CAN DO IT. Only when the tool is really in the catalogue - a name
  //    that does not resolve is a capability we have described and not built.
  if (need.tool) {
    if (!catalogue().has(need.tool)) {
      return {
        kind: "internal",
        because: `"${need.id}" names the tool "${need.tool}", which is not in the catalogue - Genesis has not built this yet, and it is not the owner's to supply`,
      };
    }
    return { kind: "execute", label: need.what, intent: "approve" };
  }

  // 3. NEITHER. Not a boundary, not a tool: J4 has noticed something and has
  //    nothing to offer about it, which is a real answer and is said plainly.
  return {
    kind: "none",
    because: "I have noticed this and there is nothing I can do about it yet.",
  };
}

/**
 * Boundaries whose claim a real tool now contradicts.
 *
 * Exported for the suite. The direction that matters: if `create_design` one
 * day photographs objects, "I cannot photograph something in your workshop"
 * becomes a lie that sends an owner to do work J4 could have done. A stale
 * boundary is worse than a missing one.
 */
export function contradictedBoundaries(needs: readonly BusinessNeed[]): string[] {
  return needs.filter((n) => n.boundary && n.tool).map((n) => `${n.id} claims boundary "${n.boundary}" AND tool "${n.tool}"`);
}

/** Tool names referenced here that do not resolve in the catalogue. Exported for the suite. */
export function unresolvedTools(needs: readonly BusinessNeed[]): string[] {
  const known = catalogue();
  return needs.filter((n) => n.tool && !known.has(n.tool)).map((n) => `${n.id} -> ${n.tool}`);
}
