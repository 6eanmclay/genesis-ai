import { isStorefrontTarget, type StorefrontTarget } from "./targets";

// How much of the storefront a proposal is asking the owner to judge
// (2026-08-14), and therefore how much of it must be shown.
//
// Sean's rule, from GENESIS_SURFACES.md: "proposal size must match change
// scope... do not show a tiny cropped thumbnail for a major redesign. The
// owner needs to actually be able to judge whether the proposal is better."
//
// This exists as a closed vocabulary rather than a number of pixels chosen at
// each call site, for the same reason lib/storefront/targets.ts is a closed
// registry: a rule that lives in prose gets violated by the next person in a
// hurry, and the violation is invisible in review. Here, a proposal that
// changes the whole site cannot be rendered at element size, because the
// scope is data and the presentation is derived from it.

export const PROPOSAL_SCOPES = {
  // One thing the owner can point at. A headline, a button, one image.
  element: {
    label: "this element",
    // Tall enough to show the element in its surroundings — an element with
    // no context around it cannot be judged either.
    previewHeightClass: "h-[260px]",
    // Element and section proposals are legible side by side on a phone
    // because each is small; a page is not.
    layout: "toggle" as const,
  },
  // A whole band of the page: the hero, the product grid, the story section.
  section: {
    label: "this section",
    previewHeightClass: "h-[420px]",
    layout: "toggle" as const,
  },
  // The homepage as a composition, not one part of it.
  page: {
    label: "this page",
    previewHeightClass: "h-[560px]",
    layout: "toggle" as const,
  },
  // Everything. The storefront as a whole.
  site: {
    label: "the whole storefront",
    // The largest the layer can give it. A redesign judged through a letterbox
    // is not judged at all.
    previewHeightClass: "h-[640px]",
    layout: "toggle" as const,
  },
} as const;

export type ProposalScope = keyof typeof PROPOSAL_SCOPES;

export const PROPOSAL_SCOPE_KEYS = Object.keys(PROPOSAL_SCOPES) as ProposalScope[];

/**
 * Narrows a stored or model-supplied value to a real scope.
 *
 * Own-property check rather than `in`, so inherited Object properties
 * ("constructor", "toString") can never resolve to a scope. Same discipline as
 * isStorefrontTarget.
 */
export function isProposalScope(value: unknown): value is ProposalScope {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROPOSAL_SCOPES, value);
}

// How many storefront dimensions a change has to touch before it stops being
// a section-sized change and becomes a page-sized one. Four is the ceiling a
// single refine_storefront run is allowed (MAX_MUTATIONS_PER_IMPROVEMENT), so
// three or more is "most of what one improvement can do".
const PAGE_SCALE_MUTATION_COUNT = 3;

// Targets that are structurally the whole page rather than a part of it.
// Derived from the target registry's own naming: a dotted target
// ("hero.headline") is always narrower than its parent ("hero").
const PAGE_LEVEL_TARGETS = new Set(["theme", "composition", "presentation", "layout"]);

/**
 * The scope a proposal should be judged at, derived rather than declared.
 *
 * Derived deliberately: asking the model to also pick a presentation size
 * gives it a second, unverifiable thing to get wrong, and a model that
 * understates scope gets to show a redesign in a thumbnail. Scope falls out
 * of what the proposal actually touches, so it cannot disagree with it.
 *
 * `target` null means store-wide, which is what every proposal predating the
 * target registry is (see ApprovalRequest.target's own comment).
 */
export function resolveProposalScope({
  target,
  mutationCount,
}: {
  target: string | null | undefined;
  mutationCount: number;
}): ProposalScope {
  // No target at all is a claim about the whole storefront by omission.
  if (!target) return mutationCount >= PAGE_SCALE_MUTATION_COUNT ? "site" : "page";

  if (PAGE_LEVEL_TARGETS.has(target)) return "site";

  // An unrecognised target is treated as page rather than element. The bias is
  // deliberate and one-directional: showing more than strictly necessary costs
  // the owner some screen, while showing less costs them the ability to judge
  // the proposal at all.
  if (!isStorefrontTarget(target)) return "page";

  // "hero.headline" is one element; "hero" is the section around it.
  const isDotted = target.includes(".");
  if (isDotted) {
    return mutationCount >= PAGE_SCALE_MUTATION_COUNT ? "section" : "element";
  }
  return mutationCount >= PAGE_SCALE_MUTATION_COUNT ? "page" : "section";
}

/** Presentation for a scope, so no call site invents its own height. */
export function proposalPresentation(scope: ProposalScope) {
  return PROPOSAL_SCOPES[scope];
}

export type { StorefrontTarget };
