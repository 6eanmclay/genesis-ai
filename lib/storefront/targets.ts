import { SECTION_KEYS, SECTION_LABELS, type SectionKey } from "@/lib/storefrontSections";
import type { GenesisActionType } from "@/lib/execution/genesisActions";

// Storefront Canvas, step 2 of 6 (2026-08-12) — the closed registry of every
// part of a storefront J4 is allowed to name, and the actions that can
// actually change each one.
//
// This file is pure. It reads nothing, writes nothing, and adds no behaviour;
// steps 3 through 5 are what start using it.
//
// THE INVARIANT THIS FILE EXISTS TO ENFORCE: a target with no action behind
// it must be unaddressable. The failure worth designing against is not "J4
// cannot address enough of the page" — it is J4 highlighting something,
// sounding certain, and then having no verb to change it with. Both halves of
// that invariant are enforced by the compiler rather than by care:
//
//   1. Values are typed GenesisActionType, so a typo or a retired action is a
//      build error, not a runtime surprise.
//   2. Values are typed as a NON-EMPTY tuple, so a target cannot be added
//      with an empty action list.
//
// Scope note, deliberate: only targets with a real action TODAY appear here.
// Parts that exist solely for refine_storefront (hero layout, spacing, type
// scale) arrive in step 3 alongside the action itself, so the invariant above
// is true at every single commit rather than only at the end.

/** At least one action. An empty list is a compile error, not a bad row. */
type ActionsFor = readonly [GenesisActionType, ...GenesisActionType[]];

// Every reorderable section, derived from storefrontSections.ts rather than
// restated. Adding a section there adds a target here automatically, which is
// the only way these two can never drift apart. Section content is carried in
// blueprint.homepageContent, so update_homepage_content is what changes it.
// Built by reduce rather than Object.fromEntries because fromEntries widens
// the key type to string, which would silently discard the very thing this
// derivation is for: SectionKey staying the source of truth.
const SECTION_TARGETS: { [K in SectionKey]: ActionsFor } = SECTION_KEYS.reduce(
  (acc, key) => {
    acc[key] = ["update_homepage_content"];
    return acc;
  },
  {} as { [K in SectionKey]: ActionsFor }
);

// Everything that is not one of those sections. Hero is deliberately separate:
// storefrontSections.ts documents that it renders unconditionally, outside the
// reorderable list, so it is not a SectionKey and must be named explicitly.
const EXTRA_TARGETS = {
  hero: ["update_hero", "refine_storefront"],
  "hero.headline": ["update_hero"],
  "hero.subheadline": ["update_hero"],
  // Step 3 additions — targets that only became addressable once
  // refine_storefront existed to change them. Registered with the action, not
  // before it, so the "every target has a real verb" invariant held at every
  // commit in this series rather than only at the end.
  "hero.layout": ["refine_storefront"],
  "products.layout": ["refine_storefront"],
  spacing: ["refine_storefront"],
  presentation: ["refine_storefront"],
  // The order of the sections, as opposed to the content of any one of them.
  sectionOrder: ["update_section_order"],
  // Whole-theme concerns. Both currently resolve to update_theme, which is
  // exactly the bluntness step 3 exists to fix.
  palette: ["update_theme"],
  typography: ["update_theme", "refine_storefront"],
  // Store-level copy and positioning, distinct from any single section.
  storeContent: ["update_store_content"],
  storeIdentity: ["update_store_identity"],
  brandIdentity: ["update_brand_identity"],
  designDirection: ["update_design_direction"],
  seo: ["update_seo"],
} as const satisfies Record<string, ActionsFor>;

export const STOREFRONT_TARGETS = {
  ...SECTION_TARGETS,
  ...EXTRA_TARGETS,
} as const satisfies Record<string, ActionsFor>;

export type StorefrontTarget = keyof typeof STOREFRONT_TARGETS;

export const STOREFRONT_TARGET_KEYS = Object.keys(STOREFRONT_TARGETS) as StorefrontTarget[];

/**
 * Whether an arbitrary string names a real, addressable part of the
 * storefront. Every boundary that accepts a target — the model's own output,
 * a query parameter, a stored ApprovalRequest.target — goes through this
 * rather than trusting the value.
 */
export function isStorefrontTarget(value: unknown): value is StorefrontTarget {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STOREFRONT_TARGETS, value);
}

/** The actions that can genuinely change this target. Never empty, by type. */
export function actionsForTarget(target: StorefrontTarget): ActionsFor {
  return STOREFRONT_TARGETS[target];
}

/** Whether a given action can change a given target. */
export function actionCanChangeTarget(target: StorefrontTarget, actionType: GenesisActionType): boolean {
  return (actionsForTarget(target) as readonly GenesisActionType[]).includes(actionType);
}

// Owner-facing names. Section labels come from SECTION_LABELS so a section is
// never named two different things in two places; customSection is absent
// there on purpose (its real label is the store's own authored title), which
// is why it falls through to the explicit entry below.
const EXTRA_LABELS: Record<keyof typeof EXTRA_TARGETS | "customSection", string> = {
  customSection: "Custom Section",
  hero: "Hero",
  "hero.headline": "Hero headline",
  "hero.subheadline": "Hero subheadline",
  "hero.layout": "Hero layout",
  "products.layout": "Product layout",
  spacing: "Spacing",
  presentation: "Cards and buttons",
  sectionOrder: "Section order",
  palette: "Colour palette",
  typography: "Typography",
  storeContent: "Store content",
  storeIdentity: "Store identity",
  brandIdentity: "Brand identity",
  designDirection: "Design direction",
  seo: "Search listing",
};

/**
 * A human name for a target, for the approval card and for J4's own prose.
 * Falls back to the raw key rather than throwing: an unlabelled target is a
 * cosmetic gap, never a reason to fail a real proposal.
 */
export function describeTarget(target: StorefrontTarget): string {
  if (target in SECTION_LABELS) {
    return SECTION_LABELS[target as Exclude<SectionKey, "customSection">];
  }
  return EXTRA_LABELS[target as keyof typeof EXTRA_LABELS] ?? target;
}
