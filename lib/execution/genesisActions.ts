import { z } from "zod";
import { DEFAULT_THEME, type Theme } from "@/lib/theme";
import { SECTION_KEYS, resolveSectionOrder, type SectionKey } from "@/lib/storefrontSections";
import type { Executable } from "./executable";
import { updateSeoExecutable, type UpdateSeoInput } from "./executables/updateSeo";
import { updateHeroExecutable, type UpdateHeroInput } from "./executables/updateHero";
import {
  updateProductImageExecutable,
  type UpdateProductImageInput,
} from "./executables/updateProductImage";
import { updateThemeExecutable, type UpdateThemeInput } from "./executables/updateTheme";
import {
  updateBrandIdentityExecutable,
  type UpdateBrandIdentityInput,
} from "./executables/updateBrandIdentity";
import {
  updateStoreIdentityExecutable,
  type UpdateStoreIdentityInput,
} from "./executables/updateStoreIdentity";
import {
  updateHomepageContentExecutable,
  type UpdateHomepageContentInput,
} from "./executables/updateHomepageContent";
import {
  updateSectionOrderExecutable,
  type UpdateSectionOrderInput,
} from "./executables/updateSectionOrder";

// The minimal subset of Store.blueprint relevant to the actions registered
// below — shared between generateGenesisRecommendations.ts (which fetches
// it for prompt context) and this registry's getCurrentValues functions
// (which use the same fetched data to compute an ApprovalRequest's diff).
export interface BlueprintContextSubset {
  brandIdentity?: {
    brandStory?: string;
    missionStatement?: string;
    visionStatement?: string;
    brandPromise?: string;
    coreValues?: string[];
    brandPersonality?: string;
    brandVoiceAndTone?: string;
    targetAudience?: string;
    uniqueSellingProposition?: string;
  };
  homepageContent?: {
    heroHeadline?: string;
    heroSubheadline?: string;
    primaryCallToAction?: string;
    secondaryCallToAction?: string | null;
    aboutUs?: string;
    whyChooseUs?: string;
    sectionOrder?: SectionKey[];
    customSection?: { title: string; body: string } | null;
  };
  marketingAssets?: {
    seoTitle?: string;
    seoMetaDescription?: string;
  };
}

// Everything a getCurrentValues function might need to compute a diff.
// `blueprint` covers most Store-level actions; `product` covers actions
// scoped to one Product row (e.g. update_product_image); `theme` and
// `storeIdentity` cover the two Store-level concerns that live outside
// `blueprint` entirely. Every caller populates only whichever parts are
// relevant to the action(s) it's creating and leaves the rest absent.
export interface GenesisActionContext {
  blueprint: BlueprintContextSubset | null;
  product?: { id: string; name: string; imageUrl: string | null } | null;
  theme?: Theme | null;
  storeIdentity?: { name: string; tagline: string | null; description: string | null } | null;
}

// Phase 0 of the architecture-pivot roadmap (see memory:
// project_architecture_pivot_audit.md) — foundational classification only,
// not enforced anywhere yet. Every category beyond "content" exists for
// actions this registry doesn't have yet (operations/integration in
// particular were added ahead of need, deliberately, so a future action
// isn't forced into a misleading category just because this list started
// narrow), not retrofitted onto anything registered today.
export type GenesisActionCategory =
  | "content" // copy/design/homepage changes — update_hero, update_seo, update_product_image
  | "operations" // internal business workflow actions — e.g. fulfillment, inventory adjustments
  | "integration" // actions that reach an external/connected service — e.g. a payments/shipping-provider action
  | "communication" // customer- or public-facing messages — e.g. a support reply or marketing send
  | "money" // anything that moves money — e.g. a refund or pricing change
  | "destructive"; // irreversible/hard-to-undo actions — e.g. a permanent delete

// The action type's *current* default tier — can change over time as an
// action type earns trust. Contrast with ApprovalRequest.authorizationTier,
// which is a frozen snapshot of whatever tier governed one specific past
// request and never changes afterward even if this value later does (the
// same current-vs-frozen relationship input/previousValues already have to
// live Store/Product data). Only "always_ask" is real today — the other two
// values exist so a later phase can flip one without a schema change.
export type AuthorizationTier = "always_ask" | "auto_below_limit" | "auto";

// Phase 6 — how much freedom each tier represents, used only to compare
// tiers against each other (never persisted, never shown to anyone).
const AUTHORITY_TIER_RANK: Record<AuthorizationTier, number> = {
  always_ask: 0,
  auto_below_limit: 1,
  auto: 2,
};

// Phase 6 — the maximum AuthorizationTier ANY action in this category could
// ever be registered with, enforced below at module load (see the assertion
// after GENESIS_ACTIONS). These are safety boundaries, not defaults or
// grants — an individual action's own maxAuthorityTier (on
// GenesisActionDefinition) is what actually governs it, and must be <= its
// category's ceiling here. Deliberately hardcoded, not owner-configurable —
// raising a category's ceiling is a deliberate code change made when a real
// action of that kind is designed, never a runtime setting.
//   content       — auto: reversible, non-monetary, publicly correctable,
//                   already has the previousValues safety net.
//   operations    — always_ask for now: no operations actions exist yet: we
//                   don't want to pre-authorize a category before we know
//                   what those actions actually are. Raise deliberately when
//                   the first one is designed.
//   integration   — auto_below_limit: touches an external/connected
//                   account, so never fully unrestricted — reserved the
//                   same way AuthorizationTier itself reserves
//                   auto_below_limit ahead of any action having a real
//                   quantitative bound to check it against.
//   communication — auto: Genesis may eventually handle routine customer
//                   communication (follow-ups, reminders, etc.) — the
//                   category itself isn't inherently forbidden the way
//                   money/destructive are. High-risk communication actions
//                   stay always_ask via their OWN maxAuthorityTier, not by
//                   a blanket category lock.
//   money         — always_ask, hard: no action here may ever be delegated
//                   through this mechanism.
//   destructive   — always_ask, hard: same.
const CATEGORY_MAX_TIER: Record<GenesisActionCategory, AuthorizationTier> = {
  content: "auto",
  operations: "always_ask",
  integration: "auto_below_limit",
  communication: "auto",
  money: "always_ask",
  destructive: "always_ask",
};

// The plug-in point Layer 4 exists for: any Executable becomes approvable
// by Genesis just by being registered here, with zero changes to the
// Executable itself. A future third action (e.g. Instagram bio) is one
// more entry here plus one new Executable — no changes to this shape, the
// approval UI, or the execution engine.
interface GenesisActionDefinition<TInput> {
  executable: Executable<TInput, unknown>;
  // Validates the model's proposed input at generation time — defense in
  // depth, never trust the model's shape blindly even though the
  // discriminated union already constrains it at the SDK layer.
  inputSchema: z.ZodType<TInput>;
  // Computes the "current" values for the approval diff — from real
  // fetched store/product data, never from the model's own restatement of
  // what it was shown. Same shape as TInput so the approval UI can diff
  // them generically, one row per key, driven by data shape rather than
  // per-action JSX.
  getCurrentValues: (context: GenesisActionContext) => TInput;
  category: GenesisActionCategory;
  authorizationTier: AuthorizationTier;
  // Phase 6 — the maximum tier THIS SPECIFIC action could ever be granted,
  // independent of its category's ceiling (must be <= that ceiling — see
  // the assertion below). This is what actually determines delegability:
  // a category can permit "auto" while a specific high-stakes action within
  // it (e.g. update_brand_identity) still hard-locks itself to
  // "always_ask". A grant can never be created for an action whose
  // maxAuthorityTier is "always_ask" — the concept of delegation doesn't
  // exist for it, not just "defaults to off."
  maxAuthorityTier: AuthorizationTier;
}

// The zod shape mirrors ThemeSchema/CompositionSchema in
// app/dashboard/ai-actions.ts (kept in sync by hand — they describe the
// same real Theme, just from the two different sides of the approval gate:
// that file's schema is what the model must produce, this one is what an
// approved input must validate as before being written).
const ThemeInputSchema = z.object({
  colors: z.object({
    primary: z.string(),
    secondary: z.string(),
    accent: z.string(),
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    textSecondary: z.string(),
  }),
  typography: z.object({ headingFont: z.string(), bodyFont: z.string() }),
  layout: z.enum(["grid", "list", "featured"]),
  presentation: z.object({
    cardStyle: z.enum(["sharp", "rounded", "soft"]),
    buttonStyle: z.enum(["sharp", "pill", "soft"]),
    shadowStyle: z.enum(["none", "subtle", "bold"]),
    spacing: z.enum(["compact", "comfortable", "spacious"]),
  }),
  composition: z.object({
    heroLayout: z.enum(["centered", "split", "fullBleed", "minimal"]),
    typeScale: z.enum(["compact", "standard", "display"]),
    sectionLayout: z.enum(["centered", "split", "boxed"]),
    backgroundTreatment: z.enum(["flat", "tintBands", "bordered"]),
    imageTreatment: z.enum(["contained", "fullBleed", "framed"]),
    ctaEmphasis: z.enum(["button", "banner", "minimal"]),
  }),
});

export const GENESIS_ACTIONS: Record<
  string,
  GenesisActionDefinition<
    | UpdateSeoInput
    | UpdateHeroInput
    | UpdateProductImageInput
    | UpdateThemeInput
    | UpdateBrandIdentityInput
    | UpdateStoreIdentityInput
    | UpdateHomepageContentInput
    | UpdateSectionOrderInput
  >
> = {
  update_seo: {
    executable: updateSeoExecutable,
    inputSchema: z.object({ seoTitle: z.string(), seoMetaDescription: z.string() }),
    getCurrentValues: ({ blueprint }) => ({
      seoTitle: blueprint?.marketingAssets?.seoTitle ?? "",
      seoMetaDescription: blueprint?.marketingAssets?.seoMetaDescription ?? "",
    }),
    category: "content",
    authorizationTier: "always_ask",
    // Phase 6 — the first (and, for now, only) delegable action: narrow
    // blast radius, reversible via previousValues, no visible effect to an
    // already-visiting customer, and already something Genesis can
    // originate on its own via generateGenesisRecommendations.ts.
    maxAuthorityTier: "auto",
  },
  update_hero: {
    executable: updateHeroExecutable,
    inputSchema: z.object({ heroHeadline: z.string(), heroSubheadline: z.string() }),
    getCurrentValues: ({ blueprint }) => ({
      heroHeadline: blueprint?.homepageContent?.heroHeadline ?? "",
      heroSubheadline: blueprint?.homepageContent?.heroSubheadline ?? "",
    }),
    category: "content",
    authorizationTier: "always_ask",
    // Phase 6 — locked for now: the storefront's single most visible
    // element. Revisit deliberately once autonomous update_seo has proven
    // the mechanism, per Sean's explicit direction.
    maxAuthorityTier: "always_ask",
  },
  update_product_image: {
    executable: updateProductImageExecutable,
    inputSchema: z.object({ productId: z.string(), imageUrl: z.string() }),
    getCurrentValues: ({ product }) => ({
      productId: product?.id ?? "",
      imageUrl: product?.imageUrl ?? "",
    }),
    category: "content",
    authorizationTier: "always_ask",
    maxAuthorityTier: "always_ask",
  },
  update_theme: {
    executable: updateThemeExecutable,
    inputSchema: ThemeInputSchema,
    getCurrentValues: ({ theme }) => theme ?? DEFAULT_THEME,
    category: "content",
    authorizationTier: "always_ask",
    maxAuthorityTier: "always_ask",
  },
  update_brand_identity: {
    executable: updateBrandIdentityExecutable,
    inputSchema: z.object({
      brandStory: z.string(),
      missionStatement: z.string(),
      visionStatement: z.string(),
      brandPromise: z.string(),
      coreValues: z.array(z.string()),
      brandPersonality: z.string(),
      brandVoiceAndTone: z.string(),
      targetAudience: z.string(),
      uniqueSellingProposition: z.string(),
    }),
    getCurrentValues: ({ blueprint }) => ({
      brandStory: blueprint?.brandIdentity?.brandStory ?? "",
      missionStatement: blueprint?.brandIdentity?.missionStatement ?? "",
      visionStatement: blueprint?.brandIdentity?.visionStatement ?? "",
      brandPromise: blueprint?.brandIdentity?.brandPromise ?? "",
      coreValues: blueprint?.brandIdentity?.coreValues ?? [],
      brandPersonality: blueprint?.brandIdentity?.brandPersonality ?? "",
      brandVoiceAndTone: blueprint?.brandIdentity?.brandVoiceAndTone ?? "",
      targetAudience: blueprint?.brandIdentity?.targetAudience ?? "",
      uniqueSellingProposition: blueprint?.brandIdentity?.uniqueSellingProposition ?? "",
    }),
    category: "content",
    authorizationTier: "always_ask",
    // Phase 6 — hard boundary regardless of category ceiling: brand
    // identity is exactly the "always ask me before changing my brand
    // identity" case named explicitly during the Phase 6 design.
    maxAuthorityTier: "always_ask",
  },
  update_store_identity: {
    executable: updateStoreIdentityExecutable,
    inputSchema: z.object({ name: z.string(), tagline: z.string(), description: z.string() }),
    getCurrentValues: ({ storeIdentity }) => ({
      name: storeIdentity?.name ?? "",
      tagline: storeIdentity?.tagline ?? "",
      description: storeIdentity?.description ?? "",
    }),
    category: "content",
    authorizationTier: "always_ask",
    // Phase 6 — hard boundary, same reasoning as update_brand_identity.
    maxAuthorityTier: "always_ask",
  },
  update_homepage_content: {
    executable: updateHomepageContentExecutable,
    inputSchema: z.object({
      primaryCallToAction: z.string(),
      secondaryCallToAction: z.string().nullable(),
      aboutUs: z.string(),
      whyChooseUs: z.string(),
    }),
    getCurrentValues: ({ blueprint }) => ({
      primaryCallToAction: blueprint?.homepageContent?.primaryCallToAction ?? "",
      secondaryCallToAction: blueprint?.homepageContent?.secondaryCallToAction ?? null,
      aboutUs: blueprint?.homepageContent?.aboutUs ?? "",
      whyChooseUs: blueprint?.homepageContent?.whyChooseUs ?? "",
    }),
    category: "content",
    authorizationTier: "always_ask",
    maxAuthorityTier: "always_ask",
  },
  // Genesis's first structural Website action (Phase 3B) — reordering the
  // existing fixed section keys, not adding/removing/redesigning them. See
  // the Website page's stacked real-preview card (app/dashboard/website/
  // page.tsx) for how "current"/"proposed" are shown using the actual
  // storefront renderer via the previewOrder mechanism, not a mock.
  update_section_order: {
    executable: updateSectionOrderExecutable,
    inputSchema: z.object({ sectionOrder: z.array(z.enum(SECTION_KEYS)) }),
    // The *resolved* order (accounting for customSection reconciliation),
    // not the raw stored value — "current" should always match what's
    // actually live, the same principle every other getCurrentValues here
    // already follows.
    getCurrentValues: ({ blueprint }) => ({
      sectionOrder: resolveSectionOrder(blueprint?.homepageContent),
    }),
    category: "content",
    authorizationTier: "always_ask",
    maxAuthorityTier: "always_ask",
  },
};

// Phase 6 — every registered action's maxAuthorityTier must fit within its
// category's ceiling (CATEGORY_MAX_TIER above). Runs once at module load —
// a future action registered above its category's cap fails loudly at
// startup rather than silently being over-trusted.
for (const [actionType, definition] of Object.entries(GENESIS_ACTIONS)) {
  const ceiling = CATEGORY_MAX_TIER[definition.category];
  if (AUTHORITY_TIER_RANK[definition.maxAuthorityTier] > AUTHORITY_TIER_RANK[ceiling]) {
    throw new Error(
      `GENESIS_ACTIONS.${actionType}: maxAuthorityTier "${definition.maxAuthorityTier}" exceeds its category "${definition.category}"'s ceiling "${ceiling}"`
    );
  }
}

export type GenesisActionType = keyof typeof GENESIS_ACTIONS;

// Display names for the generic Current -> Proposed diff renderer in
// ApprovalRequestsPanel.tsx — driven by field key, not per-action JSX.
export const FIELD_LABELS: Record<string, string> = {
  seoTitle: "SEO Title",
  seoMetaDescription: "Meta Description",
  heroHeadline: "Hero Headline",
  heroSubheadline: "Hero Subheadline",
  imageUrl: "Product Image",
  brandStory: "Brand Story",
  missionStatement: "Mission Statement",
  visionStatement: "Vision Statement",
  brandPromise: "Brand Promise",
  coreValues: "Core Values",
  brandPersonality: "Brand Personality",
  brandVoiceAndTone: "Brand Voice & Tone",
  targetAudience: "Target Audience",
  uniqueSellingProposition: "Unique Selling Proposition",
  name: "Business Name",
  tagline: "Tagline",
  description: "Description",
  primaryCallToAction: "Primary Call to Action",
  secondaryCallToAction: "Secondary Call to Action",
  aboutUs: "About Us",
  whyChooseUs: "Why Choose Us",
};

// Which dashboard section actually owns the Approve/Reject/Regenerate
// controls for each action type — Home only ever shows a deep-linking
// summary (ApprovalsSummary.tsx), never the controls themselves. `key`
// matches a NAV_SECTIONS entry's key (lib/dashboard/navConfig.ts), so
// layout.tsx can turn a list of pending approvals straight into a
// per-nav-item badge count. A future action type needs one new entry here,
// same shape as GENESIS_ACTIONS/FIELD_LABELS above.
//
// Product Vision Phase 1 — update_brand_identity/update_store_identity now
// route to Brand (app/dashboard/brand/page.tsx), their real home — no
// longer the temporary Settings placement from earlier phases. Labeled
// "Identity" here (the user-facing word in the nav secondary-nav
// correction, lib/dashboard/navConfig.ts's YOUR_BUSINESS_SECTIONS) even
// though the key/route/file underneath stay "brand".
export const ACTION_SECTIONS: Record<string, { key: string; label: string; href: string }> = {
  update_hero: { key: "website", label: "Website", href: "/dashboard/website" },
  update_seo: { key: "marketing", label: "Marketing", href: "/dashboard/marketing" },
  update_product_image: { key: "products", label: "Products", href: "/dashboard/products" },
  update_theme: { key: "website", label: "Website", href: "/dashboard/website" },
  update_homepage_content: { key: "website", label: "Website", href: "/dashboard/website" },
  update_brand_identity: { key: "brand", label: "Identity", href: "/dashboard/brand" },
  update_store_identity: { key: "brand", label: "Identity", href: "/dashboard/brand" },
  update_section_order: { key: "website", label: "Website", href: "/dashboard/website" },
};
