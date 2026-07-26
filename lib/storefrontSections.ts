// The one canonical definition of the storefront's fixed vocabulary of
// reorderable homepage sections — previously duplicated independently in
// app/dashboard/ai-actions.ts (a runtime array, for the chat schema) and
// app/store/[slug]/shared.tsx (a type union, for the renderer). Both now
// derive from this file instead of maintaining their own copy.
//
// Hero is deliberately NOT one of these keys — it's rendered unconditionally
// first by app/store/[slug]/page.tsx's renderHero(), outside this list, and
// isn't reorderable today. "products" must always appear somewhere; the
// rest are optional. "customSection" is one flexible slot for
// industry-specific narrative content (a coffee shop's "Brewing
// Philosophy," a gym's "Results") so each vertical doesn't need its own
// bespoke schema field.
export const SECTION_KEYS = [
  "about",
  "whyChooseUs",
  "featuredCollections",
  "products",
  "brandStory",
  "faq",
  "newsletter",
  "customSection",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

// Human-readable labels for display (e.g. the section-reorder proposal's
// before/after summary) — "customSection" is deliberately absent here since
// its real label is the store's own authored title, not a static string;
// callers fall back to "Custom Section" only when that title is missing.
export const SECTION_LABELS: Record<Exclude<SectionKey, "customSection">, string> = {
  about: "About",
  whyChooseUs: "Why Choose Us",
  featuredCollections: "Featured Collections",
  products: "Products",
  brandStory: "Our Story",
  faq: "FAQ",
  newsletter: "Newsletter",
};

// Matches the storefront's original fixed order — used for stores/drafts
// generated before sectionOrder existed, so nothing changes for them.
const DEFAULT_SECTION_ORDER: SectionKey[] = [
  "about",
  "whyChooseUs",
  "featuredCollections",
  "products",
  "faq",
  "newsletter",
];

// The minimal shape reconcileCustomSection/resolveSectionOrder need from a
// store's homepage content — kept narrow (not the full HomepageContent
// type) so this file has no dependency on app/store/[slug]/shared.tsx,
// which itself re-exports from here. A full-shape dependency would be
// circular.
interface HomepageSectionContext {
  customSection?: { title: string; body: string } | null;
}

// The model doesn't always keep customSection and sectionOrder consistent
// with each other (verified directly against the API — it sometimes writes
// real customSection content but forgets to list "customSection" in the
// order). Rather than lose that content, reconcile it here: if content
// exists, make sure it's positioned; if it doesn't, make sure the key isn't
// referenced. This is a hard invariant enforced in code, not left to the
// model to get right every time. Extracted as its own function so a
// *proposed* order (not just the stored one) can go through the same
// reconciliation — see the section-reorder preview in
// app/store/[slug]/page.tsx.
export function reconcileCustomSection(
  order: SectionKey[],
  homepage: HomepageSectionContext | undefined
): SectionKey[] {
  const result = [...order];
  if (homepage?.customSection && !result.includes("customSection")) {
    result.push("customSection");
  }
  if (!homepage?.customSection) {
    return result.filter((key) => key !== "customSection");
  }
  return result;
}

export function resolveSectionOrder(
  homepage: (HomepageSectionContext & { sectionOrder?: SectionKey[] }) | undefined
): SectionKey[] {
  if (!homepage) return DEFAULT_SECTION_ORDER;
  const order = homepage.sectionOrder?.length ? [...homepage.sectionOrder] : [...DEFAULT_SECTION_ORDER];
  return reconcileCustomSection(order, homepage);
}
