"use server";

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { randomUUID } from "crypto";
import { z } from "zod";
import { redirect, unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
// Aliased — this file already has a local `const after: StoreState` inside
// applyGenesisMessageToStore, which would otherwise shadow this import.
import { after as scheduleAfterResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/slugify";
import { sourceHeroImageCandidate } from "@/lib/productImagery";
import { resolveProductImage } from "@/lib/imageProviders/resolveProductImage";
import { PERMISSIONS, hasPermission, requireStorePermission, resolveUserStore } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { recordGenesisExecution } from "@/lib/execution/genesis";
import {
  getRecommendationExplanation,
  type RecommendationExplanation,
} from "@/lib/dashboard/explainRecommendation";
import { runCognitiveReview } from "@/lib/intelligence/cognitiveLayer";
import { runDeterministicObservationSweep } from "@/lib/dashboard/genesisObservations";
import { measureDueMeasurements } from "@/lib/dashboard/postExecutionMeasurement";
import { GENESIS_ACTIONS, type GenesisActionContext } from "@/lib/execution/genesisActions";
import { supersedePendingApproval } from "@/lib/dashboard/pendingApprovals";
import { SECTION_KEYS } from "@/lib/storefrontSections";
import {
  BUSINESS_SUBCATEGORY_SLUGS,
  filterKnownBusinessCategories,
  REVENUE_STREAM_SLUGS,
  filterKnownRevenueStreams,
} from "@/lib/businessTaxonomy";
import { execute } from "@/lib/execution/engine";
import { logProductEvent, findLikelyRephraseOf } from "@/lib/telemetry/events";
import {
  callGenesisModel,
  genesisModelFailureMessage,
  type GenesisModelErrorKind,
} from "@/lib/genesisModel";
import { RecoverableError, toActionState, type ActionState } from "@/lib/actionState";
import { buildChatDataContext } from "@/lib/businessModel/reasoning";
import { getBusinessProfile } from "@/lib/businessModel/profile";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { ENTITY_REGISTRY } from "@/lib/businessModel/entities";
import { upsertObservation, resolveMissingObservations } from "@/lib/dashboard/genesisObservations";

const PROMPT_VERSION = "v2";

// The full brand blueprint schema is too large for the API's structured
// output grammar compiler to handle in one call ("compiled grammar is too
// large" error), so generation and chat updates are split into two
// coordinated calls: PRIMARY (identity-defining — name, theme, products,
// brand identity, homepage) and SECONDARY (policies, marketing, design
// direction), with SECONDARY given PRIMARY's output as context so the
// result still reads as one coherent brand.

const ThemeSchema = z.object({
  colors: z.object({
    primary: z.string(),
    secondary: z.string(),
    accent: z.string(),
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    textSecondary: z.string(),
  }),
  typography: z.object({
    headingFont: z.string(),
    bodyFont: z.string(),
  }),
  layout: z.enum(["grid", "list", "featured"]),
  // Structured, storefront-safe presentation choices — deliberately a fixed
  // enum (not free-form CSS) so brand personality can drive real visual
  // structure (corners, shadows, density) without risking broken or unsafe
  // output. Only applied to the public storefront, never the dashboard.
  presentation: z.object({
    cardStyle: z.enum(["sharp", "rounded", "soft"]),
    buttonStyle: z.enum(["sharp", "pill", "soft"]),
    shadowStyle: z.enum(["none", "subtle", "bold"]),
    spacing: z.enum(["compact", "comfortable", "spacious"]),
  }),
});

// Structural/compositional choices — distinct from `presentation` above
// (which is uniform low-level styling: radius, shadow, spacing). This is
// what actually varies the page's shape per brand: hero structure, heading
// scale, section internal layout, backgrounds, image framing, and CTA
// composition. Still a fixed enum mapped to hand-built, tested variants —
// never free-form CSS from the model.
//
// Deliberately NOT nested inside ThemeSchema/PrimaryBlueprintSchema —
// confirmed empirically that adding it there reproduces the exact
// "compiled grammar is too large" error PrimaryBlueprintSchema was already
// at the ceiling for (see the comment at the top of this file). Generated
// by its own dedicated call instead (mirroring the PRIMARY/SECONDARY
// split), then merged into `theme.composition` in code after generation.
const CompositionSchema = z.object({
  heroLayout: z.enum(["centered", "split", "fullBleed", "minimal"]),
  typeScale: z.enum(["compact", "standard", "display"]),
  sectionLayout: z.enum(["centered", "split", "boxed"]),
  backgroundTreatment: z.enum(["flat", "tintBands", "bordered"]),
  imageTreatment: z.enum(["contained", "fullBleed", "framed"]),
  ctaEmphasis: z.enum(["button", "banner", "minimal"]),
});

const BrandIdentitySchema = z.object({
  brandStory: z.string(),
  missionStatement: z.string(),
  visionStatement: z.string(),
  // Distinct from mission/vision (which are internal/introspective): a
  // short, consistent statement of what customers can always count on.
  // Rendered prominently on the storefront, not just folded into copy.
  brandPromise: z.string(),
  coreValues: z.array(z.string()),
  brandPersonality: z.string(),
  brandVoiceAndTone: z.string(),
  targetAudience: z.string(),
  uniqueSellingProposition: z.string(),
});

const FaqItemSchema = z.object({
  question: z.string(),
  answer: z.string(),
});

// SECTION_KEYS is the canonical vocabulary of homepage sections Genesis can
// arrange (hero is always first, footer always last — not part of this
// list) — now defined once in lib/storefrontSections.ts and imported here,
// rather than duplicated (see the top-level import).

const HomepageContentSchema = z.object({
  heroHeadline: z.string(),
  heroSubheadline: z.string(),
  primaryCallToAction: z.string(),
  secondaryCallToAction: z.string().nullable(),
  aboutUs: z.string(),
  whyChooseUs: z.string(),
  featuredCollections: z.array(z.string()),
  faq: z.array(FaqItemSchema),
  newsletterSection: z.string(),
  footerContent: z.string(),
  sectionOrder: z.array(z.enum(SECTION_KEYS)),
  customSection: z.object({ title: z.string(), body: z.string() }).nullable(),
});

const StoreContentSchema = z.object({
  shippingPolicy: z.string(),
  returnPolicy: z.string(),
  privacyPolicy: z.string(),
  termsAndConditions: z.string(),
  contactPageCopy: z.string(),
});

const MarketingAssetsSchema = z.object({
  seoTitle: z.string(),
  seoMetaDescription: z.string(),
  brandKeywords: z.array(z.string()),
  instagramBio: z.string(),
  facebookDescription: z.string(),
  xBio: z.string(),
});

const DesignDirectionSchema = z.object({
  visualStyle: z.string(),
  brandMood: z.string(),
  photographyStyle: z.string(),
  iconStyle: z.string(),
});

const ProductSpecSchema = z.object({
  label: z.string(),
  value: z.string(),
});

const ProductBlueprintSchema = z.object({
  name: z.string(),
  description: z.string(),
  keyFeatures: z.array(z.string()),
  benefits: z.array(z.string()),
  specifications: z.array(ProductSpecSchema),
  imagePrompt: z.string(),
  price: z.number(),
});

const CoreFieldsSchema = z.object({
  storeName: z.string(),
  tagline: z.string(),
  description: z.string(),
  theme: ThemeSchema,
  products: z.array(ProductBlueprintSchema),
});

// Phase 3 Milestone 2 — a small, separate classifier, same pattern as
// ProductImageRequestSchema/STORE_CHAT_IMAGE_REQUEST_SYSTEM_PROMPT below:
// bolting businessCategories directly onto PrimaryBlueprintSchema (already
// a large schema — theme, products, brandIdentity, homepageContent) hit a
// real Claude API limit in practice ("the compiled grammar is too large"),
// confirmed live, not a hypothetical — so this rides its own small call
// instead, run concurrently with the primary generation call (same input,
// no added latency) rather than sequentially after it.
// Phase 3 Milestone 5 — revenueStreams classification rides this exact same
// call rather than its own third API call: same input (briefText), same
// low-stakes/non-fatal treatment, and the reason this call exists at all in
// the first place (avoiding an oversized combined schema on the primary
// call) applies equally here — no reason to pay a second round-trip for
// another small classification field.
const BusinessCategorySchema = z.object({
  businessCategories: z.array(z.string()),
  revenueStreams: z.array(z.string()),
});

const PrimaryBlueprintSchema = CoreFieldsSchema.extend({
  brandIdentity: BrandIdentitySchema,
  homepageContent: HomepageContentSchema,
});

const SecondaryBlueprintSchema = z.object({
  storeContent: StoreContentSchema,
  marketingAssets: MarketingAssetsSchema,
  designDirection: DesignDirectionSchema,
});

// A live store's product catalog is real relational data tied to order
// history, not a JSON blob — so unlike the draft, chat for a live store
// never touches products. Only store-level identity/content is editable
// here; product edits stay on the existing per-product forms.
const StoreCoreFieldsSchema = z.object({
  storeName: z.string(),
  tagline: z.string(),
  description: z.string(),
  theme: ThemeSchema,
});

const StoreChatPrimarySchema = StoreCoreFieldsSchema.extend({
  brandIdentity: BrandIdentitySchema,
  homepageContent: HomepageContentSchema,
  reply: z.string(),
  requiresConfirmation: z.boolean(),
  touchesIdentity: z.boolean(),
  touchesTheme: z.boolean(),
  touchesBrandContent: z.boolean(),
  touchesSecondaryContent: z.boolean(),
});

// Chat responses must regenerate every field in scope every turn (the
// output format requires it), but an LLM reproducing a large untouched
// text block verbatim is not guaranteed byte-identical — small rephrasing
// drift on fields nobody asked to change caused false "X updated" entries
// in the diff log. These per-category touch flags let the code use the
// EXISTING stored value (not the model's reproduction) for anything not
// actually in scope, so the diff is only ever comparing genuine edits.
const SecondaryChatSchema = SecondaryBlueprintSchema.extend({
  touchesStoreContent: z.boolean(),
  touchesMarketingAssets: z.boolean(),
  touchesDesignDirection: z.boolean(),
});

// Shared across every prompt that produces a user-visible reply or
// substantive content — an expert who states a guess with the same
// confidence as a verified fact stops sounding like an expert.
const CALIBRATION_GUIDANCE = `Be precise about certainty — three kinds of claims read differently and should sound different:
- Facts the merchant told you, or that are simply true — state them plainly, no hedging.
- Assumptions you made to fill a gap they left open — flag them as such (e.g. "since you didn't specify a price point, I assumed mid-range") so they can correct you if you guessed wrong.
- Recommendations or advice — frame as guidance, not settled fact (e.g. "I'd recommend...", "worth considering...", "you may want to verify..."), especially anything regulatory, legal, or dependent on real-world rules that could be outdated, jurisdiction-specific, or wrong.
Never state an assumption or a recommendation with the same confidence as a fact.`;

// Shared wherever theme.presentation is produced — a fixed, storefront-safe
// vocabulary for translating brand personality into actual visual structure
// (not just color), so different brands genuinely look and feel different.
const PRESENTATION_GUIDANCE = `Choose theme.presentation deliberately to match this brand's personality — it controls the real shape and weight of buttons, cards, and shadows on the storefront, so a luxury brand and a playful brand should end up looking structurally different, not just recolored:
- cardStyle: "sharp" (crisp, minimal rounding) suits luxury, editorial, or minimalist brands; "rounded" (moderate) is a versatile modern default; "soft" (very rounded, pillowy) suits playful, friendly, or organic brands.
- buttonStyle: "sharp" (structured, rectangular) suits corporate, professional, or luxury brands; "pill" (fully rounded) suits approachable, modern, or friendly brands; "soft" (rounded rectangle) is a comfortable middle ground.
- shadowStyle: "none" (flat, relies on borders) suits minimalist or clean brands; "subtle" fits most modern brands; "bold" (dramatic depth) suits luxury or bold/statement brands.
- spacing: "compact" suits busy, value-driven, or bargain-feel brands; "comfortable" is a versatile default; "spacious" (generous whitespace) suits luxury, editorial, or premium-feel brands.
Make the four choices feel coherent together as one deliberate aesthetic, not an arbitrary mix.`;

// Shared wherever theme.composition is produced — the structural
// counterpart to presentation above. Where presentation is uniform styling
// (radius/shadow/spacing applied identically everywhere), composition is
// what actually varies the page's SHAPE per brand: hero structure, heading
// scale, section internal layout, backgrounds, image framing, and CTA
// composition. Two different businesses should be distinguishable by
// silhouette alone, not just by color.
const COMPOSITION_GUIDANCE = `Choose theme.composition deliberately to match this brand's personality — these six choices control the actual structural shape of the storefront, not just color, so two different businesses should genuinely look structurally different, not just recolored:
- heroLayout: "centered" (headline/subhead/CTA, no image) is a safe, versatile default; "split" (text one side, a visual panel the other) suits brands with strong product imagery or a visual story to lead with; "fullBleed" (a soft color backdrop behind the hero text) suits bold, statement brands; "minimal" (smaller, quieter) suits understated, editorial, or luxury brands.
- typeScale: "compact" suits busy, value-driven, or utilitarian brands; "standard" is a versatile default; "display" (large, bold, dramatic headings) suits luxury, editorial, or statement brands.
- sectionLayout: "centered" (today's default, centered text blocks) is safe and versatile; "split" (editorial two-column: heading one side, body copy the other) suits brands with a strong narrative voice; "boxed" (content inside a bordered panel) suits brands wanting clear visual segmentation.
- backgroundTreatment: "tintBands" (alternating soft surface bands between sections) is a versatile default; "flat" (no bands, hairline borders only) suits minimalist or clean brands; "bordered" (strong divider lines instead of bands) suits structured, editorial brands.
- imageTreatment: "contained" (inset, rounded per cardStyle) is a safe default; "fullBleed" (edge-to-edge) suits visually confident brands leaning on strong imagery; "framed" (a visible accent-colored border/matte treatment) suits heritage, artisan, or craft brands.
- ctaEmphasis: "button" (a filled call-to-action button) suits most brands; "banner" (a bold full-width colored CTA strip) suits retail-forward, high-urgency brands; "minimal" (an understated text link, no filled background) suits quiet, editorial, or luxury brands that shouldn't feel "salesy."
Note ctaEmphasis is independent of presentation.buttonStyle: buttonStyle governs the corner shape of any button that appears anywhere on the page; ctaEmphasis governs whether the hero's primary call-to-action is a button at all, versus a banner or a text link.
Make all ten presentation and composition choices together feel like one coherent, deliberate aesthetic for this specific brand — not an arbitrary mix.`;

// Shared wherever homepageContent.sectionOrder is produced — the homepage
// should be structured deliberately per business type, not follow one
// generic template every time.
const HOMEPAGE_STRUCTURE_GUIDANCE = `Choose homepageContent.sectionOrder deliberately based on what actually matters for THIS kind of business. Two different businesses should rarely produce the same order — treat "about, whyChooseUs, featuredCollections, products, brandStory, faq, newsletter" as a generic fallback you should actively avoid defaulting to, not a safe default. The hero always comes first and the footer always comes last (neither is part of sectionOrder). "products" must appear somewhere in sectionOrder. Beyond that, pick, order, and OMIT sections based on what this specific business needs — most businesses should skip at least one available section.

Examples of how the right order differs by business type (illustrative, not a checklist to copy):
- A luxury brand might lead with "featuredCollections", then "brandStory", then "products", then "faq" — collections and story build desire before the ask; skip "whyChooseUs" if it would feel like discount-store convincing.
- A coffee shop might go "about", "products", "customSection" (e.g. "Our Brewing Philosophy"), then "newsletter" — process and craft matter more than hard-selling.
- A fitness brand might go "whyChooseUs", "products", "customSection" (e.g. "Real Results"), then "faq" — results and credibility come before the catalog.

Use "customSection" (a title + body you write) for anything industry-specific that doesn't fit the standard sections — a brewing philosophy, a sizing/fit guide, a sourcing story, a results showcase. For most businesses this is a real opportunity, not a rare exception — lean toward including one when there's a genuine industry-specific angle. Leave it null only when nothing like that truly fits. Do not generate customer testimonials or reviews under any section — Genesis never fabricates quotes attributed to real or implied customers.

CRITICAL consistency rule: "customSection" (the key) must appear in sectionOrder if and only if the customSection object is non-null. If you write real content for customSection, you MUST include "customSection" in sectionOrder somewhere, or that content will never be shown — this is a common mistake, double-check it before finishing.

secondaryCallToAction is optional — only include one (e.g. "Our Story", "See How It Works") when it adds real value alongside the primary CTA; otherwise set it to null rather than inventing a weak one.`;

const BRAND_PROMISE_GUIDANCE = `brandIdentity.brandPromise is distinct from missionStatement and visionStatement — it's not an internal aspiration, it's a short, concrete, customer-facing commitment (e.g. "Every piece hand-finished within 48 hours" or "Free returns, no questions asked, always"). It should be specific enough that a customer could actually notice if it wasn't kept.`;

// Shared by both draft and live chat CONTROL prompts — the fix for a real
// beta incident where a user pasted a large, comprehensive-sounding
// business description into chat and Genesis treated it as grounds for a
// sweeping rewrite instead of new context to fold into the business
// already being built. Placed at CONTROL (the decision stage) rather than
// CONTENT, since this is a judgment call about intent, not about how to
// write a field once scope is already decided.
const CONTINUATION_GUIDANCE = `Default to continuation, not replacement. When the user shares new or additional information about their business — a longer description, more detail about what they sell or who it's for, a pasted write-up, expanded context — treat it as material to weave into the business that already exists, not as a fresh brief to build from scratch. Preserve everything about the current identity, tone, and story that the new information doesn't actually contradict; incorporate what's new as an addition or refinement, the way a real co-founder folds new information into an ongoing plan rather than throwing out the whiteboard.

Only treat a message as a request to start over when the user actually says so — "start over," "let's try something completely different," "scrap this," "redesign everything," or equivalent. A message that merely contains a lot of new detail is not, on its own, a request to replace anything, no matter how comprehensive or polished it reads (including text that looks like it was drafted elsewhere and pasted in). If a message is genuinely ambiguous — it reads like it could describe a different business entirely, and nothing indicates whether the user wants it merged in or wants a fresh start — treat that the same as an unconfirmed identity change: set requiresConfirmation true and ask directly, rather than silently guessing.`;

// Phase 3 Milestone 2 — a small, standalone classification prompt (its own
// call, see BusinessCategorySchema above) so Claude picks from the real,
// current taxonomy (lib/businessTaxonomy.ts) rather than inventing its own
// categories; filterKnownBusinessCategories() still drops anything
// unrecognized after parsing as a second real check, not just prompt-level
// guidance.
const BUSINESS_CATEGORY_SYSTEM_PROMPT = `You are classifying a new business, for internal use only — none of this is shown to the customer. Given the business's name, what it sells, and its vision, do two separate classifications:

1. businessCategories: choose 1-3 of the closest-matching industry slugs from this list: ${BUSINESS_SUBCATEGORY_SLUGS.join(", ")}. Pick "other" only if nothing else genuinely fits.
2. revenueStreams: choose 1-2 of the closest-matching slugs describing how this business actually makes money, from this list: ${REVENUE_STREAM_SLUGS.join(", ")}. Pick "other" only if nothing else genuinely fits.`;

const GENERATION_SYSTEM_PROMPT = `You are Genesis, an expert e-commerce consultant and brand strategist building a new business from scratch — not a form-filler producing the bare minimum needed to populate a database. Given a business description, produce a complete, professional, launch-ready brand identity and storefront content package.

Users may specify some details themselves (a store name, what they sell, and/or a vision for their brand) and leave the rest for you to invent.

Rules:
- Treat any user-provided store name as fixed. Use it exactly as given — never change, rename, or reinterpret it.
- Treat any user-provided description of what they sell as a fixed constraint. Build the product catalog around it.
- Treat any user-provided vision (style, audience, colors, branding) as fixed creative direction. Let it guide every part they didn't specify — everything you produce should feel like it comes from the SAME coherent brand, not disconnected generic text.
- Only invent details for fields the user left unspecified. When inventing, make deliberate, on-brand choices — not generic filler.

Bring genuine domain expertise, not generic e-commerce boilerplate. Tailor product features, benefits, and specifications to what an actual expert in this specific category would highlight — a seasoned specialist in this business's niche, not a copywriter guessing.

${PRESENTATION_GUIDANCE}

${HOMEPAGE_STRUCTURE_GUIDANCE}

${BRAND_PROMISE_GUIDANCE}

${CALIBRATION_GUIDANCE}

Produce every field in the schema with real, specific, on-brand content — never leave a field generic or templated.`;

const GENERATION_SECONDARY_SYSTEM_PROMPT = `You are Genesis, an expert e-commerce consultant, continuing work on a brand identity and content package you already started. You will be given the brand identity, homepage content, and products you already produced for this business. Now produce the store's policies, marketing assets, and design direction so they read as if written by the same person for the same brand — matching its tone, values, and target audience.

Bring genuine domain expertise. Proactively include protections and details that matter for THIS specific business — its product category, price point, and audience — even when not explicitly asked. For example: valuable or collectible items warrant insured shipping and signature confirmation on high-value orders; fragile items should mention packaging care; anything shipped internationally should address customs, import duties, and who's responsible for them. Use judgment about what's actually relevant — don't pad with generic boilerplate that doesn't fit this business.

For legal/policy content (shipping policy, return policy, privacy policy, terms and conditions): write clear, reasonable, standard small-business language appropriate as a launch starting point — not exhaustive legal documents, and not a substitute for professional legal review. Keep each to a few solid paragraphs.

${CALIBRATION_GUIDANCE}

Produce every field in the schema with real, specific, on-brand content — never leave a field generic or templated.`;

// A third, dedicated call — not folded into PRIMARY. Adding composition's
// six enum fields directly to PrimaryBlueprintSchema was tried and
// confirmed (empirically, via a real API call) to reproduce the exact
// "compiled grammar is too large" error described at the top of this file.
const GENERATION_COMPOSITION_SYSTEM_PROMPT = `You are Genesis, an expert e-commerce consultant, continuing work on a brand identity and storefront you already started. You will be given the brand identity, homepage content, and visual theme (colors, typography, presentation) you already produced for this business. Now choose how the storefront should be structurally composed.

${COMPOSITION_GUIDANCE}`;

// Core generation logic, extracted so it can be driven two ways: the
// Server Action below (progressive-enhancement fallback — a plain
// <form action={generateStoreDraft}> still works with JS disabled) and
// the Route Handler at app/api/generate-store-draft/route.ts (what
// CreateStoreForm.tsx's client-driven progress UI actually calls).
//
// This split exists because of a real, verified React/Next.js behavior,
// not a style preference: invoking a Server Action programmatically
// requires wrapping the call in startTransition (React's documented
// calling convention for actions outside a <form>), but startTransition
// defers the *commit* of the whole component tree — including sibling
// state updates made outside the transition — until the transition
// itself settles. Confirmed live: a local isGenerating state flip:
// react re-ran the component's render function every tick (proving the
// state update itself fired), but the actual DOM never repainted for
// the full ~110s the real generateStoreDraft action was in flight,
// because React held the prior committed UI on screen the whole time,
// exactly per startTransition's real semantics (built for de-prioritizing
// non-urgent updates, not for keeping a UI responsive during one long
// operation). A plain fetch() to a Route Handler has no such coupling —
// the local isGenerating flip commits immediately, completely
// independent of the fetch's own lifecycle.
async function generateStoreDraftCore(
  userId: string,
  sessionInstanceId: string,
  formData: FormData
): Promise<void> {
  // Family-beta instrumentation (v20) — the "Welcome to Genesis" creation
  // journey's own real duration; see the creation.* events below.
  const creationStartedAt = Date.now();

  // A pre-existing draft means this call is the "Regenerate" mini-form (a
  // real, one-shot regeneration that bypasses the conversational/diff-
  // tracked chat path entirely — see the v20 plan's Welcome-to-Genesis
  // audit) rather than the very first generation.
  const existingDraft = await prisma.storeDraft.findUnique({
    where: { userId },
    select: { id: true },
  });

  const inputStoreName =
    (formData.get("inputStoreName") as string)?.trim() || null;
  const inputProductType =
    (formData.get("inputProductType") as string)?.trim() || null;
  const inputVision = (formData.get("inputVision") as string)?.trim() || null;

  if (!inputVision) {
    throw new RecoverableError("Please describe your vision");
  }

  // Onboarding-resume reliability fix — persist the owner's own typed
  // inputs *before* the slow (tens-of-seconds, multi-call) generation
  // sequence below, not after. Previously nothing touched the database
  // until every call succeeded, so any interruption (closed tab,
  // dropped network, a backgrounded phone) during that window silently
  // lost the business description with zero trace — the next /dashboard
  // load found no StoreDraft and showed the exact same blank "Welcome to
  // Genesis" form, no different from a first-ever visit. Scoped to
  // genuine first-time generation only (`!existingDraft`) — the
  // "Regenerate" mini-form on an already-`ready` draft already has a
  // real fallback if its own attempt is interrupted (the still-good
  // previous draft content, untouched by this write), so it doesn't
  // need this extra persist.
  //
  // `status` does double duty: app/dashboard/page.tsx's `!store` branch
  // treats anything other than `"ready"` as "not fully generated yet, show
  // the resume form" (unchanged by adding more granular values below —
  // still a simple ready/not-ready check there), while
  // CreateStoreForm.tsx's progress UI polls app/api/draft-status for the
  // *specific* value to show an honest "which real phase are we in"
  // message. `"generating_primary"` here, `"generating_secondary"` right
  // before the next real call below, `"ready"` unchanged at the end.
  if (!existingDraft) {
    await prisma.storeDraft.upsert({
      where: { userId: userId },
      create: {
        userId: userId,
        inputStoreName,
        inputProductType,
        inputVision,
        name: inputStoreName || "New store",
        status: "generating_primary",
      },
      update: {
        // Reached only on a genuine race (e.g. two tabs submitting the
        // first-ever generation at once) — refresh the raw inputs rather
        // than fail; the second submission's own generation still runs
        // and produces the real draft as usual.
        inputStoreName,
        inputProductType,
        inputVision,
        status: "generating_primary",
      },
    });
  }

  const briefText = [
    `Store name: ${inputStoreName ?? "(not specified — invent one)"}`,
    `What they sell: ${
      inputProductType ?? "(not specified — invent something fitting)"
    }`,
    `Vision: ${inputVision ?? "(not specified — use your best judgment)"}`,
  ].join("\n");

  // Phase 3 Milestone 2 — the business-category classifier runs
  // concurrently with the primary call, not after it: same input
  // (briefText), no dependency on primary's output, so there's no reason
  // to pay its latency sequentially. Deliberately non-fatal — a
  // classification failure/timeout falls back to an empty array rather
  // than failing the whole store creation over a low-stakes side field.
  const [primaryOutcome, businessCategoryOutcome] = await Promise.all([
    callGenesisModel({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: GENERATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: briefText }],
      output_config: {
        effort: "high",
        format: zodOutputFormat(PrimaryBlueprintSchema),
      },
    }),
    callGenesisModel({
      model: "claude-opus-4-8",
      max_tokens: 300,
      thinking: { type: "adaptive" },
      system: BUSINESS_CATEGORY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: briefText }],
      output_config: {
        effort: "low",
        format: zodOutputFormat(BusinessCategorySchema),
      },
    }),
  ]);
  const businessCategories = filterKnownBusinessCategories(
    businessCategoryOutcome.ok
      ? (businessCategoryOutcome.message.parsed_output?.businessCategories ?? [])
      : []
  );
  const revenueStreams = filterKnownRevenueStreams(
    businessCategoryOutcome.ok
      ? (businessCategoryOutcome.message.parsed_output?.revenueStreams ?? [])
      : []
  );
  if (!primaryOutcome.ok) {
    await logProductEvent({
      userId: userId,
      storeDraftId: existingDraft?.id ?? null,
      sessionInstanceId: sessionInstanceId,
      name: existingDraft ? "creation.regenerated_via_form" : "creation.started",
      category: "creation",
      attemptKey: existingDraft?.id ?? userId,
      outcome: "failure",
      durationMs: Date.now() - creationStartedAt,
      metadata: { providerErrorKind: primaryOutcome.kind, providerStatus: primaryOutcome.status },
    });
    throw new RecoverableError(genesisModelFailureMessage(primaryOutcome.kind));
  }
  const primary = primaryOutcome.message.parsed_output;
  if (!primary) {
    await logProductEvent({
      userId: userId,
      storeDraftId: existingDraft?.id ?? null,
      sessionInstanceId: sessionInstanceId,
      name: existingDraft ? "creation.regenerated_via_form" : "creation.started",
      category: "creation",
      attemptKey: existingDraft?.id ?? userId,
      outcome: "failure",
      durationMs: Date.now() - creationStartedAt,
    });
    throw new RecoverableError("Failed to generate store blueprint");
  }

  // Real phase transition, not a timer — see the early-persist upsert's
  // own comment. Scoped to first-time generation only, matching that
  // upsert's own scoping.
  if (!existingDraft) {
    await prisma.storeDraft.update({
      where: { userId: userId },
      data: { status: "generating_secondary" },
    });
  }

  // SECONDARY and COMPOSITION both only depend on PRIMARY's output, not on
  // each other — run them concurrently rather than back-to-back.
  //
  // KNOWN ARCHITECTURAL CONSTRAINT, audited 2026-07-29 (Phase 1 Beta
  // Excellence checklist #2 — see memory/project_beta_readiness_audit.md
  // for the full real-timing measurement this closes out): PRIMARY must
  // fully complete before SECONDARY/COMPOSITION can start. Two independent
  // reasons, either one alone would be sufficient:
  // 1. Both prompts below genuinely need nearly all of PRIMARY's output —
  //    SECONDARY's prompt embeds storeName/tagline/description/
  //    brandIdentity/homepageContent/products; COMPOSITION's embeds
  //    brandIdentity/homepageContent/theme. There's no small early subset
  //    of PRIMARY that would unblock either call sooner — they need
  //    essentially the complete object either way.
  // 2. callGenesisModel() (lib/genesisModel.ts) calls
  //    `.stream(params).finalMessage()` — the SDK stream is used for
  //    transport/reliability, not exposed to callers incrementally. A
  //    caller only ever gets a complete, Zod-validated result or a
  //    classified failure, never partial output. Making PRIMARY's fields
  //    available before its call fully resolves would need a genuinely
  //    different architecture (incremental partial-JSON parsing against a
  //    still-streaming response, with its own validation/error-handling
  //    risks) for, per point 1, minimal real benefit — not attempted.
  const [secondaryOutcome, compositionOutcome] = await Promise.all([
    callGenesisModel({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: GENERATION_SECONDARY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Business brief:\n${briefText}\n\nAlready-produced brand identity, homepage content, and products (JSON):\n${JSON.stringify(
            {
              storeName: primary.storeName,
              tagline: primary.tagline,
              description: primary.description,
              brandIdentity: primary.brandIdentity,
              homepageContent: primary.homepageContent,
              products: primary.products,
            },
            null,
            2
          )}`,
        },
      ],
      output_config: {
        effort: "high",
        format: zodOutputFormat(SecondaryBlueprintSchema),
      },
    }),
    callGenesisModel({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: GENERATION_COMPOSITION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Brand identity, homepage content, and visual theme (JSON):\n${JSON.stringify(
            {
              brandIdentity: primary.brandIdentity,
              homepageContent: primary.homepageContent,
              theme: primary.theme,
            },
            null,
            2
          )}`,
        },
      ],
      output_config: {
        effort: "high",
        format: zodOutputFormat(CompositionSchema),
      },
    }),
  ]);
  // Checked independently (not via a shared "whichever failed" variable) so
  // TypeScript actually narrows each of secondaryOutcome/compositionOutcome
  // to its success variant below — narrowing a third variable derived from
  // them doesn't narrow the originals.
  if (!secondaryOutcome.ok) {
    await logProductEvent({
      userId: userId,
      storeDraftId: existingDraft?.id ?? null,
      sessionInstanceId: sessionInstanceId,
      name: existingDraft ? "creation.regenerated_via_form" : "creation.started",
      category: "creation",
      attemptKey: existingDraft?.id ?? userId,
      outcome: "failure",
      durationMs: Date.now() - creationStartedAt,
      metadata: { providerErrorKind: secondaryOutcome.kind, providerStatus: secondaryOutcome.status },
    });
    throw new RecoverableError(genesisModelFailureMessage(secondaryOutcome.kind));
  }
  if (!compositionOutcome.ok) {
    await logProductEvent({
      userId: userId,
      storeDraftId: existingDraft?.id ?? null,
      sessionInstanceId: sessionInstanceId,
      name: existingDraft ? "creation.regenerated_via_form" : "creation.started",
      category: "creation",
      attemptKey: existingDraft?.id ?? userId,
      outcome: "failure",
      durationMs: Date.now() - creationStartedAt,
      metadata: { providerErrorKind: compositionOutcome.kind, providerStatus: compositionOutcome.status },
    });
    throw new RecoverableError(genesisModelFailureMessage(compositionOutcome.kind));
  }
  const secondary = secondaryOutcome.message.parsed_output;
  const composition = compositionOutcome.message.parsed_output;
  if (!secondary || !composition) {
    await logProductEvent({
      userId: userId,
      storeDraftId: existingDraft?.id ?? null,
      sessionInstanceId: sessionInstanceId,
      name: existingDraft ? "creation.regenerated_via_form" : "creation.started",
      category: "creation",
      attemptKey: existingDraft?.id ?? userId,
      outcome: "failure",
      durationMs: Date.now() - creationStartedAt,
    });
    throw new RecoverableError("Failed to generate store blueprint");
  }

  const blueprintContent: Blueprint = {
    brandIdentity: primary.brandIdentity,
    homepageContent: primary.homepageContent,
    storeContent: secondary.storeContent,
    marketingAssets: secondary.marketingAssets,
    designDirection: secondary.designDirection,
  };

  const themeWithComposition: ThemeWithComposition = { ...primary.theme, composition };

  const generatedOutput = {
    name: primary.storeName,
    tagline: primary.tagline,
    description: primary.description,
    theme: themeWithComposition,
    productsDraft: primary.products,
    blueprint: blueprintContent,
  };

  const draft = await prisma.storeDraft.upsert({
    where: { userId: userId },
    create: {
      userId: userId,
      inputStoreName,
      inputProductType,
      inputVision,
      name: primary.storeName,
      tagline: primary.tagline,
      description: primary.description,
      theme: themeWithComposition,
      productsDraft: primary.products,
      blueprint: blueprintContent,
      businessCategories,
      revenueStreams,
      status: "ready",
    },
    update: {
      inputStoreName,
      inputProductType,
      inputVision,
      name: primary.storeName,
      tagline: primary.tagline,
      description: primary.description,
      theme: themeWithComposition,
      productsDraft: primary.products,
      blueprint: blueprintContent,
      businessCategories,
      revenueStreams,
      status: "ready",
      version: { increment: 1 },
    },
  });

  await prisma.storeGeneration.create({
    data: {
      storeDraftId: draft.id,
      version: draft.version,
      promptVersion: PROMPT_VERSION,
      // version === 1 only happens on the very first generation a draft
      // ever gets (every regenerate/chat update increments it), so this is
      // reliably "the original vision" without a separate lookup.
      milestone: draft.version === 1 ? "original" : null,
      generatedOutput,
    },
  });

  // Phase 2 Milestone 1 — "Start over from scratch" used to be a fully
  // untracked regeneration: no StoreDraftMessage, no diff, no visible
  // record that it happened, unlike every real chat turn. Regeneration
  // itself still goes through this exact function (generateStoreDraftCore),
  // preserving CreateStoreForm's progress panel — this only adds the
  // conversational record on top, gated to the regenerate case specifically
  // (first-time creation has no prior conversation to record against).
  if (existingDraft) {
    await prisma.storeDraftMessage.create({
      data: { storeDraftId: draft.id, role: "user", content: briefText },
    });
    await prisma.storeDraftMessage.create({
      data: {
        storeDraftId: draft.id,
        role: "assistant",
        content: "I've started your business over from scratch based on this new description.",
      },
    });
  }

  await logProductEvent({
    userId,
    storeDraftId: draft.id,
    sessionInstanceId,
    name: existingDraft ? "creation.regenerated_via_form" : "creation.started",
    category: "creation",
    attemptKey: draft.id,
    outcome: "success",
    durationMs: Date.now() - creationStartedAt,
  });
}

// Server Action wrapper — progressive-enhancement fallback only (a plain
// <form action={generateStoreDraft}> still works with JS disabled). The
// real client flow (CreateStoreForm.tsx) calls
// app/api/generate-store-draft/route.ts instead — see
// generateStoreDraftCore's own comment for why.
export async function generateStoreDraft(formData: FormData) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  await generateStoreDraftCore(session.user.id, session.user.sessionInstanceId, formData);

  redirect("/dashboard");
}

// What app/api/generate-store-draft/route.ts actually calls — a Route
// Handler, not a Server Action, so CreateStoreForm.tsx's client-driven
// progress UI can call generation via a plain fetch() (see
// generateStoreDraftCore's own comment for why that matters). This
// function is exported from a "use server" file, which technically makes
// it Server-Action-referenceable, but it's safe to expose regardless:
// exactly like generateStoreDraft above, it independently re-derives
// identity from auth() rather than trusting any caller-supplied value —
// the same security convention every Server Action in this file already
// follows. Route Handlers calling an exported async function directly is
// an ordinary server-to-server call; the startTransition requirement (and
// the render-commit-blocking behavior that caused this whole split) only
// applies to *client* code invoking a Server Action, never to this.
export async function generateStoreDraftForApi(
  formData: FormData
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await auth();
  if (!session?.user) {
    return { ok: false, error: "Not signed in" };
  }

  try {
    await generateStoreDraftCore(session.user.id, session.user.sessionInstanceId, formData);
    return { ok: true };
  } catch (error) {
    return toActionState(error);
  }
}

const LAYOUTS = ["grid", "list", "featured"] as const;

export async function updateStoreDraft(formData: FormData) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const existingDraft = await prisma.storeDraft.findUnique({
    where: { userId: session.user.id },
    select: { productsDraft: true, theme: true },
  });
  const existingProducts =
    (existingDraft?.productsDraft as ProductContent[] | null) ?? [];
  const existingTheme = existingDraft?.theme as ThemeWithComposition | null;

  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();

  if (!name) {
    throw new Error("Store name is required");
  }

  const layout = formData.get("layout") as string;
  if (!LAYOUTS.includes(layout as (typeof LAYOUTS)[number])) {
    throw new Error("Invalid layout");
  }

  // This form only exposes colors/typography/layout for manual editing —
  // preserve the AI-chosen presentation (card/button/shadow/spacing style)
  // and composition (hero/section/background/image/CTA structure) rather
  // than silently wiping them out, same as with product rich content.
  const theme: ThemeWithComposition = {
    colors: {
      primary: (formData.get("colorPrimary") as string)?.trim(),
      secondary: (formData.get("colorSecondary") as string)?.trim(),
      accent: (formData.get("colorAccent") as string)?.trim(),
      background: (formData.get("colorBackground") as string)?.trim(),
      surface: (formData.get("colorSurface") as string)?.trim(),
      text: (formData.get("colorText") as string)?.trim(),
      textSecondary: (formData.get("colorTextSecondary") as string)?.trim(),
    },
    typography: {
      headingFont: (formData.get("headingFont") as string)?.trim(),
      bodyFont: (formData.get("bodyFont") as string)?.trim(),
    },
    layout: layout as Theme["layout"],
    presentation: existingTheme?.presentation ?? DEFAULT_THEME_PRESENTATION,
    composition: existingTheme?.composition ?? DEFAULT_THEME_COMPOSITION,
  };

  const productCount = parseInt(
    (formData.get("productCount") as string) || "0",
    10
  );
  const products: ProductContent[] = [];
  for (let i = 0; i < productCount; i++) {
    const productName = (formData.get(`product-${i}-name`) as string)?.trim();
    const productDescription = (
      formData.get(`product-${i}-description`) as string
    )?.trim();
    const priceInput = formData.get(`product-${i}-price`) as string;
    const price = parseFloat(priceInput);

    if (!productName) {
      throw new Error("Each product needs a name");
    }
    if (!Number.isFinite(price) || price < 0) {
      throw new Error("Enter a valid price for each product");
    }

    // This form only exposes name/description/price for manual editing —
    // preserve whatever richer AI-generated content (features, benefits,
    // specs, image prompt) already existed for this product rather than
    // silently wiping it out.
    const existing = existingProducts[i];
    products.push({
      name: productName,
      description: productDescription || "",
      price,
      keyFeatures: existing?.keyFeatures ?? [],
      benefits: existing?.benefits ?? [],
      specifications: existing?.specifications ?? [],
      imagePrompt: existing?.imagePrompt ?? "",
    });
  }

  await prisma.storeDraft.update({
    where: { userId: session.user.id },
    data: {
      name,
      description: description || null,
      theme,
      productsDraft: products,
    },
  });

  redirect("/dashboard");
}

type Theme = z.infer<typeof ThemeSchema>;
type ThemeColors = Theme["colors"];
// `composition` deliberately isn't part of ThemeSchema/Theme (see the
// comment above CompositionSchema) — this local type represents the fully
// assembled theme actually persisted to the database, after merging in the
// separately-generated composition object.
type ThemeWithComposition = Theme & { composition: z.infer<typeof CompositionSchema> };

// Fallback for the manual "Save changes" form, which doesn't expose
// presentation controls — only used if a draft somehow has no theme yet.
const DEFAULT_THEME_PRESENTATION: Theme["presentation"] = {
  cardStyle: "rounded",
  buttonStyle: "pill",
  shadowStyle: "subtle",
  spacing: "comfortable",
};

// Same fallback role as DEFAULT_THEME_PRESENTATION, for composition —
// values chosen to reproduce today's actual hardcoded rendering exactly,
// so a draft with no composition yet (or predating this field) looks
// pixel-identical to before this system existed.
const DEFAULT_THEME_COMPOSITION: ThemeWithComposition["composition"] = {
  heroLayout: "centered",
  typeScale: "standard",
  sectionLayout: "centered",
  backgroundTreatment: "tintBands",
  imageTreatment: "contained",
  ctaEmphasis: "button",
};

// Live Product.richContent is untyped JSON ({keyFeatures, benefits,
// specifications, imagePrompt}, written at confirmStoreDraft time) — unlike
// the draft-stage ProductContent below, imagePrompt is nested here rather
// than a direct column, so every live-product read needs this extraction.
function extractRichContentImagePrompt(richContent: unknown): string | null {
  if (richContent && typeof richContent === "object" && "imagePrompt" in richContent) {
    const value = (richContent as { imagePrompt?: unknown }).imagePrompt;
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  return null;
}

type ProductSpec = { label: string; value: string };

type ProductContent = {
  name: string;
  description: string;
  keyFeatures: string[];
  benefits: string[];
  specifications: ProductSpec[];
  imagePrompt: string;
  price: number;
};

type BrandIdentity = z.infer<typeof BrandIdentitySchema>;
type HomepageContent = z.infer<typeof HomepageContentSchema>;
type StoreContent = z.infer<typeof StoreContentSchema>;
type MarketingAssets = z.infer<typeof MarketingAssetsSchema>;
type DesignDirection = z.infer<typeof DesignDirectionSchema>;

type Blueprint = {
  brandIdentity: BrandIdentity;
  homepageContent: HomepageContent;
  storeContent: StoreContent;
  marketingAssets: MarketingAssets;
  designDirection: DesignDirection;
};

type DraftState = {
  name: string;
  tagline: string | null;
  description: string | null;
  theme: ThemeWithComposition;
  products: ProductContent[];
  blueprint: Blueprint | null;
};

function diffDraftChanges(before: DraftState, after: DraftState): string[] {
  const changes: string[] = [];

  if (before.name !== after.name) {
    changes.push(`Store name changed from "${before.name}" to "${after.name}"`);
  }
  if ((before.tagline ?? "") !== (after.tagline ?? "")) {
    changes.push("Tagline changed");
  }
  if ((before.description ?? "") !== (after.description ?? "")) {
    changes.push("Store description changed");
  }

  for (const role of Object.keys(after.theme.colors) as (keyof ThemeColors)[]) {
    if (before.theme.colors[role] !== after.theme.colors[role]) {
      changes.push(`theme.colors.${role} changed`);
    }
  }
  if (before.theme.typography.headingFont !== after.theme.typography.headingFont) {
    changes.push("theme.typography.headingFont changed");
  }
  if (before.theme.typography.bodyFont !== after.theme.typography.bodyFont) {
    changes.push("theme.typography.bodyFont changed");
  }
  if (before.theme.layout !== after.theme.layout) {
    changes.push(`theme.layout changed to ${after.theme.layout}`);
  }

  const beforeNames = new Set(before.products.map((p) => p.name));
  const afterNames = new Set(after.products.map((p) => p.name));
  const added = [...afterNames].filter((n) => !beforeNames.has(n));
  const removed = [...beforeNames].filter((n) => !afterNames.has(n));
  if (added.length > 0) {
    changes.push(`products added: ${added.join(", ")}`);
  }
  if (removed.length > 0) {
    changes.push(`products removed: ${removed.join(", ")}`);
  }
  for (const product of after.products) {
    const match = before.products.find((p) => p.name === product.name);
    if (match && match.price !== product.price) {
      changes.push(
        `"${product.name}" price changed from $${match.price} to $${product.price}`
      );
    } else if (match && JSON.stringify(match) !== JSON.stringify(product)) {
      changes.push(`"${product.name}" content updated`);
    }
  }

  if (before.blueprint && after.blueprint) {
    if (
      JSON.stringify(before.blueprint.brandIdentity) !==
      JSON.stringify(after.blueprint.brandIdentity)
    ) {
      changes.push("Brand identity updated");
    }
    if (
      JSON.stringify(before.blueprint.homepageContent) !==
      JSON.stringify(after.blueprint.homepageContent)
    ) {
      changes.push("Homepage content updated");
    }
    if (
      JSON.stringify(before.blueprint.storeContent) !==
      JSON.stringify(after.blueprint.storeContent)
    ) {
      changes.push("Store policies updated");
    }
    if (
      JSON.stringify(before.blueprint.marketingAssets) !==
      JSON.stringify(after.blueprint.marketingAssets)
    ) {
      changes.push("Marketing assets updated");
    }
    if (
      JSON.stringify(before.blueprint.designDirection) !==
      JSON.stringify(after.blueprint.designDirection)
    ) {
      changes.push("Design direction updated");
    }
  }

  return changes;
}

// Draft chat's primary call USED to be PrimaryBlueprintSchema extended with
// reply/requiresConfirmation/touches* (7 extra fields) — that combination
// crossed the API's structured-output grammar-compiler limit ("compiled
// grammar is too large") even though PrimaryBlueprintSchema alone (used by
// generateStoreDraft) is fine on its own, confirming Primary was already
// right at the ceiling the original PRIMARY/SECONDARY split was sized for.
// Fixed the same way that split was originally motivated: don't extend the
// heavy content schema at all. CONTROL (this schema) decides intent/scope
// and writes the reply from a small, standalone schema; CONTENT (below)
// generates the actual field values using PrimaryBlueprintSchema unmodified,
// informed by CONTROL's stated plan so the two stay coherent.
const ChatControlSchema = z.object({
  reply: z.string(),
  requiresConfirmation: z.boolean(),
  touchesIdentity: z.boolean(),
  touchesTheme: z.boolean(),
  touchesBrandContent: z.boolean(),
  touchesProducts: z.boolean(),
  touchesSecondaryContent: z.boolean(),
});

const CHAT_CONTROL_SYSTEM_PROMPT = `You are Genesis — an expert e-commerce consultant and creative partner working directly with this merchant to build their business. You are not a chatbot, an API, or a support agent; you're a skilled collaborator with real expertise in branding, retail, and online commerce, closer to an experienced co-founder than a tool. Speak like one: confident, natural, specific. Never mention databases, drafts, versions, schemas, JSON, internal steps, or any other implementation detail — the merchant should never sense there's "a system" behind you, only you, doing the work.

You will be given the current store draft (as JSON — including policies, marketing assets, and design direction, which you cannot edit yourself but may reference) and the user's latest message. You are responsible for: store name, tagline, description, visual theme, products, brand identity (story, mission, vision, values, personality, voice, target audience, USP), and homepage content (hero copy, about us, why choose us, FAQ, newsletter, footer). A separate step you don't see will generate the actual updated content immediately after you respond, following the plan stated in your reply — so be concrete and specific about what you intend to do, not vague, even though you aren't producing the content yourself here.

Be a proactive expert, not an order-taker. Don't just do the literal thing asked — bring the judgment a seasoned consultant would. When a request touches an area where real expertise matters (shipping valuable or fragile goods, a specific audience's expectations, seasonal timing, a competitive category), volunteer the considerations that matter for THIS business specifically, informed by what it sells and who it's for.

Respond in one of two ways:

1. Apply the change directly. Set requiresConfirmation to false, and write your reply as if the change is done — state specifically and concretely what you changed (the actual direction, e.g. "shifted your palette to a deep forest green with warm gold accents," not just "updated the colors"). Use this for broad requests that clearly invite sweeping changes (e.g. "redesign my store", "make this feel more premium") and for small, unambiguous requests (e.g. "remove the hoodie", "make the accent color more blue", "rewrite my tagline").

2. Propose the change and ask for confirmation first. Set requiresConfirmation to true, and phrase your reply as a specific proposal, e.g. "I'd rename the store from X to Y — that'll ripple through your branding. Want me to go ahead?" Use this only for changes to foundational identity — most importantly the store name — where an unconfirmed change could feel jarring or accidental.

If you previously proposed a change awaiting confirmation (noted in the message below) and the user's new message confirms it (e.g. "yes", "go ahead", "do it"), treat that previously proposed change as approved now (requiresConfirmation: false) and describe it concretely in your reply. If their new message asks for something different instead, treat it as a new request.

Set these flags accurately based on what the user's message actually asks for — the step that generates content only touches the categories you flag true here, so get them right:
- touchesIdentity: store name, tagline, or description
- touchesTheme: colors, typography, layout, or presentation/composition choices (card/button style, shadows, spacing, hero layout, section layout, backgrounds, image treatment, CTA style)
- touchesBrandContent: brand identity (story, mission, vision, values, personality, voice, audience, USP) or homepage content (hero, about, why choose us, FAQ, newsletter, footer)
- touchesProducts: the product catalog
- touchesSecondaryContent: shipping policy, return policy, privacy policy, terms and conditions, the contact page, SEO, social media bios, or design direction (visual style, mood, photography, icon style)
Set a flag true for a category only when you're actually directing a change to it this turn — a broad "redesign everything" request should set most or all of them true; a narrow request (e.g. "update my shipping policy") should set only the relevant one(s) true. When requiresConfirmation is true, leave every touches flag false — nothing is being changed yet. Regardless of these flags, speak in your reply as if you personally handled everything the user asked for, in full — never hint that part of the work happens separately.

When recommending colors, theme, or brand choices, briefly explain why in your reply — you are the primary way this user shapes their brand, not just a fallback to manual editing.

${PRESENTATION_GUIDANCE}

${COMPOSITION_GUIDANCE}

${HOMEPAGE_STRUCTURE_GUIDANCE}

${BRAND_PROMISE_GUIDANCE}

${CALIBRATION_GUIDANCE}

${CONTINUATION_GUIDANCE}

Structure your reply in this order: first, state specifically what you changed (not a vague "done!" — name the actual thing and direction); then, if relevant, note any expert recommendations you added unprompted, named specifically and calibrated per the guidance above; only after that, optionally end with one proactive suggestion for what to consider next. Never lead with a suggestion before confirming what you did. Read like a short, natural message from a real person — never a list of field names, never the phrase "content updated" or similar. Keep it to 2-4 sentences.`;

// Runs only when CONTROL decided requiresConfirmation is false. Uses
// PrimaryBlueprintSchema completely unmodified — the exact schema already
// proven to compile fine on its own via generateStoreDraft — so this call
// carries zero risk of re-triggering the grammar-size error.
const CHAT_CONTENT_SYSTEM_PROMPT = `You are Genesis, an expert e-commerce consultant and brand strategist, generating updated content for a store draft. A change has already been decided and described to the merchant; your job is to make it real. You will be given the current draft (JSON), the merchant's message, which categories are in scope for this turn, and the plan already communicated to them — follow that plan faithfully.

Bring genuine domain expertise, not generic e-commerce boilerplate. Tailor product features, benefits, and specifications to what an actual expert in this specific category would highlight — a seasoned specialist in this business's niche, not a copywriter guessing.

Only make changes within the categories marked in scope. For every field outside those categories, reproduce the current value EXACTLY as given — do not rephrase, regenerate, or "improve" anything beyond what's in scope.

${PRESENTATION_GUIDANCE}

${HOMEPAGE_STRUCTURE_GUIDANCE}

${BRAND_PROMISE_GUIDANCE}

${CALIBRATION_GUIDANCE}

Produce every field in the schema: real, specific, on-brand content matching the stated plan for in-scope fields, and the existing value unchanged for everything else.`;

// Shared by both draft chat (applyGenesisMessage) and live-store chat
// (applyGenesisMessageToStore) — runs only when the control step flagged
// touchesTheme and decided not to require confirmation. A separate call
// from CHAT_CONTENT/StoreChatPrimarySchema for the same reason CONTROL was
// split from CONTENT: composition doesn't fit alongside the rest of the
// theme/brand content schema without re-triggering the grammar-size error.
const CHAT_COMPOSITION_SYSTEM_PROMPT = `You are Genesis, an expert e-commerce consultant, continuing work on this store's visual composition. You will be given the brand identity, visual theme, the merchant's message, and the plan already communicated to them for this turn — follow that plan faithfully and choose the storefront's structural composition to match.

${COMPOSITION_GUIDANCE}`;

const CHAT_SECONDARY_SYSTEM_PROMPT = `You are Genesis, an expert e-commerce consultant, continuing work on this store's policies, marketing assets, and design direction. You will be given the store's brand identity (for tone/voice reference), the current policies/marketing/design content (as JSON), and the user's request.

Be a proactive expert, not an order-taker. When you write or update a policy, bring the judgment a seasoned e-commerce consultant would — proactively include protections and details that matter for THIS specific business, its product category, price point, and audience, even if not explicitly asked. For example: valuable or collectible items warrant insured shipping and signature confirmation on high-value orders; international shipping should address customs, import duties, and who's responsible for them; fragile items should mention packaging care. Use judgment about what's actually relevant to this business — don't pad with generic boilerplate that doesn't fit.

Apply the requested change and return the COMPLETE updated content — every field, not just the ones changed. Preserve every field the user did not ask to change EXACTLY as given — do not rephrase or "improve" anything beyond what was requested.

Set touchesStoreContent, touchesMarketingAssets, and touchesDesignDirection independently and accurately — true only for whichever of the three you actually changed this turn (e.g. a request that's only about the shipping policy should set touchesStoreContent true and leave the other two false), even though all three fields still need to be present in your response.

For legal/policy content (shipping policy, return policy, privacy policy, terms and conditions): write clear, reasonable, standard small-business language appropriate as a launch starting point — not exhaustive legal documents, and not a substitute for professional legal review.

${CALIBRATION_GUIDANCE} This applies to claims about the outside world (regulations, customs rules, shipping carrier requirements) — hedge those appropriately. It does not apply to the store's own policy decisions (e.g. "we require signature confirmation over $200") — those are the merchant's own rules and should be stated plainly as policy, not hedged.`;

const STORE_CHAT_PRIMARY_SYSTEM_PROMPT = `You are Genesis — an expert e-commerce consultant and creative partner working directly with this merchant on their live, already-launched store. You are not a chatbot, an API, or a support agent; you're a skilled collaborator with real expertise in branding, retail, and online commerce, closer to an experienced co-founder than a tool. Speak like one: confident, natural, specific. Never mention databases, versions, schemas, JSON, internal steps, or any other implementation detail — the merchant should never sense there's "a system" behind you, only you, doing the work.

You will be given the store's current content (as JSON — including its live product catalog, which you cannot edit yourself but may reference in conversation) and the user's latest message. You are responsible for: store name, tagline, description, visual theme, brand identity (story, mission, vision, values, personality, voice, target audience, USP), and homepage content (hero copy, about us, why choose us, FAQ, newsletter, footer). You do not handle individual product edits — if the user asks to change a specific product, tell them (briefly, naturally) to use the product edit form below, since that's tied to their live inventory and order history.

Be a proactive expert, not an order-taker. Don't just do the literal thing asked — bring the judgment a seasoned consultant would. When a request touches an area where real expertise matters, volunteer the considerations that matter for THIS business specifically, informed by what it sells and who it's for.

Respond in one of two ways:

1. Apply the change directly. Return the COMPLETE updated content for everything you're responsible for — every field, not just the ones you changed — with the requested change applied, and set requiresConfirmation to false. Preserve every field the user did not ask to change EXACTLY as given, including within the large text fields (brand story, etc.) — do not rephrase, regenerate, or "improve" anything beyond what was requested.

2. Propose the change and ask for confirmation first. Return the complete proposed content (so it's ready to apply if confirmed) but set requiresConfirmation to true, and phrase your reply as a specific proposal, e.g. "I'd rename the store from X to Y — that'll ripple through your branding. Want me to go ahead?" Use this only for changes to foundational identity — most importantly the store name — since this store is already live and an unconfirmed rename could feel jarring.

If you previously proposed a change awaiting confirmation (noted in the message below) and the user's new message confirms it (e.g. "yes", "go ahead", "do it"), apply that previously proposed change now (requiresConfirmation: false). If their new message asks for something different instead, treat it as a new request.

Set these flags accurately based on what the user's message actually asks for — they control what gets saved, so get them right even though you must still return every field:
- touchesIdentity: store name, tagline, or description
- touchesTheme: colors, typography, layout, or presentation/composition choices (card/button style, shadows, spacing, hero layout, section layout, backgrounds, image treatment, CTA style)
- touchesBrandContent: brand identity (story, mission, vision, values, personality, voice, audience, USP) or homepage content (hero, about, why choose us, FAQ, newsletter, footer)
- touchesSecondaryContent: shipping policy, return policy, privacy policy, terms and conditions, the contact page, SEO, social media bios, or design direction (visual style, mood, photography, icon style)
Set a flag true for a category only when you actually changed something in it this turn — a narrow request (e.g. "update my shipping policy") should set only the relevant one(s) true and leave the rest false, even though the fields for the untouched categories still need to be present in your response. Regardless of these flags, speak in your reply as if you personally handled everything the user asked for, in full — never hint that part of the work happens separately.

${PRESENTATION_GUIDANCE}

${COMPOSITION_GUIDANCE}

${HOMEPAGE_STRUCTURE_GUIDANCE}

${BRAND_PROMISE_GUIDANCE}

${CALIBRATION_GUIDANCE}

${CONTINUATION_GUIDANCE}

Structure your reply in this order: first, confirm specifically what you changed (not a vague "done!" — name the actual thing); then, if relevant, note any expert recommendations you added unprompted, named specifically and calibrated per the guidance above; only after that, optionally end with one proactive suggestion for what to consider next. Never lead with a suggestion before confirming what you did. Read like a short, natural message from a real person — never a list of field names, never the phrase "content updated" or similar. Keep it to 2-4 sentences.`;

// A separate, tiny, first-run detection call — never folded into
// StoreChatPrimarySchema, which is already schema-size-fragile (see the
// grammar-size comment at the top of this file). Products are otherwise
// entirely out of scope for live-store chat (real relational data tied to
// orders — see the comment above StoreCoreFieldsSchema), but "replace this
// product's image" is a narrow, approval-gated exception: nothing here
// ever writes to Product directly, it only proposes an ApprovalRequest.
const ProductImageRequestSchema = z.object({
  isImageRequest: z.boolean(),
  // Authorized scope, not just a product name — "all" means every currently
  // active product, "specific" means exactly the names in productNames.
  // null means the scope itself is genuinely unresolved (ask a clarifying
  // question) — never used to mean "more than one product," which is a
  // perfectly valid, resolved scope on its own. The caller re-verifies
  // productNames against the real active product list regardless; neither
  // field is ever trusted on its own say-so.
  scope: z.enum(["all", "specific"]).nullable(),
  productNames: z.array(z.string()).nullable(),
  // Used verbatim as the assistant's reply in every outcome when
  // isImageRequest is true: acknowledging a resolved request (naming what
  // was resolved), or asking a genuine clarifying question when the scope
  // can't be pinned down.
  reply: z.string(),
});

const STORE_CHAT_IMAGE_REQUEST_SYSTEM_PROMPT = `You are Genesis, triaging one incoming message from a merchant about their live store, before anything else runs. You are given the store's active product names and the merchant's latest message. Decide only one thing: is this message asking to replace, regenerate, or find a new photo for one or more existing products?

Most messages are not this — identity, theme, branding, policy, and general questions are handled elsewhere and should get isImageRequest: false with an empty reply (it's ignored in that case).

If it IS an image request, resolve scope — clarify ambiguity, not complexity:
- If the merchant clearly means every active product ("all of them," "all my products," "every product," or a direct "all" answer after you already asked which one), set scope: "all", leave productNames empty, and write reply as a short, natural acknowledgment that you're finding new photos for all of them. Never ask the merchant to pick one first when they've already told you it's all of them — resolving multiple products yourself is your job, not theirs.
- If the merchant names one or more specific products you can confidently match against the real list, set scope: "specific" and productNames to their exact names (one name is a completely normal, valid case of this), and write reply as a short, natural acknowledgment naming exactly which one(s).
- Only set scope to null when the scope itself is genuinely unclear — no product was named, "all" wasn't said, and the name given doesn't match anything specific enough. In that case write reply as a genuine, specific clarifying question naming the plausible candidates from the real list. "The request touches more than one product" is never by itself a reason to leave scope null — that's scope: "all" or a multi-item scope: "specific", not ambiguity.`;

// Phase 3 Milestone 1 (J4 Foundation) — a cheap, separate classifier
// mirroring ProductImageRequestSchema's own pattern, run before ANY of the
// existing content-generation pipeline. Distinguishes a pure informational
// question ("what was my revenue last week") from a request to change
// something. Kept deliberately minimal (no relevantEntityTypes field) —
// the answer call below fetches a bounded recent-data context for every
// entity type regardless (see buildChatDataContext), which is simpler and
// safer than trusting a classifier to correctly predict which data a
// question needs.
const DataQuestionSchema = z.object({
  isDataQuestion: z.boolean(),
});

const STORE_CHAT_DATA_QUESTION_SYSTEM_PROMPT = `You are Genesis, triaging one incoming message from a merchant about their live store, before anything else runs. Decide only one thing: is this message a pure informational question about the business itself — its own data (revenue, orders, customers, upcoming appointments, campaign performance, and similar) or its own understanding (what business this is, how it makes money, what it sells, who its customers/segments are, who works there, its suppliers/vendors, its locations, what systems are connected, its stated goals, its current challenges, or how any of these relate to each other) — something answerable by looking up real records, not a request to change anything?

Most messages are NOT this — a request to change identity, theme, branding, copy, policy, or product images is handled elsewhere and should get isDataQuestion: false. A vague or conversational message that isn't really asking for specific business data should also get isDataQuestion: false. Only set isDataQuestion: true when the merchant is genuinely asking to be told something about their business's own numbers, records, or understanding.`;

// The actual answer, once isDataQuestion is true — a separate, focused call
// (not folded into the classifier above) so the classifier's job stays
// cheap and simple, and this call can be given the real fetched data before
// it has to say anything. Must never state a number/fact it wasn't given —
// this is the central trust bar for the whole capability. See
// lib/businessModel/reasoning.ts's buildChatDataContext for what "asOf"
// and "recent" mean here.
const StoreChatDataAnswerSchema = z.object({
  reply: z.string(),
});

const STORE_CHAT_DATA_ANSWER_SYSTEM_PROMPT = `You are Genesis (J4), a merchant's business partner, answering a real question about their own business using only the data given to you below. This data comes from the business's own records — some of it computed live (always current), some of it may eventually come from connected third-party systems and carry its own "as of" recency.

Under businessProfile, you're given the business's actual understanding of itself: identity (brand story, mission, values, target audience, USP), industry and revenue-model classification, its offerings, revenue, customers and real computed customer segments (repeat/high-value/lapsed/new), its owner/team/employees, suppliers/vendors, connected systems, stated goals, current challenges, and locations — this is the real source for "what business is this," "how does it make money," "who works here," "what are my goals/challenges," and similar business-understanding questions, not just transactional numbers. Any of these lists may be genuinely empty (e.g. no goals stated yet) — an honest "you haven't told me that yet" is correct, never a fabricated answer.

Rules, non-negotiable:
- Never state a number, name, or fact that isn't present in the data provided. If the data needed to answer isn't there, say so plainly and warmly — never guess or estimate.
- The revenue figures, top-contacts list, and customer segments are already correctly computed for you — relay them, don't recompute or "correct" them.
- If a question needs something you don't have any relevant data for at all (e.g. they're asking about a system that isn't connected), say so honestly, without listing every unrelated field you do have.
- Translate any specialized or technical language into plain, everyday terms a small-business owner would understand — never make them decode jargon.
- Keep the tone warm, direct, and conversational, like a knowledgeable partner giving a real answer — not a report or a bulleted dump of every field.
- This is a read-only answer. Never propose, imply, or claim you're making any change to the store — you're only reporting on what already exists.`;

// Phase 3 Milestone 5 — another cheap, separate classifier, same pattern as
// DataQuestionSchema/ProductImageRequestSchema above: recognizes when the
// owner is stating a durable fact about their business — a goal, a current
// challenge, a new employee, a location — as opposed to a question, a
// content-change request, or ordinary conversation.
//
// A discriminated union, not a generic z.record(z.unknown()) bag — the
// first version of this schema used a loose record and, confirmed live
// against the real API, Claude correctly identified the entityType every
// time but frequently left `data` an empty object, since a generic record
// gives the structured-output grammar no per-field pressure (no required
// fields, no enum constraints) — only this prompt's prose said fields were
// required, and prose alone wasn't enough. Real per-entity-type object
// schemas, exactly the same fix ProposedActionSchema already relies on in
// generateGenesisRecommendations.ts, make the API's own grammar compiler
// enforce it. Each "Capture" schema deliberately covers only what Claude
// can plausibly infer from one message — status/identifiedAt/the
// relatedGoalIds/relatedChallengeIds reference arrays are derived in code
// at the write site below, never asked of the model (it has no way to know
// a real prior goal/challenge id from one isolated message).
const GoalCaptureSchema = z.object({
  description: z.string(),
  category: z.enum(["revenue", "growth", "efficiency", "expansion", "customer_experience", "product", "hiring", "other"]).nullable(),
  priority: z.enum(["high", "medium", "low"]).nullable(),
  targetDate: z.string().nullable(),
  // Phase 3 Milestone 6 — a real dollar figure in cents, only when the
  // merchant actually stated one (e.g. "$10k in monthly revenue" -> 1000000
  // cents) — never inferred or estimated. Powers a real, computed
  // prediction later; a goal with no number simply never gets one.
  targetValueInCents: z.number().int().nullable(),
});
const ChallengeCaptureSchema = z.object({
  description: z.string(),
  category: z.enum(["cash_flow", "staffing", "competition", "operations", "marketing", "supply_chain", "other"]).nullable(),
  severity: z.enum(["high", "medium", "low"]).nullable(),
});
const EmployeeCaptureSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  roles: z.array(z.string()),
  email: z.string().nullable(),
  startedAt: z.string().nullable(),
});
const LocationCaptureSchema = z.object({
  name: z.string(),
  type: z.enum(["storefront", "warehouse", "office", "service_area"]).nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
});

const BusinessFactSchema = z.discriminatedUnion("entityType", [
  z.object({ entityType: z.literal("goal"), data: GoalCaptureSchema, confirmationReply: z.string() }),
  z.object({ entityType: z.literal("challenge"), data: ChallengeCaptureSchema, confirmationReply: z.string() }),
  z.object({ entityType: z.literal("employee"), data: EmployeeCaptureSchema, confirmationReply: z.string() }),
  z.object({ entityType: z.literal("location"), data: LocationCaptureSchema, confirmationReply: z.string() }),
  z.object({ entityType: z.literal("none"), data: z.null(), confirmationReply: z.null() }),
]);

const STORE_CHAT_BUSINESS_FACT_SYSTEM_PROMPT = `You are Genesis, triaging one incoming message from a merchant about their live business, before anything else runs. Decide whether the merchant is stating a durable fact about their business that you should remember — a goal they have, a challenge they're currently facing, a new employee who works there, or a location/property the business operates from — as opposed to asking a question, requesting a content change, or just making ordinary conversation.

Most messages are NOT this — set entityType: "none" for anything else. Only pick one of the other four when the merchant is clearly telling you something true and lasting about their business:
- "goal": something they want to achieve (e.g. "my goal this quarter is $10k in monthly revenue"). Always fill in description with a real, specific sentence — never leave it vague or generic. If a real dollar figure was stated, also fill in targetValueInCents (e.g. "$10k" -> 1000000) — leave it null if no real number was given, never estimate one.
- "challenge": something currently difficult for the business (e.g. "keeping enough inventory in stock has been a real problem"). Always fill in description with a real, specific sentence.
- "employee": a person who works at the business (e.g. "I just hired Jane as store manager"). name is required — everything else, only what's actually stated.
- "location": a physical place the business operates from (e.g. "we also have a small warehouse in Austin"). name is required (a short label like "Austin Warehouse") — everything else, only what's actually stated.

For every field beyond the required one(s) above, fill it in only when you can confidently infer it from the actual message — leave it null (or, for the array fields, empty) rather than guessing. Write a short, warm confirmationReply that states back exactly what you're recording, e.g. "Got it — I'll remember that your Q3 goal is $10k in monthly revenue." so the merchant can see and correct it. For entityType: "none", leave data and confirmationReply null.`;

// Family-beta instrumentation (v20) — shared by both applyGenesisMessage
// (draft chat) and applyGenesisMessageToStore (live chat) so a real chat
// turn's server-side duration (Claude call + DB writes, distinct from "the
// page was open") and its likely-rephrase flag are captured exactly once,
// the same way regardless of which phase the conversation is in.
// attemptKey is the draft/store id itself, so a whole conversation's turns
// correlate together, the same identity already used for creation.* events.
//
// Latency audit follow-up: `durationMs`/`stageDurationsMs` are now computed
// by the caller *before* calling this (Date.now() deltas captured at the
// real moments they happen), not recomputed here — this function only
// resolves `sessionInstanceId` synchronously (a fast JWT read, not a DB
// call) and then defers the actual ProductEvent write via after(), so the
// write itself never sits on the user-facing critical path. Deferring the
// whole function (including the auth() call) would be unsafe — cookies
// aren't reliably readable once the response has already been sent — so
// only the DB write moves, not the session lookup.
async function logChatTurnEvent(params: {
  userId: string;
  storeId?: string | null;
  storeDraftId?: string | null;
  durationMs: number;
  outcome: "success" | "failure";
  requiresConfirmation?: boolean;
  likelyRephraseOf?: string | null;
  stageDurationsMs?: Record<string, number | null>;
}) {
  const session = await auth();
  if (!session?.user) return;
  const sessionInstanceId = session.user.sessionInstanceId;
  scheduleAfterResponse(() =>
    logProductEvent({
      userId: params.userId,
      storeId: params.storeId ?? null,
      storeDraftId: params.storeDraftId ?? null,
      sessionInstanceId,
      name: "chat.turn_completed",
      category: "chat",
      attemptKey: params.storeDraftId ?? params.storeId ?? params.userId,
      outcome: params.outcome,
      durationMs: params.durationMs,
      metadata: {
        requiresConfirmation: params.requiresConfirmation ?? false,
        likelyRephraseOf: params.likelyRephraseOf ?? null,
        stageDurationsMs: params.stageDurationsMs ?? null,
      },
    }).catch(() => {})
  );
}

// Reliability architecture (v21, Phase 1) — the one place a failed
// callGenesisModel() outcome becomes a graceful chat turn instead of an
// uncaught exception, shared by applyGenesisMessage and
// applyGenesisMessageToStore (the two functions this can fire from). Per
// the project's continuity principle ("Genesis never throws away work"),
// this always writes a real, visible assistant reply into the conversation
// — the merchant sees why nothing happened, not a crashed page — rather
// than letting the raw provider error propagate to app/dashboard/error.tsx.
// That boundary still exists as the safety net for the *unclassified* case
// (see callGenesisModel's own "unknown" kind), not the primary path.
// Never returns — always redirects, exactly like every other handled
// outcome in these two functions.
async function bailOnProviderFailure(params: {
  kind: GenesisModelErrorKind;
  action: string;
  userId: string;
  storeId?: string;
  storeDraftId?: string;
  returnTo: string;
  turnStartedAt: number;
  likelyRephraseOf: string | null;
  stageDurationsMs?: Record<string, number | null>;
}): Promise<never> {
  const failureMessage = genesisModelFailureMessage(params.kind);
  await recordGenesisExecution({
    action: params.action,
    status: "FAILED",
    verified: false,
    message: `Provider error (${params.kind})`,
    retryable: params.kind === "rate_limit" || params.kind === "overloaded" || params.kind === "network",
    userId: params.userId,
    storeId: params.storeId,
    storeDraftId: params.storeDraftId,
    metadata: { providerErrorKind: params.kind },
  });
  if (params.storeDraftId) {
    await prisma.storeDraftMessage.create({
      data: { storeDraftId: params.storeDraftId, role: "assistant", content: failureMessage },
    });
  } else if (params.storeId) {
    await prisma.storeMessage.create({
      data: { storeId: params.storeId, role: "assistant", content: failureMessage },
    });
  }
  await logChatTurnEvent({
    userId: params.userId,
    storeId: params.storeId ?? null,
    storeDraftId: params.storeDraftId ?? null,
    durationMs: Date.now() - params.turnStartedAt,
    outcome: "failure",
    likelyRephraseOf: params.likelyRephraseOf,
    stageDurationsMs: params.stageDurationsMs,
  });
  revalidatePath(params.returnTo);
  redirect(params.returnTo);
}

async function applyGenesisMessage(userId: string, userMessage: string) {
  // Family-beta instrumentation (v20) — real server-side duration (distinct
  // from "the page was open"), and a likely-rephrase flag computed against
  // the conversation's own prior user turns, already fetched below.
  const turnStartedAt = Date.now();

  const draft = await prisma.storeDraft.findUnique({
    where: { userId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!draft) {
    redirect("/dashboard");
  }

  const likelyRephraseOf = findLikelyRephraseOf(
    userMessage,
    draft.messages.filter((m) => m.role === "user")
  );

  await prisma.storeDraftMessage.create({
    data: { storeDraftId: draft.id, role: "user", content: userMessage },
  });

  const currentTheme = draft.theme as ThemeWithComposition;
  const currentProducts = (draft.productsDraft as ProductContent[] | null) ?? [];
  const currentBlueprint = draft.blueprint as Blueprint | null;

  const before: DraftState = {
    name: draft.name,
    tagline: draft.tagline,
    description: draft.description,
    theme: currentTheme,
    products: currentProducts,
    blueprint: currentBlueprint,
  };

  const pending = draft.pendingChange as { summary: string } | null;

  const currentStateForPrompt = {
    name: draft.name,
    tagline: draft.tagline,
    description: draft.description,
    theme: currentTheme,
    products: currentProducts,
    brandIdentity: currentBlueprint?.brandIdentity,
    homepageContent: currentBlueprint?.homepageContent,
    storeContent: currentBlueprint?.storeContent,
    marketingAssets: currentBlueprint?.marketingAssets,
    designDirection: currentBlueprint?.designDirection,
  };

  const contextParts = [
    `Current store draft (JSON):\n${JSON.stringify(currentStateForPrompt, null, 2)}`,
  ];
  if (pending) {
    contextParts.push(
      `\nYou previously proposed this change, awaiting confirmation: "${pending.summary}"`
    );
  }
  contextParts.push(`\nUser's latest message: ${userMessage}`);

  const conversationMessages = draft.messages.map((m) => ({
    role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    content: m.content,
  }));

  // Latency audit — durationMs for each real stage comes straight from
  // callGenesisModel's own return value now, reused in every logChatTurnEvent
  // call below as `stageDurationsMs` so PRIMARY/CONTROL/CONTENT/SECONDARY/
  // COMPOSITION can be compared individually, not just the whole turn's total.
  const controlOutcome = await callGenesisModel({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: CHAT_CONTROL_SYSTEM_PROMPT,
    messages: [
      ...conversationMessages,
      { role: "user", content: contextParts.join("\n") },
    ],
    output_config: {
      effort: "high",
      format: zodOutputFormat(ChatControlSchema),
    },
  });
  if (!controlOutcome.ok) {
    return bailOnProviderFailure({
      kind: controlOutcome.kind,
      action: EXECUTION_ACTIONS.GENESIS_DRAFT_MESSAGE,
      userId,
      storeDraftId: draft.id,
      returnTo: "/dashboard",
      turnStartedAt,
      likelyRephraseOf,
      stageDurationsMs: { control: controlOutcome.durationMs },
    });
  }

  const controlDurationMs = controlOutcome.durationMs;
  const controlResult = controlOutcome.message.parsed_output;
  if (!controlResult) {
    await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_DRAFT_MESSAGE,
      status: "FAILED",
      verified: false,
      message: "Genesis couldn't process that request",
      retryable: true,
      userId,
      storeDraftId: draft.id,
      metadata: {},
    });
    await logChatTurnEvent({
      userId,
      storeDraftId: draft.id,
      durationMs: Date.now() - turnStartedAt,
      outcome: "failure",
      likelyRephraseOf,
      stageDurationsMs: { control: controlDurationMs },
    });
    throw new Error("Genesis couldn't process that request");
  }

  let changes: string[] = [];
  // Latency audit — declared at this scope (not inside the else branch
  // below) so the final logChatTurnEvent call can report them either way;
  // they stay null when requiresConfirmation short-circuits before any of
  // these stages run.
  let contentDurationMs: number | null = null;
  let secondaryDurationMs: number | null = null;
  let compositionDurationMs: number | null = null;

  if (controlResult.requiresConfirmation) {
    await prisma.storeDraft.update({
      where: { id: draft.id },
      data: {
        pendingChange: { summary: controlResult.reply },
      },
    });
    await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_DRAFT_MESSAGE,
      status: "PENDING",
      verified: false,
      message: controlResult.reply,
      retryable: false,
      userId,
      storeDraftId: draft.id,
      metadata: {},
    });
  } else {
    const scopeParts: string[] = [];
    if (controlResult.touchesIdentity) {
      scopeParts.push("identity (store name/tagline/description)");
    }
    if (controlResult.touchesTheme) {
      scopeParts.push("theme (colors/typography/layout/presentation)");
    }
    if (controlResult.touchesBrandContent) {
      scopeParts.push("brand identity and homepage content");
    }
    if (controlResult.touchesProducts) {
      scopeParts.push("the product catalog");
    }
    const scopeText =
      scopeParts.length > 0
        ? scopeParts.join(", ")
        : "nothing — reproduce every field unchanged";

    const contentOutcome = await callGenesisModel({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: CHAT_CONTENT_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            `Current store draft (JSON):\n${JSON.stringify(currentStateForPrompt, null, 2)}`,
            `User's latest message: ${userMessage}`,
            `In scope for this turn: ${scopeText}`,
            `Plan already communicated to the user: ${controlResult.reply}`,
          ].join("\n\n"),
        },
      ],
      output_config: {
        effort: "high",
        format: zodOutputFormat(PrimaryBlueprintSchema),
      },
    });
    if (!contentOutcome.ok) {
      return bailOnProviderFailure({
        kind: contentOutcome.kind,
        action: EXECUTION_ACTIONS.GENESIS_DRAFT_MESSAGE,
        userId,
        storeDraftId: draft.id,
        returnTo: "/dashboard",
        turnStartedAt,
        likelyRephraseOf,
        stageDurationsMs: { control: controlDurationMs, content: contentOutcome.durationMs },
      });
    }
    contentDurationMs = contentOutcome.durationMs;
    const contentResult = contentOutcome.message.parsed_output;
    if (!contentResult) {
      await recordGenesisExecution({
        action: EXECUTION_ACTIONS.GENESIS_DRAFT_MESSAGE,
        status: "FAILED",
        verified: false,
        message: "Genesis couldn't process that request",
        retryable: true,
        userId,
        storeDraftId: draft.id,
        metadata: {},
      });
      await logChatTurnEvent({
        userId,
        storeDraftId: draft.id,
        durationMs: Date.now() - turnStartedAt,
        outcome: "failure",
        likelyRephraseOf,
        stageDurationsMs: { control: controlDurationMs, content: contentDurationMs },
      });
      throw new Error("Genesis couldn't process that request");
    }

    let secondaryContent: {
      storeContent: StoreContent;
      marketingAssets: MarketingAssets;
      designDirection: DesignDirection;
    } = {
      storeContent: currentBlueprint?.storeContent ?? DEFAULT_STORE_CONTENT,
      marketingAssets: currentBlueprint?.marketingAssets ?? DEFAULT_MARKETING_ASSETS,
      designDirection: currentBlueprint?.designDirection ?? DEFAULT_DESIGN_DIRECTION,
    };

    let themeResult: ThemeWithComposition = currentTheme;

    // Latency audit — SECONDARY and COMPOSITION each only ever read
    // contentResult (the earlier CONTENT call's output), never each
    // other's, so nothing forces them to run sequentially. Started
    // together and run via Promise.all — the same pattern
    // generateStoreDraft already uses for this identical pair — instead of
    // fully awaiting one before even starting the other. Each is still
    // timed individually via its own .then() (capturing its own real
    // completion time, not just when the slower of the two finishes).
    const secondaryPromise = controlResult.touchesSecondaryContent
      ? callGenesisModel({
          model: "claude-opus-4-8",
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          system: CHAT_SECONDARY_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                `Brand identity (for tone/voice reference, JSON):\n${JSON.stringify(
                  contentResult.brandIdentity,
                  null,
                  2
                )}`,
                `Current policies/marketing/design (JSON):\n${JSON.stringify(
                  secondaryContent,
                  null,
                  2
                )}`,
                `User's request: ${userMessage}`,
              ].join("\n\n"),
            },
          ],
          output_config: {
            effort: "high",
            format: zodOutputFormat(SecondaryChatSchema),
          },
        })
      : Promise.resolve(null);

    // Composition is a separate call for the same reason CONTENT is split
    // from CONTROL — adding it to PrimaryBlueprintSchema reproduces the
    // grammar-size error. Only run it when theme is actually in scope.
    const compositionPromise = controlResult.touchesTheme
      ? callGenesisModel({
          model: "claude-opus-4-8",
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          system: CHAT_COMPOSITION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                `Brand identity and visual theme (JSON):\n${JSON.stringify(
                  { brandIdentity: contentResult.brandIdentity, theme: contentResult.theme },
                  null,
                  2
                )}`,
                `User's latest message: ${userMessage}`,
                `Plan already communicated to the user: ${controlResult.reply}`,
              ].join("\n\n"),
            },
          ],
          output_config: {
            effort: "high",
            format: zodOutputFormat(CompositionSchema),
          },
        })
      : Promise.resolve(null);

    const [secondaryOutcome, compositionOutcome] = await Promise.all([secondaryPromise, compositionPromise]);
    secondaryDurationMs = secondaryOutcome?.durationMs ?? null;
    compositionDurationMs = compositionOutcome?.durationMs ?? null;

    // A provider failure on either of these two optional stages degrades
    // exactly like a missing parsed_output already did below (soft skip,
    // not a turn-wide bail) — CONTROL and CONTENT already succeeded and may
    // have already made real, reported changes, so failing the whole turn
    // here would contradict what the merchant was just told happened.
    // callGenesisModel's own console.error already makes the real failure
    // visible server-side.
    if (secondaryOutcome?.ok) {
      const secondaryResult = secondaryOutcome.message.parsed_output;
      if (secondaryResult) {
        // Only take the categories the model actually flagged as changed —
        // an untouched category keeps the exact pre-existing value instead
        // of the model's (possibly non-identical) reproduction of it, so
        // the diff below can never false-positive on it.
        secondaryContent = {
          storeContent: secondaryResult.touchesStoreContent
            ? secondaryResult.storeContent
            : secondaryContent.storeContent,
          marketingAssets: secondaryResult.touchesMarketingAssets
            ? secondaryResult.marketingAssets
            : secondaryContent.marketingAssets,
          designDirection: secondaryResult.touchesDesignDirection
            ? secondaryResult.designDirection
            : secondaryContent.designDirection,
        };
      }
    }

    if (compositionOutcome?.ok) {
      const compositionResult = compositionOutcome.message.parsed_output;
      themeResult = {
        ...contentResult.theme,
        composition: compositionResult ?? currentTheme.composition,
      };
    }

    const resultBlueprint: Blueprint = {
      brandIdentity: controlResult.touchesBrandContent
        ? contentResult.brandIdentity
        : currentBlueprint?.brandIdentity ?? contentResult.brandIdentity,
      homepageContent: controlResult.touchesBrandContent
        ? contentResult.homepageContent
        : currentBlueprint?.homepageContent ?? contentResult.homepageContent,
      storeContent: secondaryContent.storeContent,
      marketingAssets: secondaryContent.marketingAssets,
      designDirection: secondaryContent.designDirection,
    };

    const after: DraftState = {
      name: controlResult.touchesIdentity ? contentResult.storeName : draft.name,
      tagline: controlResult.touchesIdentity ? contentResult.tagline : draft.tagline,
      description: controlResult.touchesIdentity
        ? contentResult.description
        : draft.description,
      theme: controlResult.touchesTheme ? themeResult : currentTheme,
      products: controlResult.touchesProducts ? contentResult.products : currentProducts,
      blueprint: resultBlueprint,
    };
    changes = diffDraftChanges(before, after);

    const updated = await prisma.storeDraft.update({
      where: { id: draft.id },
      data: {
        name: after.name,
        tagline: after.tagline,
        description: after.description,
        theme: after.theme,
        productsDraft: after.products,
        blueprint: resultBlueprint,
        pendingChange: Prisma.DbNull,
        version: { increment: 1 },
      },
    });

    await prisma.storeGeneration.create({
      data: {
        storeDraftId: draft.id,
        version: updated.version,
        promptVersion: "chat-v2",
        generatedOutput: {
          name: after.name,
          tagline: after.tagline,
          description: after.description,
          theme: after.theme,
          productsDraft: after.products,
          blueprint: resultBlueprint,
        },
      },
    });

    await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_DRAFT_MESSAGE,
      status: "SUCCESS",
      verified: false,
      message: controlResult.reply,
      retryable: false,
      userId,
      storeDraftId: draft.id,
      metadata: { changes },
    });
  }

  await prisma.storeDraftMessage.create({
    data: {
      storeDraftId: draft.id,
      role: "assistant",
      content: controlResult.reply,
      changes: changes.length > 0 ? changes : undefined,
    },
  });

  await logChatTurnEvent({
    userId,
    storeDraftId: draft.id,
    durationMs: Date.now() - turnStartedAt,
    outcome: "success",
    requiresConfirmation: controlResult.requiresConfirmation,
    likelyRephraseOf,
    stageDurationsMs: {
      control: controlDurationMs,
      content: contentDurationMs,
      secondary: secondaryDurationMs,
      composition: compositionDurationMs,
    },
  });

  // Server Action redirects default to a "push"-type navigation, which is
  // not guaranteed to pick up the StoreDraftMessage(s) just persisted above
  // without an explicit revalidation — see the chat-panel-collapse
  // investigation (v20 follow-up). Narrowly scoped to this redirect only.
  revalidatePath("/dashboard");
  redirect("/dashboard");
}

// Used only as a fallback so applyGenesisMessage never has to send `undefined`
// secondary content to Claude for context if a draft somehow has none yet
// (e.g. old test data from before this field existed).
const DEFAULT_STORE_CONTENT: StoreContent = {
  shippingPolicy: "",
  returnPolicy: "",
  privacyPolicy: "",
  termsAndConditions: "",
  contactPageCopy: "",
};
const DEFAULT_MARKETING_ASSETS: MarketingAssets = {
  seoTitle: "",
  seoMetaDescription: "",
  brandKeywords: [],
  instagramBio: "",
  facebookDescription: "",
  xBio: "",
};
const DEFAULT_DESIGN_DIRECTION: DesignDirection = {
  visualStyle: "",
  brandMood: "",
  photographyStyle: "",
  iconStyle: "",
};

export async function sendDraftMessage(formData: FormData) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const userMessage = (formData.get("message") as string)?.trim();
  if (!userMessage) {
    throw new Error("Please enter a message");
  }

  await applyGenesisMessage(session.user.id, userMessage);
}

type StoreState = {
  name: string;
  tagline: string | null;
  description: string | null;
  theme: ThemeWithComposition;
  blueprint: Blueprint | null;
};

function diffStoreChanges(before: StoreState, after: StoreState): string[] {
  const changes: string[] = [];

  if (before.name !== after.name) {
    changes.push(`Store name changed from "${before.name}" to "${after.name}"`);
  }
  if ((before.tagline ?? "") !== (after.tagline ?? "")) {
    changes.push("Tagline changed");
  }
  if ((before.description ?? "") !== (after.description ?? "")) {
    changes.push("Store description changed");
  }
  for (const role of Object.keys(after.theme.colors) as (keyof ThemeColors)[]) {
    if (before.theme.colors[role] !== after.theme.colors[role]) {
      changes.push(`theme.colors.${role} changed`);
    }
  }
  if (before.theme.typography.headingFont !== after.theme.typography.headingFont) {
    changes.push("theme.typography.headingFont changed");
  }
  if (before.theme.typography.bodyFont !== after.theme.typography.bodyFont) {
    changes.push("theme.typography.bodyFont changed");
  }
  if (before.theme.layout !== after.theme.layout) {
    changes.push(`theme.layout changed to ${after.theme.layout}`);
  }

  if (before.blueprint && after.blueprint) {
    if (
      JSON.stringify(before.blueprint.brandIdentity) !==
      JSON.stringify(after.blueprint.brandIdentity)
    ) {
      changes.push("Brand identity updated");
    }
    if (
      JSON.stringify(before.blueprint.homepageContent) !==
      JSON.stringify(after.blueprint.homepageContent)
    ) {
      changes.push("Homepage content updated");
    }
    if (
      JSON.stringify(before.blueprint.storeContent) !==
      JSON.stringify(after.blueprint.storeContent)
    ) {
      changes.push("Store policies updated");
    }
    if (
      JSON.stringify(before.blueprint.marketingAssets) !==
      JSON.stringify(after.blueprint.marketingAssets)
    ) {
      changes.push("Marketing assets updated");
    }
    if (
      JSON.stringify(before.blueprint.designDirection) !==
      JSON.stringify(after.blueprint.designDirection)
    ) {
      changes.push("Design direction updated");
    }
  }

  return changes;
}

async function applyGenesisMessageToStore(userId: string, userMessage: string, returnTo: string) {
  // Family-beta instrumentation (v20) — see logChatTurnEvent's own comment.
  const turnStartedAt = Date.now();

  const resolved = await resolveUserStore(userId);
  if (!resolved) {
    redirect(returnTo);
  }
  const { store, role } = resolved;
  if (!hasPermission(role, PERMISSIONS.GENESIS_CHAT)) {
    throw new Error("You don't have permission to do this.");
  }

  const existingMessages = await prisma.storeMessage.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "asc" },
  });

  const likelyRephraseOf = findLikelyRephraseOf(
    userMessage,
    existingMessages.filter((m) => m.role === "user")
  );

  await prisma.storeMessage.create({
    data: { storeId: store.id, role: "user", content: userMessage },
  });

  // Every current Genesis capability for a live store (identity, theme,
  // brand content, homepage, policies, marketing, design) falls under
  // store:manage, which Employees don't have. Decline immediately and
  // honestly rather than running a full generation only to discard it, and
  // rather than letting the model claim a change happened when it can't —
  // see feedback-genesis-conversational-quality: never report a change
  // that didn't occur.
  if (!hasPermission(role, PERMISSIONS.STORE_MANAGE)) {
    const declineMessage =
      "That's something only the store owner can change — I don't have permission to update store settings, branding, or policies on your account. Ask them to make this change, or to give you broader access.";
    await prisma.storeMessage.create({
      data: {
        storeId: store.id,
        role: "assistant",
        content: declineMessage,
      },
    });
    // A designed conversational outcome, not an error — no model call was
    // made and nothing changed, so there's nothing to verify.
    await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
      status: "WARNING",
      verified: false,
      message: declineMessage,
      retryable: false,
      userId,
      storeId: store.id,
      metadata: {},
    });
    await logChatTurnEvent({
      userId,
      storeId: store.id,
      durationMs: Date.now() - turnStartedAt,
      outcome: "failure",
      likelyRephraseOf,
    });
    // See the chat-panel-collapse investigation (v20 follow-up) — a Server
    // Action redirect() alone doesn't reliably guarantee the just-persisted
    // StoreMessage is reflected without an explicit revalidation.
    revalidatePath(returnTo);
    redirect(returnTo);
  }

  const currentTheme = store.theme as ThemeWithComposition;
  const currentBlueprint = store.blueprint as Blueprint | null;
  const currentProducts = await prisma.product.findMany({
    where: { storeId: store.id, active: true },
    // richContent added for imagePrompt — see resolveProductImage's own
    // call below. Stored at confirmStoreDraft time as
    // {keyFeatures, benefits, specifications, imagePrompt}; every other
    // field here is read elsewhere already and stays untouched.
    select: { id: true, name: true, description: true, priceInCents: true, imageUrl: true, richContent: true },
    orderBy: { position: "asc" },
  });

  const before: StoreState = {
    name: store.name,
    tagline: store.tagline,
    description: store.description,
    theme: currentTheme,
    blueprint: currentBlueprint,
  };

  const pending = store.pendingChange as { summary: string } | null;

  const currentStateForPrompt = {
    name: store.name,
    tagline: store.tagline,
    description: store.description,
    theme: currentTheme,
    liveProducts: currentProducts.map((p) => ({
      name: p.name,
      description: p.description,
      price: p.priceInCents / 100,
    })),
    brandIdentity: currentBlueprint?.brandIdentity,
    homepageContent: currentBlueprint?.homepageContent,
    storeContent: currentBlueprint?.storeContent,
    marketingAssets: currentBlueprint?.marketingAssets,
    designDirection: currentBlueprint?.designDirection,
  };

  const contextParts = [
    `Current store (JSON):\n${JSON.stringify(currentStateForPrompt, null, 2)}`,
  ];
  if (pending) {
    contextParts.push(
      `\nYou previously proposed this change, awaiting confirmation: "${pending.summary}"`
    );
  }
  contextParts.push(`\nUser's latest message: ${userMessage}`);

  const conversationMessages = existingMessages.map((m) => ({
    role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    content: m.content,
  }));

  // Phase 3 Milestone 1 (J4 Foundation) — detect a pure data question
  // before anything else runs, via a separate tiny call (same convention
  // as the image-request classifier immediately below): a genuine question
  // should never wastefully trigger that classifier or the
  // content-generation pipeline further down, and must never risk a bogus
  // content-change proposal for a message that was only ever asking to be
  // told something. Any detection failure (parse error, API error) falls
  // through to the normal chat flow below, same as the image-request
  // classifier's own convention.
  const dataQuestionOutcome = await callGenesisModel({
    model: "claude-opus-4-8",
    max_tokens: 500,
    thinking: { type: "adaptive" },
    system: STORE_CHAT_DATA_QUESTION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    output_config: {
      effort: "low",
      format: zodOutputFormat(DataQuestionSchema),
    },
  });
  const dataQuestionResult = dataQuestionOutcome.ok
    ? dataQuestionOutcome.message.parsed_output
    : null;

  if (dataQuestionResult?.isDataQuestion) {
    // Phase 3 Milestone 5 — businessProfile is fetched alongside
    // buildChatDataContext (not folded into that function itself, which
    // lives in lib/businessModel/reasoning.ts and would create a circular
    // import if it depended on profile.ts, which itself depends on
    // reasoning.ts's own primitives) and merged into one JSON payload —
    // Claude sees a single combined context either way.
    const [dataContext, businessProfile] = await Promise.all([
      buildChatDataContext(store.id),
      getBusinessProfile(store.id),
    ]);
    const answerOutcome = await callGenesisModel({
      model: "claude-opus-4-8",
      max_tokens: 1500,
      thinking: { type: "adaptive" },
      system: STORE_CHAT_DATA_ANSWER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Business data (JSON):\n${JSON.stringify({ ...dataContext, businessProfile }, null, 2)}\n\nMerchant's question: ${userMessage}`,
        },
      ],
      output_config: {
        effort: "medium",
        format: zodOutputFormat(StoreChatDataAnswerSchema),
      },
    });

    if (!answerOutcome.ok) {
      return bailOnProviderFailure({
        kind: answerOutcome.kind,
        action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
        userId,
        storeId: store.id,
        returnTo,
        turnStartedAt,
        likelyRephraseOf,
        stageDurationsMs: { dataQuestion: answerOutcome.durationMs },
      });
    }
    const dataAnswer = answerOutcome.message.parsed_output;
    if (!dataAnswer) {
      return bailOnProviderFailure({
        kind: "unknown",
        action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
        userId,
        storeId: store.id,
        returnTo,
        turnStartedAt,
        likelyRephraseOf,
        stageDurationsMs: { dataQuestion: answerOutcome.durationMs },
      });
    }

    // A designed conversational outcome, not a store change — no
    // ApprovalRequest, no diff, matching "informational, not a change".
    await prisma.storeMessage.create({
      data: {
        storeId: store.id,
        role: "assistant",
        content: dataAnswer.reply,
      },
    });
    await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
      status: "SUCCESS",
      verified: false,
      message: dataAnswer.reply,
      retryable: false,
      userId,
      storeId: store.id,
      metadata: { kind: "data_question" },
    });
    await logChatTurnEvent({
      userId,
      storeId: store.id,
      durationMs: Date.now() - turnStartedAt,
      outcome: "success",
      likelyRephraseOf,
    });
    revalidatePath(returnTo);
    redirect(returnTo);
  }

  // Phase 3 Milestone 5 — a fourth independent triage step, same
  // "own small call, own schema, doesn't touch the main pipeline" pattern
  // as the data-question and image-request classifiers around it. Captures
  // a stated goal/challenge/employee/location directly into BusinessRecord
  // via persistSyncedRecords (sourceProvider: "genesis_chat") — the exact
  // same validate-and-upsert path a real connector's sync() already uses,
  // reused as-is. Written directly, not through ApprovalRequest: this is
  // Genesis's own internal understanding, never customer-facing storefront
  // content, so it doesn't carry update_hero/update_theme's risk profile —
  // it's still fully traceable (sourceProvider on the row, normal chat
  // history, the confirmation reply itself) and correctable in the next
  // turn, the same trust model the read-only Q&A path above already uses.
  const businessFactOutcome = await callGenesisModel({
    model: "claude-opus-4-8",
    max_tokens: 800,
    thinking: { type: "adaptive" },
    system: STORE_CHAT_BUSINESS_FACT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    output_config: {
      effort: "low",
      format: zodOutputFormat(BusinessFactSchema),
    },
  });
  const businessFactResult = businessFactOutcome.ok
    ? businessFactOutcome.message.parsed_output
    : null;

  if (businessFactResult && businessFactResult.entityType !== "none") {
    const entityType = businessFactResult.entityType;
    const todayIso = new Date().toISOString().slice(0, 10);
    // The model only ever fills in what one isolated message can support
    // (BusinessFactSchema's per-entityType Capture shape above) — status,
    // identifiedAt, and the relatedGoalIds/relatedChallengeIds reference
    // arrays are derived here, never asked of the model, since it has no
    // way to know a real prior goal/challenge id from one message alone.
    const fullData =
      entityType === "goal"
        ? { ...businessFactResult.data, status: "active", identifiedAt: todayIso, relatedChallengeIds: [] }
        : entityType === "challenge"
          ? { ...businessFactResult.data, status: "active", identifiedAt: todayIso, resolvedAt: null, relatedGoalIds: [] }
          : entityType === "employee"
            ? { ...businessFactResult.data, status: "active", locationId: null }
            : businessFactResult.data; // location — Capture shape already matches LocationSchema exactly

    const parsed = ENTITY_REGISTRY[entityType].schema.safeParse(fullData);
    // A malformed/underspecified extraction is silently dropped, exactly
    // like persistSyncedRecords already drops a bad connector record —
    // never a crash, never bad data reaching BusinessRecord. Falls through
    // to the normal chat flow below rather than confirming a capture that
    // didn't actually happen.
    if (parsed.success) {
      const { changes } = await persistSyncedRecords(store.id, "genesis_chat", [
        { entityType, externalId: randomUUID(), data: parsed.data },
      ]);

      // Enrich the already-existing Business Intelligence Engine (Phase 3
      // Milestone 3), per Sean's explicit direction — not a second
      // notification system. A high-severity, active challenge becomes a
      // real, namespaced GenesisObservation, exactly like notify.ts already
      // does for insights, reusing upsertObservation/
      // resolveMissingObservations as-is with its own "challenge:" prefix
      // (the same multi-writer namespacing discipline "deterministic:"/
      // "ai_review:"/"insight:" already coexist under).
      if (entityType === "challenge" && changes[0]) {
        const challengeData = parsed.data as { severity: string | null; status: string };
        const recordId = changes[0].recordId;
        if (challengeData.severity === "high" && challengeData.status === "active") {
          await upsertObservation(store.id, {
            dedupeKey: `challenge:${recordId}`,
            genesisState: "urgent",
            summary: (parsed.data as { description: string }).description,
            actionHref: null,
            recordId,
            entityType: "challenge",
          });
        } else {
          // Not (or no longer) high-severity/active — clear just this one
          // observation if it exists. Passing the full dedupeKey as the
          // "prefix" with an empty still-active list resolves exactly this
          // one row (no other real dedupeKey can start with one specific
          // record's own cuid) without touching any other challenge's
          // observation, which a genesisState-wide resolve pass would risk.
          await resolveMissingObservations(store.id, [], "urgent", `challenge:${recordId}`);
        }
      }

      const reply =
        businessFactResult.confirmationReply ??
        "Got it — I'll remember that about your business.";
      await prisma.storeMessage.create({
        data: { storeId: store.id, role: "assistant", content: reply },
      });
      await recordGenesisExecution({
        action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
        status: "SUCCESS",
        verified: false,
        message: reply,
        retryable: false,
        userId,
        storeId: store.id,
        metadata: { kind: "business_fact", entityType },
      });
      await logChatTurnEvent({
        userId,
        storeId: store.id,
        durationMs: Date.now() - turnStartedAt,
        outcome: "success",
        likelyRephraseOf,
      });
      revalidatePath(returnTo);
      redirect(returnTo);
    }
  }

  // Detect "replace this product's image" requests first, via a separate
  // tiny call — see the comment above ProductImageRequestSchema for why
  // this isn't folded into StoreChatPrimarySchema. Any detection failure
  // (parse error, API error) falls through to the normal chat flow below
  // rather than blocking the turn on a secondary classifier.
  const imageRequestOutcome = await callGenesisModel({
    model: "claude-opus-4-8",
    max_tokens: 500,
    thinking: { type: "adaptive" },
    system: STORE_CHAT_IMAGE_REQUEST_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Active products:\n${currentProducts.map((p) => `- ${p.name}`).join("\n")}\n\nMerchant's message: ${userMessage}`,
      },
    ],
    output_config: {
      effort: "low",
      format: zodOutputFormat(ProductImageRequestSchema),
    },
  });
  // A provider failure here falls through to the normal chat flow below,
  // same as the pre-existing "detection failure" comment already intended
  // for a parse miss — this classifier was, before this pass, the one call
  // site whose failure crashed the entire turn immediately (every chat
  // message passes through it first), making it the most likely single
  // candidate for what actually crashed in the 2026-07-28 incident.
  const imageRequestResult = imageRequestOutcome.ok ? imageRequestOutcome.message.parsed_output : null;

  if (imageRequestResult?.isImageRequest) {
    // Resolution happens here, never by trusting the model's claim
    // directly — exact, case-insensitive matching against the real product
    // list. "all" resolves to every currently active product; "specific"
    // resolves only the names that actually match one of them (an unmatched
    // name is silently dropped rather than treated as ambiguous — the
    // model's own reply already named what it understood). A genuinely
    // unresolved scope, or a resolved set that ends up empty, falls back to
    // a clarifying question. Deliberately stays simple for beta — no fuzzy
    // matching, no embeddings.
    const targetProducts =
      imageRequestResult.scope === "all"
        ? currentProducts
        : imageRequestResult.scope === "specific"
          ? currentProducts.filter((p) =>
              (imageRequestResult.productNames ?? [])
                .map((n) => n.trim().toLowerCase())
                .includes(p.name.trim().toLowerCase())
            )
          : [];

    if (targetProducts.length === 0) {
      // Unresolved, or a named product didn't match anything real: create
      // no approval, and do not fall through to the general chat call
      // either — fall back to a safe, generic clarifying question rather
      // than trusting an unmatched name.
      const clarification =
        imageRequestResult.scope === "specific"
          ? `I want to make sure I update the right one — which product did you mean? Your active products are: ${currentProducts.map((p) => p.name).join(", ")}.`
          : imageRequestResult.reply;
      await prisma.storeMessage.create({
        data: { storeId: store.id, role: "assistant", content: clarification },
      });
      await logChatTurnEvent({
        userId,
        storeId: store.id,
        durationMs: Date.now() - turnStartedAt,
        outcome: "failure",
        likelyRephraseOf,
      });
      revalidatePath(returnTo);
      redirect(returnTo);
    }

    // Genesis orchestrates the whole authorized set as one delegated
    // objective, never surfacing that the underlying operation is still
    // one product at a time: every proposal from this turn shares one
    // groupId (the same grouping already used for multi-proposal chat turns
    // elsewhere in this file), so the owner sees "Genesis proposed new
    // photos for N products" as a single cluster, never N separate asks or
    // N separate clarifying questions.
    const groupId = randomUUID();
    const outcomes: { id: string; name: string; candidate: string | null }[] = [];
    for (const product of targetProducts) {
      const sourced = await resolveProductImage({
        prompt: extractRichContentImagePrompt(product.richContent) ?? product.description ?? product.name,
        name: product.name,
        description: product.description,
        excludeUrls: product.imageUrl ? [product.imageUrl] : [],
      });
      const candidate = sourced?.url ?? null;
      if (candidate) {
        // A fresh proposal for this product supersedes any earlier
        // still-pending one — scoped to this product's id specifically, so
        // a pending proposal for a different product is never touched.
        await prisma.approvalRequest.deleteMany({
          where: {
            storeId: store.id,
            actionType: "update_product_image",
            status: "PENDING_APPROVAL",
            input: { path: ["productId"], equals: product.id },
          },
        });
        await prisma.approvalRequest.create({
          data: {
            storeId: store.id,
            recommendationId: null,
            actionType: "update_product_image",
            input: {
              productId: product.id,
              imageUrl: candidate,
              ...(sourced?.generationPrompt ? { generationPrompt: sourced.generationPrompt } : {}),
            },
            previousValues: {
              productId: product.id,
              imageUrl: product.imageUrl,
              rejectedCandidates: [],
            },
            summary: `Replace image for "${product.name}"`,
            authorizationTier: GENESIS_ACTIONS.update_product_image.authorizationTier,
            groupId,
          },
        });
      }
      outcomes.push({ id: product.id, name: product.name, candidate });
    }

    const foundNames = outcomes.filter((o) => o.candidate).map((o) => o.name);
    const missedNames = outcomes.filter((o) => !o.candidate).map((o) => o.name);
    const replyParts = [imageRequestResult.reply];
    // Deterministic, not model-generated — same reasoning as finalReply's
    // own grouping clause below: the model has no idea these become N
    // separate ApprovalRequest rows, so it can't honestly describe the
    // review mechanics itself. Naming the count and pointing at the "Use
    // all" action directly closes the gap Priority 1's audit traced: a
    // merchant reading "I found new photos" had no way to know reviewing
    // meant N individual decisions, not one.
    if (foundNames.length > 1) {
      replyParts.push(
        `These are grouped as one idea on Products — review each, or use "Use all ${foundNames.length}" to apply them together.`
      );
    } else if (foundNames.length === 1) {
      replyParts.push(`You'll find it waiting for your review on Products.`);
    }
    if (missedNames.length > 0) {
      replyParts.push(
        `I couldn't find a good option for ${missedNames.join(", ")} — you may want to upload ${missedNames.length > 1 ? "those" : "that one"} directly for now.`
      );
    }

    await prisma.storeMessage.create({
      data: {
        storeId: store.id,
        role: "assistant",
        content: replyParts.join(" "),
      },
    });

    // A designed conversational outcome, not a generation failure — the
    // model call for this turn already succeeded either way. One row for
    // the whole delegated objective, not one per product.
    await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
      status: foundNames.length > 0 ? "PENDING" : "WARNING",
      verified: false,
      message:
        foundNames.length > 0
          ? `Proposed new images for ${foundNames.join(", ")}`
          : `Couldn't find new images for ${missedNames.join(", ")}`,
      retryable: foundNames.length === 0,
      userId,
      storeId: store.id,
      metadata: { groupId, productIds: outcomes.filter((o) => o.candidate).map((o) => o.id) },
    });
    await logChatTurnEvent({
      userId,
      storeId: store.id,
      durationMs: Date.now() - turnStartedAt,
      outcome: foundNames.length > 0 ? "success" : "failure",
      likelyRephraseOf,
    });

    revalidatePath(returnTo);
    redirect(returnTo);
  }

  const primaryOutcome = await callGenesisModel({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: STORE_CHAT_PRIMARY_SYSTEM_PROMPT,
    messages: [
      ...conversationMessages,
      { role: "user", content: contextParts.join("\n") },
    ],
    output_config: {
      effort: "high",
      format: zodOutputFormat(StoreChatPrimarySchema),
    },
  });
  if (!primaryOutcome.ok) {
    return bailOnProviderFailure({
      kind: primaryOutcome.kind,
      action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
      userId,
      storeId: store.id,
      returnTo,
      turnStartedAt,
      likelyRephraseOf,
      stageDurationsMs: { primary: primaryOutcome.durationMs },
    });
  }

  const primaryDurationMs = primaryOutcome.durationMs;
  const primaryResult = primaryOutcome.message.parsed_output;
  if (!primaryResult) {
    await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
      status: "FAILED",
      verified: false,
      message: "Genesis couldn't process that request",
      retryable: true,
      userId,
      storeId: store.id,
      metadata: {},
    });
    await logChatTurnEvent({
      userId,
      storeId: store.id,
      durationMs: Date.now() - turnStartedAt,
      outcome: "failure",
      likelyRephraseOf,
      stageDurationsMs: { primary: primaryDurationMs },
    });
    throw new Error("Genesis couldn't process that request");
  }

  let changes: string[] = [];
  // Summaries of anything created as an ApprovalRequest this turn, rather
  // than applied directly — used to correct the model's reply, which has
  // no idea some of what it just "did" is actually only proposed.
  const proposalSummaries: string[] = [];
  let secondaryDurationMs: number | null = null;
  let compositionDurationMs: number | null = null;

  if (primaryResult.requiresConfirmation) {
    await prisma.store.update({
      where: { id: store.id },
      data: { pendingChange: { summary: primaryResult.reply } },
    });
    await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
      status: "PENDING",
      verified: false,
      message: primaryResult.reply,
      retryable: false,
      userId,
      storeId: store.id,
      metadata: {},
    });
  } else {
    // Phase 2 Milestone 1 — never reassigned now that storeContent/
    // marketingAssets/designDirection all flow through their own approvals;
    // this stays exactly the "current" snapshot resultBlueprint's
    // direct-write fallback needs (see below).
    const secondaryContent: {
      storeContent: StoreContent;
      marketingAssets: MarketingAssets;
      designDirection: DesignDirection;
    } = {
      storeContent: currentBlueprint?.storeContent ?? DEFAULT_STORE_CONTENT,
      marketingAssets: currentBlueprint?.marketingAssets ?? DEFAULT_MARKETING_ASSETS,
      designDirection: currentBlueprint?.designDirection ?? DEFAULT_DESIGN_DIRECTION,
    };

    // seoTitle/seoMetaDescription are carved out below — they now flow
    // through the existing update_seo approval instead of applying
    // directly, closing the duplication the Phase 1 audit found (chat and
    // the recommendation engine were writing the identical fields two
    // different ways).
    let proposedSeo: { seoTitle: string; seoMetaDescription: string } | null = null;
    let proposedTheme: ThemeWithComposition | null = null;

    // Latency audit — SECONDARY and COMPOSITION each only read
    // primaryResult (never each other's output), so nothing forces them to
    // run sequentially. Started together and run via Promise.all — the same
    // pattern generateStoreDraft and applyGenesisMessage already use for
    // this identical pair — instead of fully awaiting one before even
    // starting the other. Each is still timed individually via its own
    // .then() (capturing its own real completion time, not just when the
    // slower of the two finishes).
    const secondaryPromise = primaryResult.touchesSecondaryContent
      ? callGenesisModel({
          model: "claude-opus-4-8",
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          system: CHAT_SECONDARY_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                `Brand identity (for tone/voice reference, JSON):\n${JSON.stringify(
                  primaryResult.brandIdentity,
                  null,
                  2
                )}`,
                `Current policies/marketing/design (JSON):\n${JSON.stringify(
                  secondaryContent,
                  null,
                  2
                )}`,
                `User's request: ${userMessage}`,
              ].join("\n\n"),
            },
          ],
          output_config: {
            effort: "high",
            format: zodOutputFormat(SecondaryChatSchema),
          },
        })
      : Promise.resolve(null);

    // Composition is a separate call, same reasoning as draft chat — adding
    // it to StoreChatPrimarySchema would risk the same grammar-size error.
    // The result is now a proposal (update_theme), not a direct write — see
    // the Phase 1 plan for why theme is the highest-value fork closure.
    const compositionPromise = primaryResult.touchesTheme
      ? callGenesisModel({
          model: "claude-opus-4-8",
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          system: CHAT_COMPOSITION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                `Brand identity and visual theme (JSON):\n${JSON.stringify(
                  { brandIdentity: primaryResult.brandIdentity, theme: primaryResult.theme },
                  null,
                  2
                )}`,
                `User's latest message: ${userMessage}`,
                `Plan already communicated to the user: ${primaryResult.reply}`,
              ].join("\n\n"),
            },
          ],
          output_config: {
            effort: "high",
            format: zodOutputFormat(CompositionSchema),
          },
        })
      : Promise.resolve(null);

    const [secondaryOutcome, compositionOutcome] = await Promise.all([secondaryPromise, compositionPromise]);
    secondaryDurationMs = secondaryOutcome?.durationMs ?? null;
    compositionDurationMs = compositionOutcome?.durationMs ?? null;

    // Phase 2 Milestone 1 — storeContent/marketingAssets(non-SEO)/
    // designDirection now flow through their own approvals, same as every
    // other field group already carved out of this direct-write path.
    // secondaryContent itself is never reassigned anymore — it stays at
    // whatever currentBlueprint held (see its own declaration above), which
    // is exactly the "keep current until approved" semantics resultBlueprint
    // below needs.
    let proposedStoreContent: {
      shippingPolicy: string;
      returnPolicy: string;
      privacyPolicy: string;
      termsAndConditions: string;
      contactPageCopy: string;
    } | null = null;
    let proposedMarketingAssets: {
      brandKeywords: string[];
      instagramBio: string;
      facebookDescription: string;
      xBio: string;
    } | null = null;
    let proposedDesignDirection: {
      visualStyle: string;
      brandMood: string;
      photographyStyle: string;
      iconStyle: string;
    } | null = null;

    if (secondaryOutcome?.ok) {
      const secondaryResult = secondaryOutcome.message.parsed_output;
      if (secondaryResult) {
        if (secondaryResult.touchesMarketingAssets) {
          proposedSeo = {
            seoTitle: secondaryResult.marketingAssets.seoTitle,
            seoMetaDescription: secondaryResult.marketingAssets.seoMetaDescription,
          };
          proposedMarketingAssets = {
            brandKeywords: secondaryResult.marketingAssets.brandKeywords,
            instagramBio: secondaryResult.marketingAssets.instagramBio,
            facebookDescription: secondaryResult.marketingAssets.facebookDescription,
            xBio: secondaryResult.marketingAssets.xBio,
          };
        }
        if (secondaryResult.touchesStoreContent) {
          proposedStoreContent = secondaryResult.storeContent;
        }
        if (secondaryResult.touchesDesignDirection) {
          proposedDesignDirection = secondaryResult.designDirection;
        }
      }
    }

    if (compositionOutcome?.ok) {
      const compositionResult = compositionOutcome.message.parsed_output;
      proposedTheme = {
        ...primaryResult.theme,
        composition: compositionResult ?? currentTheme.composition,
      };
    }

    // touchesBrandContent covered brandIdentity and all of homepageContent
    // together — it now splits four further ways: brand identity, homepage
    // content (now the FULL set — Phase 2 Milestone 1 folded the structured
    // fields featuredCollections/FAQ/newsletter/footer/customSection into
    // this same action, closing the last deferred piece of that field
    // group), and section order all become proposals (update_brand_identity
    // / update_hero / update_homepage_content / update_section_order — the
    // last is Phase 3B, Genesis's first structural Website action).
    let proposedBrandIdentity: BrandIdentity | null = null;
    let proposedHero: { heroHeadline: string; heroSubheadline: string } | null = null;
    let proposedHomepageContent: {
      primaryCallToAction: string;
      secondaryCallToAction: string | null;
      aboutUs: string;
      whyChooseUs: string;
      featuredCollections: string[];
      faq: { question: string; answer: string }[];
      newsletterSection: string;
      footerContent: string;
      customSection: { title: string; body: string } | null;
    } | null = null;
    let proposedSectionOrder: { sectionOrder: (typeof SECTION_KEYS)[number][] } | null = null;

    if (primaryResult.touchesBrandContent) {
      proposedBrandIdentity = primaryResult.brandIdentity;
      proposedHero = {
        heroHeadline: primaryResult.homepageContent.heroHeadline,
        heroSubheadline: primaryResult.homepageContent.heroSubheadline,
      };
      proposedHomepageContent = {
        primaryCallToAction: primaryResult.homepageContent.primaryCallToAction,
        secondaryCallToAction: primaryResult.homepageContent.secondaryCallToAction,
        aboutUs: primaryResult.homepageContent.aboutUs,
        whyChooseUs: primaryResult.homepageContent.whyChooseUs,
        featuredCollections: primaryResult.homepageContent.featuredCollections,
        faq: primaryResult.homepageContent.faq,
        newsletterSection: primaryResult.homepageContent.newsletterSection,
        footerContent: primaryResult.homepageContent.footerContent,
        customSection: primaryResult.homepageContent.customSection,
      };
      proposedSectionOrder = { sectionOrder: primaryResult.homepageContent.sectionOrder };
    }

    const currentHomepageContent = currentBlueprint?.homepageContent;
    const resultBlueprint: Blueprint = {
      // Brand identity now flows entirely through update_brand_identity —
      // the direct write keeps the current value untouched until approved.
      brandIdentity: currentBlueprint?.brandIdentity ?? primaryResult.brandIdentity,
      homepageContent: {
        // Hero and the scalar fields now flow through their own approvals —
        // the direct write keeps their current values untouched too.
        heroHeadline: currentHomepageContent?.heroHeadline ?? primaryResult.homepageContent.heroHeadline,
        heroSubheadline:
          currentHomepageContent?.heroSubheadline ?? primaryResult.homepageContent.heroSubheadline,
        primaryCallToAction:
          currentHomepageContent?.primaryCallToAction ?? primaryResult.homepageContent.primaryCallToAction,
        secondaryCallToAction:
          currentHomepageContent?.secondaryCallToAction ?? primaryResult.homepageContent.secondaryCallToAction,
        aboutUs: currentHomepageContent?.aboutUs ?? primaryResult.homepageContent.aboutUs,
        whyChooseUs: currentHomepageContent?.whyChooseUs ?? primaryResult.homepageContent.whyChooseUs,
        // Phase 2 Milestone 1 — the structured fields now flow through the
        // extended update_homepage_content approval too; the direct write
        // keeps their current values untouched until approved, same as
        // every other carved-out field.
        featuredCollections: currentHomepageContent?.featuredCollections ?? [],
        faq: currentHomepageContent?.faq ?? [],
        newsletterSection: currentHomepageContent?.newsletterSection ?? "",
        footerContent: currentHomepageContent?.footerContent ?? "",
        // Now flows through update_section_order (Phase 3B) — the direct
        // write keeps the current order untouched until approved, same as
        // hero/scalars/brandIdentity/storeIdentity above.
        sectionOrder: currentHomepageContent?.sectionOrder ?? [],
        customSection: currentHomepageContent?.customSection ?? null,
      },
      storeContent: secondaryContent.storeContent,
      marketingAssets: secondaryContent.marketingAssets,
      designDirection: secondaryContent.designDirection,
    };

    // Store identity now flows through update_store_identity — the direct
    // write keeps name/tagline/description untouched until approved.
    const proposedStoreIdentity = primaryResult.touchesIdentity
      ? {
          name: primaryResult.storeName,
          tagline: primaryResult.tagline,
          description: primaryResult.description,
        }
      : null;

    const after: StoreState = {
      name: store.name,
      tagline: store.tagline,
      description: store.description,
      theme: currentTheme,
      blueprint: resultBlueprint,
    };
    changes = diffStoreChanges(before, after);

    const updated = await prisma.store.update({
      where: { id: store.id },
      data: {
        name: after.name,
        tagline: after.tagline,
        description: after.description,
        theme: after.theme,
        blueprint: resultBlueprint,
        pendingChange: Prisma.DbNull,
        version: { increment: 1 },
      },
    });

    await prisma.storeGeneration.create({
      data: {
        storeId: store.id,
        version: updated.version,
        promptVersion: "store-chat-v1",
        generatedOutput: {
          name: after.name,
          tagline: after.tagline,
          description: after.description,
          theme: after.theme,
          blueprint: resultBlueprint,
        },
      },
    });

    // Every field that's now approval-gated (theme, brand identity, store
    // identity, homepage scalars, hero, SEO) creates or supersedes an
    // ApprovalRequest through the same GENESIS_ACTIONS registry the
    // recommendation engine already uses — the fork-closing part of Phase
    // 1: chat and the recommendation engine now converge on the one
    // existing approval path instead of chat bypassing it.
    const actionContext: GenesisActionContext = {
      blueprint: currentBlueprint,
      theme: currentTheme,
      storeIdentity: { name: store.name, tagline: store.tagline, description: store.description },
    };

    // Phase 4 — shared across every ApprovalRequest this one turn creates,
    // so the Website/Settings pages can present them as one reviewed-
    // together group rather than N unrelated cards. Presentational only —
    // each still has its own independent Approve/Reject.
    const groupId = randomUUID();

    async function proposeAction(actionType: string, proposedInput: unknown, summary: string) {
      const definition = GENESIS_ACTIONS[actionType];
      const parsedInput = definition.inputSchema.safeParse(proposedInput);
      if (!parsedInput.success) return; // defense in depth — never create an approval from an unvalidated shape
      await supersedePendingApproval(store.id, actionType);
      await prisma.approvalRequest.create({
        data: {
          storeId: store.id,
          recommendationId: null,
          actionType,
          input: parsedInput.data as object,
          previousValues: definition.getCurrentValues(actionContext) as object,
          summary,
          authorizationTier: definition.authorizationTier,
          groupId,
          // Phase 5 — deliberately left null, not fabricated. topicKey means
          // the stable identity of a real underlying business issue/
          // opportunity — chat proposals are owner-directed instructions
          // ("make my hero mention free shipping," "make my website blue"),
          // not Genesis-identified findings, and today's chat flow has no
          // reliable way to tell "this request carries a real business-issue
          // identity" apart from "this is just a direct instruction" without
          // either a second Claude call or heuristic classification. An
          // honest null here is correct; see the Phase 5 plan for the full
          // reasoning (memory: project_architecture_pivot_audit.md).
          topicKey: null,
        },
      });
      proposalSummaries.push(summary);
    }

    if (proposedTheme) {
      await proposeAction("update_theme", proposedTheme, "Genesis has a new look for your storefront");
    }
    if (proposedBrandIdentity) {
      await proposeAction(
        "update_brand_identity",
        proposedBrandIdentity,
        "Genesis has ideas for your brand identity"
      );
    }
    if (proposedHero) {
      await proposeAction("update_hero", proposedHero, "Genesis has an idea for your homepage hero");
    }
    if (proposedHomepageContent) {
      await proposeAction(
        "update_homepage_content",
        proposedHomepageContent,
        "Genesis has updates for your homepage content"
      );
    }
    if (proposedSectionOrder) {
      await proposeAction(
        "update_section_order",
        proposedSectionOrder,
        "Genesis has a new order for your homepage sections"
      );
    }
    if (proposedStoreIdentity) {
      await proposeAction(
        "update_store_identity",
        proposedStoreIdentity,
        "Genesis has updates for your store name and description"
      );
    }
    if (proposedSeo) {
      await proposeAction("update_seo", proposedSeo, "Genesis has an SEO update for you");
    }
    if (proposedStoreContent) {
      await proposeAction(
        "update_store_content",
        proposedStoreContent,
        "Genesis has updates for your store policies"
      );
    }
    if (proposedDesignDirection) {
      await proposeAction(
        "update_design_direction",
        proposedDesignDirection,
        "Genesis has updates for your design direction"
      );
    }
    if (proposedMarketingAssets) {
      await proposeAction(
        "update_marketing_assets",
        proposedMarketingAssets,
        "Genesis has updates for your social bios and keywords"
      );
    }

    await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
      status: "SUCCESS",
      verified: false,
      message: primaryResult.reply,
      retryable: false,
      userId,
      storeId: store.id,
      metadata: { changes, proposalSummaries },
    });

    // Phase 4 — a chat turn is exactly a "business state may have just
    // changed" moment, so it's a natural opportunistic trigger for the
    // deterministic observation sweep (zero AI cost). Scheduled via
    // after() so it never adds latency to the chat reply the owner is
    // waiting on — runs once the response has already been sent, even
    // through the redirect() below. Phase 5's measurement sweep rides the
    // same trigger — also deterministic, zero AI cost, a no-op unless a
    // past approval's measurement window has genuinely elapsed.
    scheduleAfterResponse(() =>
      Promise.all([
        runDeterministicObservationSweep(store.id),
        measureDueMeasurements(store.id),
      ]).catch(() => {})
    );
  }

  // The model has no idea some of what it just described is only proposed,
  // not live — it always writes its reply as if everything applied
  // immediately. Append a short, code-generated correction rather than
  // trusting the model's own phrasing for fields that are now
  // approval-gated (see the Phase 1 plan — a full prompt rewrite teaching
  // the model this boundary is a reasonable follow-up, not done here).
  //
  // The >1 case also names the count and says plainly that they're related
  // — traced live this session to a real trust gap: one narrow request
  // ("update the hero headline") silently produced 4 separate approval
  // cards across 3 pages with nothing ever saying they came from the same
  // idea. The grouping already existed in the data (groupId) and in the
  // review UI ("Genesis has N related changes from one idea") — it just
  // was never said here, in the one place the merchant sees immediately
  // after asking for something that felt like one small change.
  const finalReply =
    proposalSummaries.length > 1
      ? `${primaryResult.reply}\n\nI broke your request into ${proposalSummaries.length} related changes — they're all part of one idea, and you'll see them grouped together for review before any of it goes live: ${proposalSummaries.join("; ")}.`
      : proposalSummaries.length === 1
        ? `${primaryResult.reply}\n\nThis needs your review before it goes live — I've prepared it for you: ${proposalSummaries[0]}.`
        : primaryResult.reply;

  await prisma.storeMessage.create({
    data: {
      storeId: store.id,
      role: "assistant",
      content: finalReply,
      changes: changes.length > 0 ? changes : undefined,
    },
  });

  await logChatTurnEvent({
    userId,
    storeId: store.id,
    durationMs: Date.now() - turnStartedAt,
    outcome: "success",
    likelyRephraseOf,
    stageDurationsMs: {
      primary: primaryDurationMs,
      secondary: secondaryDurationMs,
      composition: compositionDurationMs,
    },
  });

  revalidatePath(returnTo);
  redirect(returnTo);
}

export async function sendStoreMessage(formData: FormData) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const userMessage = (formData.get("message") as string)?.trim();
  if (!userMessage) {
    throw new Error("Please enter a message");
  }

  // Genesis is available shell-wide now, not just from Home — a message
  // sent while on e.g. Products should redirect back to Products, not yank
  // the merchant to Home. The client supplies where it was via a hidden
  // field (not the referer header, which privacy settings can strip); an
  // unrecognized or missing value still falls back safely to Home.
  const currentPath = (formData.get("currentPath") as string) || "/dashboard";
  const returnTo = currentPath.startsWith("/dashboard") ? currentPath : "/dashboard";

  await applyGenesisMessageToStore(session.user.id, userMessage, returnTo);
}

const PERSONALITY_PROMPTS: Record<string, string> = {
  Luxury: "Make my brand feel Luxury.",
  Modern: "Make my brand feel Modern.",
  Professional: "Make my brand feel Professional.",
  Friendly: "Make my brand feel Friendly.",
  Heritage: "Make my brand feel Heritage.",
  Bold: "Make my brand feel Bold.",
  Minimal: "Make my brand feel Minimal.",
  Organic: "Make my brand feel Organic.",
  auto: "Let Genesis decide what brand personality and theme would work best for my store.",
};

export async function applyThemePersonality(formData: FormData) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const personality = formData.get("personality") as string;
  const message = PERSONALITY_PROMPTS[personality];
  if (!message) {
    throw new Error("Unknown brand personality");
  }

  await applyGenesisMessage(session.user.id, message);
}

export async function restoreStoreDraftVersion(generationId: string) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const generation = await prisma.storeGeneration.findFirst({
    where: { id: generationId, storeDraft: { userId: session.user.id } },
  });
  if (!generation || !generation.storeDraftId) {
    throw new Error("Version not found");
  }

  const output = generation.generatedOutput as {
    name: string;
    tagline: string | null;
    description: string | null;
    theme: ThemeWithComposition;
    productsDraft: ProductContent[];
    blueprint: Blueprint | null;
  };

  const updated = await prisma.storeDraft.update({
    where: { id: generation.storeDraftId },
    data: {
      name: output.name,
      tagline: output.tagline ?? null,
      description: output.description,
      theme: output.theme,
      productsDraft: output.productsDraft,
      blueprint: output.blueprint ?? Prisma.DbNull,
      pendingChange: Prisma.DbNull,
      version: { increment: 1 },
    },
  });

  await prisma.storeGeneration.create({
    data: {
      storeDraftId: updated.id,
      version: updated.version,
      promptVersion: "restore",
      generatedOutput: output,
    },
  });

  await prisma.storeDraftMessage.create({
    data: {
      storeDraftId: updated.id,
      role: "assistant",
      content: `Restored to version ${generation.version}.`,
      changes: [`Restored from version ${generation.version}`],
    },
  });

  redirect("/dashboard");
}

export async function confirmStoreDraft() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const draft = await prisma.storeDraft.findUnique({
    where: { userId: session.user.id },
  });
  if (!draft) {
    redirect("/dashboard");
  }

  const theme = draft.theme as ThemeWithComposition;
  const products = (draft.productsDraft as ProductContent[] | null) ?? [];

  const baseSlug = slugify(draft.name);
  let slug = baseSlug;
  let suffix = 1;
  while (await prisma.store.findUnique({ where: { slug } })) {
    slug = `${baseSlug}-${suffix}`;
    suffix++;
  }

  // Resolved once here, not on every storefront page load — see lib/unsplash.ts.
  const productImages = await Promise.all(
    products.map((p) =>
      resolveProductImage({
        prompt: p.imagePrompt || p.description || p.name,
        name: p.name,
        description: p.description,
        excludeUrls: [],
      }).then((sourced) => sourced?.url ?? null)
    )
  );

  // Hero-image architecture fix (Priority 4) — only the "split" hero layout
  // ever renders an image at all (confirmed in app/store/[slug]/page.tsx —
  // centered/fullBleed/minimal are deliberately text-led compositions,
  // chosen per brand personality, and must stay that way rather than having
  // an image forced into them just because one now exists). Sourcing is
  // skipped entirely for the other three layouts — no wasted API cost for a
  // photo that would never render.
  const heroImageUrl =
    theme.composition?.heroLayout === "split"
      ? await sourceHeroImageCandidate({
          productType: draft.inputProductType,
          vision: draft.inputVision ?? draft.description ?? draft.name,
        })
      : null;

  // Merges into the existing blueprint JSON rather than a schema field —
  // homepageContent already houses heroHeadline/heroSubheadline, so this is
  // the same content, sourced the same way the draft's own content already
  // is, not a new concept. Never asked of Claude (see sourceHeroImageCandidate's
  // own comment), so it's deliberately not added to HomepageContentSchema —
  // that schema is validated AI output; heroImageUrl is attached here, after
  // generation, exactly like productImages above. Left untyped against
  // Blueprint (which stays the AI-facing shape) rather than widening that
  // type for one storage-only field only this write path produces.
  const draftBlueprint = draft.blueprint as Blueprint | null;
  const blueprintWithHero = draftBlueprint
    ? {
        ...draftBlueprint,
        homepageContent: { ...draftBlueprint.homepageContent, heroImageUrl },
      }
    : draftBlueprint;

  const store = await prisma.store.create({
    data: {
      userId: session.user.id,
      name: draft.name,
      slug,
      description: draft.description,
      tagline: draft.tagline,
      theme,
      blueprint: (blueprintWithHero as object | null) ?? Prisma.DbNull,
      version: draft.version,
      businessCategories: draft.businessCategories,
      revenueStreams: draft.revenueStreams,
      products: {
        create: products.map((p, index) => ({
          name: p.name,
          description: p.description || null,
          priceInCents: Math.round(p.price * 100),
          position: index,
          imageUrl: productImages[index],
          richContent: {
            keyFeatures: p.keyFeatures ?? [],
            benefits: p.benefits ?? [],
            specifications: p.specifications ?? [],
            imagePrompt: p.imagePrompt ?? "",
          },
        })),
      },
    },
  });

  // Promote every generation from the draft to the new store so its
  // history survives the draft being deleted below — this is what makes
  // "Your Store's Vision" a permanent part of the store, not just the
  // draft phase.
  await prisma.storeGeneration.updateMany({
    where: { storeDraftId: draft.id },
    data: { storeId: store.id, storeDraftId: null },
  });

  // Stamp whichever generation is live right now as "first refined" — the
  // version the user actually chose to bring to life. Skip it if that same
  // generation is already tagged "original" (a store confirmed with zero
  // edits shouldn't get two competing milestone labels on one row).
  await prisma.storeGeneration.updateMany({
    where: { storeId: store.id, version: draft.version, milestone: null },
    data: { milestone: "first_refined" },
  });

  await prisma.storeDraft.delete({ where: { id: draft.id } });

  // Family-beta instrumentation (v20) — the creation journey's terminal
  // success event. draft.id stays the attemptKey even though the row above
  // is now gone — it's still a stable string tying every creation.* event
  // for this one journey together. draft.version doubles as a free "how
  // many refinement rounds happened before confirming" signal.
  await logProductEvent({
    userId: session.user.id,
    storeId: store.id,
    storeDraftId: draft.id,
    sessionInstanceId: session.user.sessionInstanceId,
    name: "creation.confirmed",
    category: "creation",
    attemptKey: draft.id,
    outcome: "success",
    metadata: { versionsBeforeConfirm: draft.version },
  });

  redirect("/dashboard");
}

export async function discardStoreDraft() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  await prisma.storeDraft.deleteMany({
    where: { userId: session.user.id },
  });

  redirect("/dashboard");
}

// Called directly from RecommendationExplainButton (a plain async function
// call, not a <form action>) so its result can render inline without a page
// navigation. No ExecutionLog row — this isn't a mutation with an outcome to
// verify, closer to a chat reply than an executed action.
export async function explainRecommendation(
  recommendationId: string
): Promise<RecommendationExplanation> {
  const { storeId, store } = await requireStorePermission(PERMISSIONS.ANALYTICS_VIEW);
  return getRecommendationExplanation({ recommendationId, storeId, storeName: store.name });
}

// PH-07 Layer 3 — "Ask Genesis to Review My Business" on the dashboard.
// Plain redirect-based Server Action (not the Layer 2 call-directly pattern)
// since a refresh naturally causes a full page re-render that reads the
// freshly-persisted CognitiveOutput rows — no inline result needed.
export async function reviewBusinessWithGenesis() {
  const { userId, storeId } = await requireStorePermission(PERMISSIONS.ANALYTICS_VIEW);
  await runCognitiveReview({ storeId, userId });
  redirect("/dashboard");
}

// PH-07 Layer 4 — approving a Genesis-proposed action. ANALYTICS_VIEW is
// only the page-level gate (finds the section, resolves storeId); the real
// authorization is execute()'s own requiredPermission check on the
// underlying Executable (e.g. STORE_MANAGE) — same two-layer pattern as
// every prior phase, not just cosmetic.
// Family-beta instrumentation (v20) — attemptKey reuses the same real
// identity (topicKey, falling back to groupId, falling back to the action
// type itself) already used elsewhere, so a reject-then-reprosose-then-
// approve sequence for "the same underlying thing" correlates together
// without a new counter. waitMs (createdAt -> now) gives real
// time-to-decision for free — ApprovalRequest already orders by this,
// just never surfaced as a number before.
async function logApprovalDecisionEvent(params: {
  userId: string;
  storeId: string;
  approval: { id: string; actionType: string; topicKey: string | null; groupId: string | null; createdAt: Date };
  name: string;
  outcome: "success" | "failure";
}) {
  const session = await auth();
  if (!session?.user) return;
  await logProductEvent({
    userId: params.userId,
    storeId: params.storeId,
    sessionInstanceId: session.user.sessionInstanceId,
    name: params.name,
    category: "approval",
    attemptKey: params.approval.topicKey ?? params.approval.groupId ?? params.approval.actionType,
    outcome: params.outcome,
    metadata: {
      approvalId: params.approval.id,
      actionType: params.approval.actionType,
      waitMs: Date.now() - params.approval.createdAt.getTime(),
    },
  });
}

// The real fix for "Genesis said it would generate images for 3 products,
// but only one actually gets applied" — traced end to end: detection
// already correctly creates one real ApprovalRequest per missing image,
// all sharing one groupId (see the image-request branch of
// applyGenesisMessageToStore above), and every review surface
// (ApprovalRequestsPanel, website/page.tsx) already displays them as one
// visual cluster ("Genesis has N related changes from one idea"). The
// architectural gap was one level down: grouping was presentational only —
// there was no action that could execute a whole group, so "approving"
// still meant N separate manual clicks, and reviewing what looked like one
// idea silently left N-1 of them still pending. This is that missing
// action: it executes every still-pending member of one groupId through
// the exact same execute()/registry path approveGenesisAction already
// uses, one at a time, and reports one honest outcome for the batch
// (including a real partial-failure count) rather than leaving the owner
// to infer completeness from which cards happened to disappear. Every
// member keeps its own real ApprovalRequest row and its own
// EXECUTED/PENDING_APPROVAL status — this batches real individual
// decisions, it never fabricates one merged decision.
export async function approveGenesisActionGroup(groupId: string) {
  const { storeId, userId } = await requireStorePermission(PERMISSIONS.ANALYTICS_VIEW);
  const members = await prisma.approvalRequest.findMany({
    where: { storeId, groupId, status: "PENDING_APPROVAL" },
    orderBy: { createdAt: "asc" },
  });

  if (members.length === 0) {
    redirect("/dashboard");
  }

  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const approval of members) {
    const definition = GENESIS_ACTIONS[approval.actionType];
    if (!definition) {
      failed.push(approval.summary);
      continue;
    }

    const result = await execute(
      definition.executable,
      // Dynamic dispatch by actionType, same as approveGenesisAction below.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      approval.input as any,
      { storeId, actorType: "GENESIS" }
    );

    if (result.status === "FAILED") {
      // Same FAILED-never-reads-as-EXECUTED guarantee as the single-item
      // path — reverts to pending (implicitly, by simply not updating
      // status) with executionId recorded so the card surfaces "couldn't
      // apply this last time" and stays individually retryable.
      await prisma.approvalRequest.update({
        where: { id: approval.id },
        data: { executionId: result.executionId },
      });
      await logApprovalDecisionEvent({
        userId,
        storeId,
        approval,
        name: "approval.approve_failed",
        outcome: "failure",
      });
      failed.push(approval.summary);
      continue;
    }

    await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: {
        status: "EXECUTED",
        executionId: result.executionId,
        decidedByUserId: userId,
        decidedAt: new Date(),
      },
    });
    if (approval.recommendationId) {
      await prisma.generatedRecommendation.deleteMany({ where: { id: approval.recommendationId } });
    }
    await logApprovalDecisionEvent({
      userId,
      storeId,
      approval,
      name: "approval.approved",
      outcome: "success",
    });
    succeeded.push(approval.summary);
  }

  // One honest, human-readable outcome for the whole batch, visible in the
  // real conversation history — not just inferable from which cards
  // happened to disappear from the review page.
  const summaryText =
    failed.length === 0
      ? `Applied all ${succeeded.length} change${succeeded.length === 1 ? "" : "s"} from that idea.`
      : succeeded.length === 0
        ? `Couldn't apply ${failed.length === 1 ? "that change" : `any of the ${failed.length} changes`} — still pending, so you can retry from the review page.`
        : `Applied ${succeeded.length} of ${members.length} — ${failed.length} couldn't be applied and ${failed.length === 1 ? "is" : "are"} still pending so you can retry.`;
  await prisma.storeMessage.create({
    data: { storeId, role: "assistant", content: summaryText },
  });

  redirect("/dashboard");
}

export async function approveGenesisAction(approvalRequestId: string) {
  const { storeId, userId } = await requireStorePermission(PERMISSIONS.ANALYTICS_VIEW);
  const approval = await prisma.approvalRequest.findFirst({
    where: { id: approvalRequestId, storeId, status: "PENDING_APPROVAL" },
  });

  // Already decided/reverted elsewhere (a real race, not a bug) — nothing
  // left to do, so this is a no-op redirect, never a thrown error.
  if (!approval) {
    redirect("/dashboard");
  }

  const definition = GENESIS_ACTIONS[approval.actionType];
  if (!definition) {
    throw new Error(`Unknown Genesis action type: ${approval.actionType}`);
  }

  const result = await execute(
    definition.executable,
    // Dynamic dispatch by actionType — the concrete input shape is only
    // known at the specific registry entry, not at this generic call site.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    approval.input as any,
    { storeId, actorType: "GENESIS" }
  );

  // A failed execution must never read back as EXECUTED — that would show
  // the owner a change that never actually happened. None of today's
  // Genesis Executables define verify() or return a partial outcome, so
  // FAILED is the only other status any of them can produce in practice
  // (WARNING and PARTIAL are real ExecutionStatus values, just not
  // reachable here) — reverting to PENDING_APPROVAL on FAILED, rather than
  // enumerating the "good" statuses, is the simpler and more honest check.
  // executionId is still recorded on the reverted row so the pending-
  // approvals list can tell "never acted on" apart from "tried and failed"
  // (see lib/dashboard/pendingApprovals.ts) — decidedBy/decidedAt stay
  // unset since nothing was actually decided yet.
  if (result.status === "FAILED") {
    await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: { executionId: result.executionId },
    });
    await logApprovalDecisionEvent({
      userId,
      storeId,
      approval,
      name: "approval.approve_failed",
      outcome: "failure",
    });
    redirect("/dashboard");
  }

  await prisma.approvalRequest.update({
    where: { id: approval.id },
    data: {
      status: "EXECUTED",
      executionId: result.executionId,
      decidedByUserId: userId,
      decidedAt: new Date(),
    },
  });

  // Approved-and-executed advice is stale the moment it's applied.
  if (approval.recommendationId) {
    await prisma.generatedRecommendation.deleteMany({ where: { id: approval.recommendationId } });
  }

  await logApprovalDecisionEvent({
    userId,
    storeId,
    approval,
    name: "approval.approved",
    outcome: "success",
  });

  redirect("/dashboard");
}

export async function rejectGenesisAction(approvalRequestId: string) {
  const { storeId, userId } = await requireStorePermission(PERMISSIONS.ANALYTICS_VIEW);
  const approval = await prisma.approvalRequest.findFirst({
    where: { id: approvalRequestId, storeId, status: "PENDING_APPROVAL" },
  });

  if (!approval) {
    redirect("/dashboard");
  }

  await prisma.approvalRequest.update({
    where: { id: approval.id },
    data: { status: "REJECTED", decidedByUserId: userId, decidedAt: new Date() },
  });

  // A rejected suggestion shouldn't keep nagging until the next full refresh.
  if (approval.recommendationId) {
    await prisma.generatedRecommendation.deleteMany({ where: { id: approval.recommendationId } });
  }

  await logApprovalDecisionEvent({
    userId,
    storeId,
    approval,
    name: "approval.rejected",
    outcome: "success",
  });

  redirect("/dashboard");
}

// Phase 6 — undo for any EXECUTED action, reusing the exact same
// getCurrentValues/previousValues data every proposal already carries: the
// revert's input is simply the original row's previousValues. Immutable
// history, per Sean's explicit direction — this creates a NEW
// ApprovalRequest+ExecutionLog row rather than rewriting or deleting the
// original, so the record of what Genesis actually did (and when) never
// changes. actorType/decisionMode are both "human" here regardless of
// whether the ORIGINAL action was autonomous — clicking "revert" is itself
// a real, immediate human decision, not Genesis's judgment.
export async function revertApprovalRequest(
  approvalRequestId: string,
  _prevState: ActionState,
  _formData: FormData
): Promise<ActionState> {
  const { storeId, userId } = await requireStorePermission(PERMISSIONS.ANALYTICS_VIEW);
  const original = await prisma.approvalRequest.findFirst({
    where: { id: approvalRequestId, storeId, status: "EXECUTED" },
  });

  // Already reverted elsewhere (a real race, not a bug) — nothing left to
  // do, so this is a no-op redirect, never a thrown error.
  if (!original) {
    redirect("/dashboard");
  }

  try {
    const definition = GENESIS_ACTIONS[original.actionType];
    if (!definition) {
      throw new Error(`Unknown Genesis action type: ${original.actionType}`);
    }

    // Defense in depth, same as every other creation path — previousValues
    // was itself computed by this same registry's getCurrentValues at
    // proposal time, but re-validate before trusting it as fresh input.
    const parsedRevertInput = definition.inputSchema.safeParse(original.previousValues);
    if (!parsedRevertInput.success) {
      throw new RecoverableError(
        "Can't revert this action — its previous value no longer matches the expected shape."
      );
    }

    const result = await execute(
      definition.executable,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parsedRevertInput.data as any,
      { storeId, actorType: "USER" }
    );

    if (result.status === "FAILED") {
      await logApprovalDecisionEvent({
        userId,
        storeId,
        approval: original,
        name: "approval.revert_failed",
        outcome: "failure",
      });
      throw new RecoverableError(result.message);
    }

    await prisma.approvalRequest.create({
      data: {
        storeId,
        actionType: original.actionType,
        // Deliberately swapped: reverting means restoring the ORIGINAL's
        // previousValues, and the thing being undone (for this new row's own
        // "previous" record) is the ORIGINAL's input.
        input: original.previousValues as object,
        previousValues: original.input as object,
        summary: `Reverted: ${original.summary}`,
        status: "EXECUTED",
        authorizationTier: "always_ask",
        decisionMode: "human",
        executionId: result.executionId,
        decidedByUserId: userId,
        decidedAt: new Date(),
      },
    });

    await logApprovalDecisionEvent({
      userId,
      storeId,
      approval: original,
      name: "approval.reverted",
      outcome: "success",
    });
  } catch (error) {
    unstable_rethrow(error);
    return toActionState(error);
  }

  redirect("/dashboard");
}

// Re-sources a genuinely different candidate for a still-pending
// update_product_image approval, in place — same row, not a new one, so
// there's still exactly one pending approval per product. Every URL ever
// shown (the product's real live image, plus every previously proposed
// candidate) is excluded, so this can never silently re-propose something
// already seen. If nothing new is available, the row's input is left
// untouched and the summary says so plainly — a normal outcome, not a
// thrown error (there's no error boundary yet to catch one gracefully).
export async function regenerateApprovalImage(approvalRequestId: string) {
  const { storeId } = await requireStorePermission(PERMISSIONS.ANALYTICS_VIEW);
  const approval = await prisma.approvalRequest.findFirst({
    where: {
      id: approvalRequestId,
      storeId,
      status: "PENDING_APPROVAL",
      actionType: "update_product_image",
    },
  });

  if (!approval) {
    redirect("/dashboard");
  }

  const input = approval.input as { productId: string; imageUrl: string };
  const previousValues = approval.previousValues as {
    productId: string;
    imageUrl: string | null;
    rejectedCandidates?: string[];
  };

  const product = await prisma.product.findUniqueOrThrow({
    where: { id: input.productId },
    select: { name: true, description: true, richContent: true },
  });

  const rejectedCandidates = previousValues.rejectedCandidates ?? [];
  const excludeUrls = [
    ...(previousValues.imageUrl ? [previousValues.imageUrl] : []),
    input.imageUrl,
    ...rejectedCandidates,
  ];

  const sourced = await resolveProductImage({
    prompt: extractRichContentImagePrompt(product.richContent) ?? product.description ?? product.name,
    name: product.name,
    description: product.description,
    excludeUrls,
  });
  const candidate = sourced?.url ?? null;

  if (candidate) {
    await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: {
        input: {
          productId: input.productId,
          imageUrl: candidate,
          ...(sourced?.generationPrompt ? { generationPrompt: sourced.generationPrompt } : {}),
        },
        previousValues: {
          ...previousValues,
          rejectedCandidates: [...rejectedCandidates, input.imageUrl],
        },
        summary: `Replace image for "${product.name}"`,
      },
    });
  } else {
    await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: {
        summary: `Replace image for "${product.name}" (no different photo found — the current proposal is unchanged)`,
      },
    });
  }

  redirect("/dashboard");
}
