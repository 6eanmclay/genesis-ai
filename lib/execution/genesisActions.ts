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
import {
  updateStoreContentExecutable,
  type UpdateStoreContentInput,
} from "./executables/updateStoreContent";
import {
  updateDesignDirectionExecutable,
  type UpdateDesignDirectionInput,
} from "./executables/updateDesignDirection";
import {
  updateMarketingAssetsExecutable,
  type UpdateMarketingAssetsInput,
} from "./executables/updateMarketingAssets";
import {
  updateGoalStatusExecutable,
  type UpdateGoalStatusInput,
} from "./executables/updateGoalStatus";
import {
  resolveChallengeExecutable,
  type ResolveChallengeInput,
} from "./executables/resolveChallenge";
import {
  communicateFindingExecutable,
  type CommunicateFindingInput,
} from "./executables/communicateFinding";

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
    featuredCollections?: string[];
    faq?: { question: string; answer: string }[];
    newsletterSection?: string;
    footerContent?: string;
  };
  marketingAssets?: {
    seoTitle?: string;
    seoMetaDescription?: string;
    brandKeywords?: string[];
    instagramBio?: string;
    facebookDescription?: string;
    xBio?: string;
  };
  storeContent?: {
    shippingPolicy?: string;
    returnPolicy?: string;
    privacyPolicy?: string;
    termsAndConditions?: string;
    contactPageCopy?: string;
  };
  designDirection?: {
    visualStyle?: string;
    brandMood?: string;
    photographyStyle?: string;
    iconStyle?: string;
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
  // Phase 3 Milestone 6 — same "one context field per record-scoped action
  // kind" pattern `product` above already established, generalized to any
  // BusinessRecord (a Goal, a Challenge, ...) instead of a second
  // product-shaped field per new entity type.
  businessRecord?: { id: string; entityType: string; data: unknown } | null;
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
//   operations    — Phase 3 Milestone 6 — raised to "auto" deliberately, the
//                   exact moment this comment always anticipated: the first
//                   real operations actions (goal.update_status,
//                   challenge.resolve) are Genesis's own internal
//                   understanding, zero customer-facing risk, and exist
//                   specifically to prove the autonomy ladder generalizes
//                   past storefront content, not just to skip ceremony.
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
  operations: "auto",
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
  // J4 Foundation Phase 1 (Execute Hardening) — true ONLY for a mechanic
  // whose run() has zero effect beyond recording what's being communicated
  // to the owner (see communicateFinding.ts). Lets execute() skip the
  // DelegatedAuthority grant lookup entirely for this specific action,
  // narrowly, because nothing about the business changes and there is
  // nothing to authorize. Enforced at module load below: this may only be
  // true for maxAuthorityTier "auto" in category "communication" — never
  // set this on an action that changes business state, reaches an external
  // system, or otherwise has any effect beyond this one record write.
  authorityExempt?: boolean;
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
    | UpdateStoreContentInput
    | UpdateDesignDirectionInput
    | UpdateMarketingAssetsInput
    | UpdateGoalStatusInput
    | ResolveChallengeInput
    | CommunicateFindingInput
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
    inputSchema: z.object({
      productId: z.string(),
      imageUrl: z.string(),
      generationPrompt: z.string().optional(),
    }),
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
      // Phase 2 Milestone 1 — the structured fields deferred since the
      // original pivot's Phase 1 (arrays/nested objects, no diff UI existed
      // for them yet). Kept on this same action rather than a second
      // homepage-content type: they're conceptually the same field group,
      // just the harder-to-diff half.
      featuredCollections: z.array(z.string()),
      faq: z.array(z.object({ question: z.string(), answer: z.string() })),
      newsletterSection: z.string(),
      footerContent: z.string(),
      customSection: z.object({ title: z.string(), body: z.string() }).nullable(),
    }),
    getCurrentValues: ({ blueprint }) => ({
      primaryCallToAction: blueprint?.homepageContent?.primaryCallToAction ?? "",
      secondaryCallToAction: blueprint?.homepageContent?.secondaryCallToAction ?? null,
      aboutUs: blueprint?.homepageContent?.aboutUs ?? "",
      whyChooseUs: blueprint?.homepageContent?.whyChooseUs ?? "",
      featuredCollections: blueprint?.homepageContent?.featuredCollections ?? [],
      faq: blueprint?.homepageContent?.faq ?? [],
      newsletterSection: blueprint?.homepageContent?.newsletterSection ?? "",
      footerContent: blueprint?.homepageContent?.footerContent ?? "",
      customSection: blueprint?.homepageContent?.customSection ?? null,
    }),
    category: "content",
    authorizationTier: "always_ask",
    maxAuthorityTier: "always_ask",
  },
  update_store_content: {
    executable: updateStoreContentExecutable,
    inputSchema: z.object({
      shippingPolicy: z.string(),
      returnPolicy: z.string(),
      privacyPolicy: z.string(),
      termsAndConditions: z.string(),
      contactPageCopy: z.string(),
    }),
    getCurrentValues: ({ blueprint }) => ({
      shippingPolicy: blueprint?.storeContent?.shippingPolicy ?? "",
      returnPolicy: blueprint?.storeContent?.returnPolicy ?? "",
      privacyPolicy: blueprint?.storeContent?.privacyPolicy ?? "",
      termsAndConditions: blueprint?.storeContent?.termsAndConditions ?? "",
      contactPageCopy: blueprint?.storeContent?.contactPageCopy ?? "",
    }),
    category: "content",
    authorizationTier: "always_ask",
    maxAuthorityTier: "always_ask",
  },
  update_design_direction: {
    executable: updateDesignDirectionExecutable,
    inputSchema: z.object({
      visualStyle: z.string(),
      brandMood: z.string(),
      photographyStyle: z.string(),
      iconStyle: z.string(),
    }),
    getCurrentValues: ({ blueprint }) => ({
      visualStyle: blueprint?.designDirection?.visualStyle ?? "",
      brandMood: blueprint?.designDirection?.brandMood ?? "",
      photographyStyle: blueprint?.designDirection?.photographyStyle ?? "",
      iconStyle: blueprint?.designDirection?.iconStyle ?? "",
    }),
    category: "content",
    authorizationTier: "always_ask",
    maxAuthorityTier: "always_ask",
  },
  update_marketing_assets: {
    executable: updateMarketingAssetsExecutable,
    inputSchema: z.object({
      brandKeywords: z.array(z.string()),
      instagramBio: z.string(),
      facebookDescription: z.string(),
      xBio: z.string(),
    }),
    getCurrentValues: ({ blueprint }) => ({
      brandKeywords: blueprint?.marketingAssets?.brandKeywords ?? [],
      instagramBio: blueprint?.marketingAssets?.instagramBio ?? "",
      facebookDescription: blueprint?.marketingAssets?.facebookDescription ?? "",
      xBio: blueprint?.marketingAssets?.xBio ?? "",
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
  // Phase 3 Milestone 6 (J4 Cognitive Layer) — the first two "operations"
  // actions, both record-scoped (not blueprint-scoped) via the new
  // businessRecord context field above. Both auto-delegable from day one —
  // Genesis's own internal understanding, zero customer-facing risk, the
  // deliberate first real test of whether the autonomy ladder generalizes
  // past storefront content.
  update_goal_status: {
    executable: updateGoalStatusExecutable,
    inputSchema: z.object({
      goalRecordId: z.string(),
      status: z.enum(["active", "achieved", "abandoned"]),
    }),
    getCurrentValues: ({ businessRecord }) => ({
      goalRecordId: businessRecord?.id ?? "",
      status:
        (businessRecord?.data as { status?: "active" | "achieved" | "abandoned" } | undefined)
          ?.status ?? "active",
    }),
    category: "operations",
    authorizationTier: "always_ask",
    maxAuthorityTier: "auto",
  },
  resolve_challenge: {
    executable: resolveChallengeExecutable,
    inputSchema: z.object({ challengeRecordId: z.string() }),
    getCurrentValues: ({ businessRecord }) => ({
      challengeRecordId: businessRecord?.id ?? "",
    }),
    category: "operations",
    authorizationTier: "always_ask",
    maxAuthorityTier: "auto",
  },
  // J4 Foundation Phase 1 (Execute Hardening) — the first "communication"-
  // category action, and the only one marked authorityExempt (see that
  // field's own comment above). getCurrentValues has no real "current" to
  // report — a communicated finding is purely additive, never a change to
  // an existing value — so it returns the input unchanged, matching the
  // input schema exactly (this action is never shown through the
  // current/proposed diff UI; getCurrentValues exists only because the
  // registry's shape requires it).
  communicate_finding: {
    executable: communicateFindingExecutable,
    inputSchema: z.object({
      kind: z.enum(["insight", "prediction", "explanation", "recommendation", "opportunity"]),
      summary: z.string(),
      data: z.record(z.string(), z.unknown()).nullable().optional(),
      priority: z.enum(["high", "medium", "low"]).nullable().optional(),
      actionLabel: z.string().nullable().optional(),
      actionHref: z.string().nullable().optional(),
      recordId: z.string().nullable().optional(),
      entityType: z.string().nullable().optional(),
      topicKey: z.string().nullable().optional(),
      proposedAction: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
    // Never actually invoked in practice — communicateFinding() (see
    // genesisAutonomy.ts) never creates an ApprovalRequest for this action
    // (there is no decision to diff, only an additive record), so nothing
    // ever calls getCurrentValues for it. Present only because the registry
    // shape requires every entry to have one.
    getCurrentValues: (): CommunicateFindingInput => ({ kind: "insight", summary: "" }),
    category: "communication",
    authorizationTier: "auto",
    maxAuthorityTier: "auto",
    authorityExempt: true,
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
  // J4 Foundation Phase 1 — authorityExempt is a narrow, deliberate carve-out
  // (see its own doc comment above), not a blanket property of a category.
  // Enforced here, not just documented, so a future action can't silently
  // inherit the exemption by being registered under "communication" or
  // "auto" alone.
  if (definition.authorityExempt && (definition.category !== "communication" || definition.maxAuthorityTier !== "auto")) {
    throw new Error(
      `GENESIS_ACTIONS.${actionType}: authorityExempt is only valid for category "communication" with maxAuthorityTier "auto"`
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
  featuredCollections: "Featured Collections",
  faq: "FAQ",
  newsletterSection: "Newsletter",
  footerContent: "Footer",
  customSectionTitle: "Custom Section Title",
  customSectionBody: "Custom Section Body",
  shippingPolicy: "Shipping Policy",
  returnPolicy: "Return Policy",
  privacyPolicy: "Privacy Policy",
  termsAndConditions: "Terms & Conditions",
  contactPageCopy: "Contact Page",
  visualStyle: "Visual Style",
  brandMood: "Brand Mood",
  photographyStyle: "Photography Style",
  iconStyle: "Icon Style",
  brandKeywords: "Brand Keywords",
  instagramBio: "Instagram Bio",
  facebookDescription: "Facebook Description",
  xBio: "X (Twitter) Bio",
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
  // Phase 2 Milestone 1 — Settings was genuinely empty before this ("nothing
  // to configure here yet"); store policies and design direction are
  // business-configuration content, not creative identity (Brand) or
  // storefront-visual content (Website), so they land here.
  update_store_content: { key: "settings", label: "Settings", href: "/dashboard/settings" },
  update_design_direction: { key: "settings", label: "Settings", href: "/dashboard/settings" },
  update_marketing_assets: { key: "marketing", label: "Marketing", href: "/dashboard/marketing" },
  // Phase 3 Milestone 6 — no dedicated Goals/Challenges page exists yet, so
  // these route to Home, where the Cognitive Layer's own recommendation/
  // opportunity output already surfaces (see RecommendationsPanel) — a
  // real, honest landing spot, not a placeholder page invented for this.
  update_goal_status: { key: "home", label: "Home", href: "/dashboard" },
  resolve_challenge: { key: "home", label: "Home", href: "/dashboard" },
  // J4 Foundation Phase 1 — never actually surfaced through this map in
  // practice (no ApprovalRequest is created for a communicated finding),
  // present only for completeness/type-safety alongside every other entry.
  communicate_finding: { key: "home", label: "Home", href: "/dashboard" },
};
