import { z } from "zod";
import { readOwnerFacts } from "@/lib/businessModel/ownerFacts";
import { DEFAULT_THEME, type Theme } from "@/lib/theme";
import { SECTION_KEYS, resolveSectionOrder, type SectionKey } from "@/lib/storefrontSections";
import type { Executable } from "./executable";
import { updateSeoExecutable, type UpdateSeoInput } from "./executables/updateSeo";
import { updateHeroExecutable, type UpdateHeroInput } from "./executables/updateHero";
import {
  updateProductImageExecutable,
  type UpdateProductImageInput,
} from "./executables/updateProductImage";
import { updateBrandLogoExecutable, type UpdateBrandLogoInput } from "./executables/updateBrandLogo";
import { createProductFromDesignExecutable, type CreateProductFromDesignInput } from "./executables/productFromDesign";
import { updateThemeExecutable, type UpdateThemeInput } from "./executables/updateTheme";
import { refineStorefrontExecutable, type RefineStorefrontInput } from "./executables/refineStorefront";
import { REFINABLE_DIMENSION_KEYS, MAX_MUTATIONS_PER_IMPROVEMENT } from "@/lib/storefront/dimensions";
import { STOREFRONT_TARGET_KEYS } from "@/lib/storefront/targets";
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
import {
  createProductExecutable,
  type CreateProductInput,
  deleteProductExecutable,
  type DeleteProductInput,
  editProductExecutable,
  type EditProductInput,
} from "./executables/products";
import {
  answerSupplierEconomicsExecutable,
  type AnswerSupplierEconomicsInput,
} from "./executables/answerSupplierEconomics";

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
    // Priority 4 (asset-to-storefront, 2026-08-09) — see updateHero.ts's
    // own UpdateHeroInput comment for the full architectural reasoning.
    heroImageUrl?: string | null;
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
  /**
   * The store this is about (2026-08-24, D1-A).
   *
   * Added because four identity fields left the blueprint and became
   * owner-authoritative facts. A getCurrentValues that needs them has to read
   * them, and reading them needs a store — the blueprint alone can no longer
   * answer what the business's stated audience is.
   *
   * Optional so every existing synchronous entry is untouched; only the one
   * that needs facts asks for it.
   */
  storeId?: string;
  product?: { id: string; name: string; imageUrl: string | null; description?: string | null } | null;
  // The store's current brand logo, so a logo proposal can show what it
  // replaces. Its own field rather than part of storeIdentity: identity is the
  // written brand, this is the mark.
  brand?: { logoUrl: string | null } | null;
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
  /**
   * The values a change would replace, captured so it can be reversed.
   *
   * MAY BE ASYNC SINCE 2026-08-24 (D1-A). Four identity fields became
   * owner-authoritative facts, and a fact cannot be read synchronously out of a
   * blueprint that no longer holds it. Returning a promise is allowed rather
   * than required: every other entry in this registry is still synchronous and
   * was not touched.
   *
   * THERE IS STILL ONE REVERSAL MECHANISM. update_brand_identity's copy fields
   * reverse through previousValues as they always have; its four claims reverse
   * through fact supersession, which is the fact lifecycle's own reversal and
   * not a second one invented here. What this contract must never do is keep a
   * duplicate of those four in the blueprint merely so undo can find them.
   */
  getCurrentValues: (context: GenesisActionContext) => TInput | Promise<TInput>;
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

// Growth Points Economy (Chapter 2, VISION.md) — this registry's actionType
// strings are the real customer-facing catalog key (lib/growthPoints/
// catalog.ts), resolved in Sean's favor over lib/aiFeatures.ts's AiFeature
// strings: Growth Points represent business outcomes ("Create a Product,"
// "Improve SEO"), never internal AI-call mechanics. AiFeature/
// lib/growthCreditCatalog.ts remain the separate, internal AI-cost-
// observability axis (AiUsageEvent.growthCreditValue) — an owner never
// sees it.
export const GENESIS_ACTIONS: Record<
  string,
  GenesisActionDefinition<
    | UpdateSeoInput
    | UpdateHeroInput
    | UpdateProductImageInput
    | UpdateBrandLogoInput
    | CreateProductFromDesignInput
    | UpdateThemeInput
    | RefineStorefrontInput
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
    | CreateProductInput
    | DeleteProductInput
    | EditProductInput
    | AnswerSupplierEconomicsInput
  >
> = {
  // The owner answering J4's question about what a supplier charges (2026-08-20).
  //
  // The last link in the chain the economics layer was missing: J4 raises the
  // question as a Task (lib/sourcing/economicsQuestions.ts), this records the
  // answer, and the progression is recomputed only if something material moved.
  //
  // "operations", not "money". It moves nothing and reaches no provider — it
  // records a fact about a supplier that later informs advice. The advice can be
  // about spending thousands, which is why the tier below is what it is.
  //
  // always_ask AND LOCKED THERE, and this is the strongest lock in the registry
  // for a reason that is the opposite of every other one: the others are locked
  // because the change is too visible or too irreversible for Genesis to make
  // alone. This one is locked because Genesis CANNOT make it at all. The value
  // comes from a conversation between an owner and their supplier; anything
  // Genesis produced here would be an invented number about somebody's money,
  // and an autonomous tier would be a route for exactly that.
  answer_supplier_economics: {
    executable: answerSupplierEconomicsExecutable,
    inputSchema: z.object({
      sourceKey: z.string().min(1),
      externalProductId: z.string().min(1),
      externalVariantId: z.string().nullable().optional(),
      answer: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("quoted"),
          // Nullable, not optional-with-a-default. An owner who came back with
          // one of the two answers has found out something real, and the schema
          // has to be able to carry a half-answer without inventing the half
          // that is missing.
          minimumOrderUnits: z.number().int().positive().nullable().optional(),
          bulkUnitCostInCents: z.number().int().nonnegative().nullable().optional(),
          shippingPerUnitInCents: z.number().int().nonnegative().nullable().optional(),
          leadTimeDays: z.number().int().nonnegative().nullable().optional(),
          note: z.string().nullable().optional(),
        }),
        z.object({ kind: z.literal("supplier_would_not_say"), note: z.string().nullable().optional() }),
        z.object({ kind: z.literal("dont_know_yet"), note: z.string().nullable().optional() }),
      ]),
    }),
    // There is no "current value" to diff against, and that is not an omission.
    // The whole premise is that nothing is known — a diff would be rendering the
    // absence of a fact as though it were a previous one.
    getCurrentValues: () => ({
      sourceKey: "",
      externalProductId: "",
      externalVariantId: null,
      answer: { kind: "dont_know_yet" as const },
    }),
    category: "operations",
    authorizationTier: "always_ask",
    maxAuthorityTier: "always_ask",
  },
  update_seo: {
    executable: updateSeoExecutable,
    inputSchema: z.object({ seoTitle: z.string(), seoMetaDescription: z.string() }),
    getCurrentValues: ({ blueprint }) => ({
      seoTitle: blueprint?.marketingAssets?.seoTitle ?? "",
      seoMetaDescription: blueprint?.marketingAssets?.seoMetaDescription ?? "",
    }),
    category: "content",
    // BUSINESS_ASSETS_ARCHITECTURE.md M3 — promoted from "always_ask" to
    // "auto", the real trust-earning step this action's own Phase 6 comment
    // below already anticipated ("the first... delegable action"), and
    // Sean's own explicit example of what should auto-execute ("fixing SEO
    // metadata") once authorized. Action-specific, not a category change —
    // every other content action stays exactly as it was; this promotion
    // rests on update_seo's own real properties (narrow blast radius,
    // reversible, invisible to an already-visiting customer), not a
    // blanket trust grant to its category.
    authorizationTier: "auto",
    // Phase 6 — the first (and, for now, only) delegable action: narrow
    // blast radius, reversible via previousValues, no visible effect to an
    // already-visiting customer, and already something Genesis can
    // originate on its own via generateGenesisRecommendations.ts.
    maxAuthorityTier: "auto",
  },
  update_hero: {
    executable: updateHeroExecutable,
    inputSchema: z.object({
      heroHeadline: z.string(),
      heroSubheadline: z.string(),
      heroImageUrl: z.string().nullable().optional(),
    }),
    getCurrentValues: ({ blueprint }) => ({
      heroHeadline: blueprint?.homepageContent?.heroHeadline ?? "",
      heroSubheadline: blueprint?.homepageContent?.heroSubheadline ?? "",
      heroImageUrl: blueprint?.homepageContent?.heroImageUrl ?? null,
    }),
    category: "content",
    authorizationTier: "always_ask",
    // Phase 6 — locked for now: the storefront's single most visible
    // element. Revisit deliberately once autonomous update_seo has proven
    // the mechanism, per Sean's explicit direction.
    maxAuthorityTier: "always_ask",
  },
  // The brand logo, as a real conversational capability (2026-08-16).
  //
  // Distinct from update_store_identity, which is the WRITTEN identity. This
  // one produces a file and designates it as the brand.logo Asset — the first
  // link of Asset -> Design -> Product (see WORK_STUDIO.md).
  //
  // always_ask: a logo is the most visible thing a business owns, and the
  // confirmation ladder applies at its strongest. The owner sees it before it
  // becomes theirs.
  update_brand_logo: {
    executable: updateBrandLogoExecutable,
    inputSchema: z.object({
      imageUrl: z.string(),
      generationPrompt: z.string().optional(),
      aiUsageEventId: z.string().optional(),
    }),
    getCurrentValues: ({ brand }) => ({
      imageUrl: brand?.logoUrl ?? "",
    }),
    category: "content",
    authorizationTier: "always_ask",
    maxAuthorityTier: "always_ask",
  },
  // Approving a Studio creation into a real, sellable product (2026-08-17).
  //
  // always_ask, and this is the strongest case for it in the registry: the
  // owner is putting something in their shop window at a price. The
  // confirmation ladder's rule that a visual change must be seen before it is
  // agreed to applies literally — they approve the mockup they are looking at.
  create_product_from_design: {
    executable: createProductFromDesignExecutable,
    inputSchema: z.object({
      designId: z.string(),
      name: z.string(),
      priceInCents: z.number().int().positive(),
      description: z.string().optional(),
    }),
    // Nothing is being replaced — this creates a product that did not exist,
    // so there is no "current" value to diff against.
    getCurrentValues: () => ({ designId: "", name: "", priceInCents: 0 }),
    category: "content",
    authorizationTier: "always_ask",
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
  // "J4 is already giving good recommendations about the products. But
  // right now it is saying things like 'you paste the winners into each
  // product's name field.' I do not want that... if J4 can perform the
  // change, J4 should perform the change after I approve it" (Sean,
  // 2026-08-09) — the same real gap the delete_product entry above
  // documents its own discovery of, one milestone later: editProductExecutable
  // already existed, wired only to the owner's own manual Edit form. This
  // registers it for Genesis the same way, no new execution machinery.
  // name/description both optional in the schema — a real proposal only
  // ever carries the field(s) it's actually changing (see
  // request_product_content_change, app/api/chat/route.ts), so the diff
  // shown to the owner never pads in an unrelated unchanged field.
  update_product: {
    executable: editProductExecutable,
    inputSchema: z.object({
      productId: z.string(),
      name: z.string().optional(),
      description: z.string().nullable().optional(),
    }),
    getCurrentValues: ({ product }) => ({
      productId: product?.id ?? "",
      name: product?.name ?? "",
      description: product?.description ?? null,
    }),
    category: "content",
    authorizationTier: "always_ask",
    maxAuthorityTier: "always_ask",
  },
  // Meeting with J4 M2 — the first CREATE-shaped action in this registry;
  // every entry above only ever edits something that already exists.
  // createProductExecutable (executables/products.ts) already existed,
  // wired only to the owner's own manual "Add product" form — this just
  // makes it something Genesis can propose too. getCurrentValues has no
  // real "current" product to diff against for a create, so it returns an
  // honest empty baseline; the existing generic diff rendering already
  // handles that per field, no special-casing needed.
  create_product: {
    executable: createProductExecutable,
    inputSchema: z.object({
      name: z.string(),
      description: z.string().nullable(),
      priceInCents: z.number().int(),
    }),
    getCurrentValues: () => ({ name: "", description: null, priceInCents: 0 }),
    category: "content",
    authorizationTier: "always_ask",
    maxAuthorityTier: "always_ask",
  },
  // 2026-08-08 — the missing capability a real owner (Sean's own store,
  // via J4) hit directly: J4 could talk about removing obsolete products
  // but had no real way to do it, and kept telling the owner to go delete
  // each one by hand. deleteProductExecutable already existed, wired only
  // to the owner's own manual dashboard delete button — this registers it
  // for Genesis the same way create_product registered
  // createProductExecutable, no new execution machinery. category is
  // "destructive" specifically so CATEGORY_MAX_TIER's hard "always_ask"
  // ceiling applies here by construction — a real, permanent Product
  // delete must never become delegable, unlike update_seo.
  delete_product: {
    executable: deleteProductExecutable,
    inputSchema: z.object({ productId: z.string(), name: z.string() }),
    getCurrentValues: ({ product }) => ({
      productId: product?.id ?? "",
      name: product?.name ?? "",
    }),
    category: "destructive",
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
  // Storefront Canvas, step 3 of 6 (2026-08-12) — the finer-grained twin of
  // update_theme above. Same enum vocabulary, same hand-built variants, but
  // one improvement at a time with a required reason, rather than replacing
  // the whole theme. See lib/execution/executables/refineStorefront.ts for
  // why one approval is one charge regardless of how many mutations it took.
  refine_storefront: {
    executable: refineStorefrontExecutable,
    inputSchema: z.object({
      // Both vocabularies are closed at the schema boundary, so an invalid
      // target or dimension is rejected before it ever reaches an executable.
      target: z.enum(STOREFRONT_TARGET_KEYS as [string, ...string[]]),
      changes: z
        .array(
          z.object({
            dimension: z.enum(REFINABLE_DIMENSION_KEYS as [string, ...string[]]),
            value: z.string(),
          })
        )
        .min(1)
        .max(MAX_MUTATIONS_PER_IMPROVEMENT),
      // Required, and required for a reason: an improvement without one is a
      // redesign with better manners. Enforced by the schema rather than
      // requested in a prompt.
      reason: z.string().min(1),
      summary: z.string().min(1),
    }),
    // The store's real current theme, never the model's restatement of it —
    // same source update_theme uses, so both actions diff against identical
    // ground truth. Returning the whole Theme rather than just the changed
    // dimensions keeps this inside the registry's own input union; presenting
    // that diff more narrowly on the approval card is a UI concern for a
    // later step, not a reason to weaken the type here.
    getCurrentValues: ({ theme }) => theme ?? DEFAULT_THEME,
    category: "content",
    // Always ask, and deliberately capped there. This changes how the
    // storefront looks; it is exactly the kind of thing an owner should see
    // before it happens, no matter how much delegated authority J4 earns.
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
    // COPY FROM THE BLUEPRINT, CLAIMS FROM THE FACTS (2026-08-24, D1-A).
    //
    // The two halves reverse by their own mechanisms. brandStory and the rest
    // of the narrative are captured here and restored from previousValues, as
    // they always were. The four claims are read from the fact lifecycle so the
    // diff an owner approves shows what is actually current — and reversing
    // them is a further owner statement that supersedes, which preserves
    // history rather than overwriting it.
    getCurrentValues: async ({ blueprint, storeId }) => {
      // LOUD, NOT EMPTY. Falling back to nulls here would hand back "" for four
      // fields the owner has real answers for, and reversing that proposal would
      // erase them — a caller forgetting the store would look like an owner with
      // no stated audience. A missing store is a wiring mistake, so it says so.
      if (!storeId) {
        throw new Error(
          "update_brand_identity.getCurrentValues needs context.storeId: the four " +
            "identity claims are facts, not blueprint fields, and cannot be read without a store."
        );
      }
      const claims = await readOwnerFacts(storeId);
      return {
        brandStory: blueprint?.brandIdentity?.brandStory ?? "",
        missionStatement: blueprint?.brandIdentity?.missionStatement ?? "",
        visionStatement: blueprint?.brandIdentity?.visionStatement ?? "",
        brandPromise: blueprint?.brandIdentity?.brandPromise ?? "",
        coreValues: blueprint?.brandIdentity?.coreValues ?? [],
        brandPersonality: claims.brandPersonality ?? "",
        brandVoiceAndTone: claims.brandVoice ?? "",
        targetAudience: claims.targetAudience ?? "",
        uniqueSellingProposition: claims.sellingProposition ?? "",
      };
    },
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
      kind: z.enum(["insight", "prediction", "explanation", "recommendation", "opportunity", "briefing"]),
      summary: z.string(),
      data: z.record(z.string(), z.unknown()).nullable().optional(),
      priority: z.enum(["high", "medium", "low"]).nullable().optional(),
      confidence: z.number().min(0).max(1).nullable().optional(),
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

// Meeting with J4 M7 — moved to lib/execution/fieldLabels.ts (a small,
// client-safe module with no server-only imports), re-exported here for
// every existing importer. See that file's own comment for why.
export { FIELD_LABELS } from "./fieldLabels";

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
//
// RE-KEYED TO THE ROOMS, 2026-08-22 (decision 5 of the locked room
// architecture). The rule, in Sean's words: "J4 must never describe a change in
// terms of a place the owner cannot actually see." Four entries said "Website",
// a word that has not been on the room bar since 2026-08-15 — the section is
// called Storefront, so that is what J4 says. scripts/verify-action-sections.ts
// now asserts it against navConfig rather than trusting this comment.
//
// WHAT DELIBERATELY DID NOT MOVE, and why, because both were proposed and both
// turned out to be wrong against what this map actually means. Its subject is
// the first line above — which section OWNS the Approve/Reject/Regenerate
// controls — not which room a concept belongs to:
//
//   update_seo stays on Marketing. The design proposal argued it belongs in
//   Storefront ("the search listing is how the business looks to someone who
//   has not arrived yet"), which is true about the concept and false about the
//   controls: app/dashboard/marketing/page.tsx is what renders the SEO
//   approvals, its DelegatedAuthority grant, and the revert affordances for
//   already-executed ones. Re-keying it would have deep-linked owners to a page
//   with none of that on it. Marketing is a real, visible destination, so the
//   naming rule is satisfied where it stands.
//
//   update_goal_status / resolve_challenge stay on the arrival screen. Moving
//   them to the Office was proposed on the strength of Understanding existing
//   there now, but the Office is an overlay with no route of its own, so `href`
//   would have had nowhere to point — and their controls genuinely are on
//   arrival (RecommendationsPanel). The arrival screen has no owner-visible
//   label in the room model, which is why "Home" survives here as a named
//   exception in the verification suite rather than being quietly renamed to
//   something equally invisible.
export const ACTION_SECTIONS: Record<string, { key: string; label: string; href: string }> = {
  update_hero: { key: "website", label: "Storefront", href: "/dashboard/website" },
  // THE NEXT TWO WERE MISSING ENTIRELY until 2026-08-22, found by the suite
  // rather than by reading. Both are authorizationTier "always_ask", so both
  // genuinely produce ApprovalRequests an owner has to decide — and every
  // consumer of this map degrades silently when the lookup misses: no nav badge
  // (BusinessWorkspace skips a falsy key), no focusable approval
  // (focusableApprovals drops it), and an attention card with no Review link at
  // all (reviewHref falls back to null). A pending storefront refinement — one
  // of J4's most visible capabilities — arrived with no way to navigate to it.
  refine_storefront: { key: "website", label: "Storefront", href: "/dashboard/website" },
  // Supplier economics is answered through J4's own card rather than on a page,
  // so this names where the owner SEES the result: the catalog renders each
  // item's economics, and it is a real section of Commerce. Deliberately not
  // Products — "what you could sell" and "what you do sell" are different
  // shelves, and folding one into the other would make a supplier quote look
  // like inventory.
  answer_supplier_economics: { key: "catalog", label: "What you could sell", href: "/dashboard/catalog" },
  update_seo: { key: "marketing", label: "Marketing", href: "/dashboard/marketing" },
  update_brand_logo: { key: "brand", label: "Identity", href: "/dashboard/brand" },
  create_product_from_design: { key: "products", label: "Products", href: "/dashboard/products" },
  update_product_image: { key: "products", label: "Products", href: "/dashboard/products" },
  update_product: { key: "products", label: "Products", href: "/dashboard/products" },
  create_product: { key: "products", label: "Products", href: "/dashboard/products" },
  delete_product: { key: "products", label: "Products", href: "/dashboard/products" },
  update_theme: { key: "website", label: "Storefront", href: "/dashboard/website" },
  update_homepage_content: { key: "website", label: "Storefront", href: "/dashboard/website" },
  update_brand_identity: { key: "brand", label: "Identity", href: "/dashboard/brand" },
  update_store_identity: { key: "brand", label: "Identity", href: "/dashboard/brand" },
  update_section_order: { key: "website", label: "Storefront", href: "/dashboard/website" },
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
