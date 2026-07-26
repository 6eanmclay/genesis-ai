"use server";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { randomUUID } from "crypto";
import { z } from "zod";
import { redirect } from "next/navigation";
// Aliased — this file already has a local `const after: StoreState` inside
// applyGenesisMessageToStore, which would otherwise shadow this import.
import { after as scheduleAfterResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/slugify";
import { searchProductImage } from "@/lib/unsplash";
import { sourceProductImageCandidate } from "@/lib/productImagery";
import { PERMISSIONS, hasPermission, requireStorePermission, resolveUserStore } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { recordGenesisExecution } from "@/lib/execution/genesis";
import {
  getRecommendationExplanation,
  type RecommendationExplanation,
} from "@/lib/dashboard/explainRecommendation";
import { generateGenesisRecommendations } from "@/lib/dashboard/generateGenesisRecommendations";
import { runDeterministicObservationSweep } from "@/lib/dashboard/genesisObservations";
import { measureDueMeasurements } from "@/lib/dashboard/postExecutionMeasurement";
import { GENESIS_ACTIONS, type GenesisActionContext } from "@/lib/execution/genesisActions";
import { supersedePendingApproval } from "@/lib/dashboard/pendingApprovals";
import { SECTION_KEYS } from "@/lib/storefrontSections";
import { execute } from "@/lib/execution/engine";

const anthropic = new Anthropic();

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

export async function generateStoreDraft(formData: FormData) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const inputStoreName =
    (formData.get("inputStoreName") as string)?.trim() || null;
  const inputProductType =
    (formData.get("inputProductType") as string)?.trim() || null;
  const inputVision = (formData.get("inputVision") as string)?.trim() || null;

  if (!inputVision) {
    throw new Error("Please describe your vision");
  }

  const briefText = [
    `Store name: ${inputStoreName ?? "(not specified — invent one)"}`,
    `What they sell: ${
      inputProductType ?? "(not specified — invent something fitting)"
    }`,
    `Vision: ${inputVision ?? "(not specified — use your best judgment)"}`,
  ].join("\n");

  const primaryStream = anthropic.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: GENERATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: briefText }],
    output_config: {
      effort: "high",
      format: zodOutputFormat(PrimaryBlueprintSchema),
    },
  });
  const primaryMessage = await primaryStream.finalMessage();
  const primary = primaryMessage.parsed_output;
  if (!primary) {
    throw new Error("Failed to generate store blueprint");
  }

  // SECONDARY and COMPOSITION both only depend on PRIMARY's output, not on
  // each other — run them concurrently rather than back-to-back.
  const [secondaryMessage, compositionMessage] = await Promise.all([
    anthropic.messages
      .stream({
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
      })
      .finalMessage(),
    anthropic.messages
      .stream({
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
      })
      .finalMessage(),
  ]);
  const secondary = secondaryMessage.parsed_output;
  if (!secondary) {
    throw new Error("Failed to generate store blueprint");
  }
  const composition = compositionMessage.parsed_output;
  if (!composition) {
    throw new Error("Failed to generate store blueprint");
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
    where: { userId: session.user.id },
    create: {
      userId: session.user.id,
      inputStoreName,
      inputProductType,
      inputVision,
      name: primary.storeName,
      tagline: primary.tagline,
      description: primary.description,
      theme: themeWithComposition,
      productsDraft: primary.products,
      blueprint: blueprintContent,
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

  redirect("/dashboard");
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
  // The model's best-guess single product name — informational only. The
  // caller re-verifies this against the real product list; never trusted
  // directly, and never used to create an approval on its own say-so.
  productName: z.string().nullable(),
  // Used verbatim as the assistant's reply in every outcome when
  // isImageRequest is true: acknowledging a resolved request, or asking a
  // genuine clarifying question when the product can't be pinned down.
  reply: z.string(),
});

const STORE_CHAT_IMAGE_REQUEST_SYSTEM_PROMPT = `You are Genesis, triaging one incoming message from a merchant about their live store, before anything else runs. You are given the store's active product names and the merchant's latest message. Decide only one thing: is this message asking to replace, regenerate, or find a new photo for a specific existing product?

Most messages are not this — identity, theme, branding, policy, and general questions are handled elsewhere and should get isImageRequest: false with an empty reply (it's ignored in that case).

If it IS an image request, try to identify exactly which single product from the list is meant. If you can confidently tell which one, set productName to that product's exact name and write reply as a short, natural acknowledgment that you're finding a new photo for it (you don't yet know what the new photo will look like — don't describe it). If you cannot confidently tell which single product is meant — no product was named, the name doesn't match anything specific enough, or it could plausibly be more than one product — do NOT guess. Leave productName empty (or your best partial guess, which will not be trusted) and write reply as a genuine, specific clarifying question naming the plausible candidates from the real list, so the merchant can just answer with the right one.`;

async function applyGenesisMessage(userId: string, userMessage: string) {
  const draft = await prisma.storeDraft.findUnique({
    where: { userId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!draft) {
    redirect("/dashboard");
  }

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

  const controlStream = anthropic.messages.stream({
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

  const controlMessage = await controlStream.finalMessage();
  const controlResult = controlMessage.parsed_output;
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
    throw new Error("Genesis couldn't process that request");
  }

  let changes: string[] = [];

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

    const contentStream = anthropic.messages.stream({
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

    const contentMessage = await contentStream.finalMessage();
    const contentResult = contentMessage.parsed_output;
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

    if (controlResult.touchesSecondaryContent) {
      const secondaryStream = anthropic.messages.stream({
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
      });
      const secondaryMessage = await secondaryStream.finalMessage();
      const secondaryResult = secondaryMessage.parsed_output;
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

    // Composition is a separate call for the same reason CONTENT is split
    // from CONTROL — adding it to PrimaryBlueprintSchema reproduces the
    // grammar-size error. Only run it when theme is actually in scope.
    let themeResult: ThemeWithComposition = currentTheme;
    if (controlResult.touchesTheme) {
      const compositionStream = anthropic.messages.stream({
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
      });
      const compositionMessage = await compositionStream.finalMessage();
      const compositionResult = compositionMessage.parsed_output;
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
    redirect(returnTo);
  }

  const currentTheme = store.theme as ThemeWithComposition;
  const currentBlueprint = store.blueprint as Blueprint | null;
  const currentProducts = await prisma.product.findMany({
    where: { storeId: store.id, active: true },
    select: { id: true, name: true, description: true, priceInCents: true, imageUrl: true },
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

  // Detect "replace this product's image" requests first, via a separate
  // tiny call — see the comment above ProductImageRequestSchema for why
  // this isn't folded into StoreChatPrimarySchema. Any detection failure
  // (parse error, API error) falls through to the normal chat flow below
  // rather than blocking the turn on a secondary classifier.
  const imageRequestStream = anthropic.messages.stream({
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
  const imageRequestResult = (await imageRequestStream.finalMessage()).parsed_output;

  if (imageRequestResult?.isImageRequest) {
    // Resolution happens here, never by trusting the model's claim — exact,
    // case-insensitive match against the real product list. Zero or
    // multiple matches both count as unresolved; only exactly one match
    // proceeds. This deliberately stays simple for beta — no fuzzy
    // matching, no embeddings.
    const requestedName = imageRequestResult.productName?.trim().toLowerCase();
    const matches = requestedName
      ? currentProducts.filter((p) => p.name.trim().toLowerCase() === requestedName)
      : [];

    if (matches.length !== 1) {
      // Unresolved or ambiguous: create no approval, and do not fall
      // through to the general chat call either. If the model named
      // something that didn't uniquely match one real product (a
      // hallucination or typo), its own reply may reference that wrong
      // name, so fall back to a safe, generic clarifying question instead
      // of trusting it in that specific case.
      const clarification =
        requestedName && matches.length === 0
          ? `I want to make sure I update the right one — which product did you mean? Your active products are: ${currentProducts.map((p) => p.name).join(", ")}.`
          : imageRequestResult.reply;
      await prisma.storeMessage.create({
        data: { storeId: store.id, role: "assistant", content: clarification },
      });
      redirect(returnTo);
    }

    const targetProduct = matches[0];
    const candidate = await sourceProductImageCandidate({
      name: targetProduct.name,
      description: targetProduct.description,
    });

    if (candidate) {
      // A fresh proposal for this product supersedes any earlier
      // still-pending one — scoped to this product's id specifically, so a
      // pending proposal for a different product is never touched.
      await prisma.approvalRequest.deleteMany({
        where: {
          storeId: store.id,
          actionType: "update_product_image",
          status: "PENDING_APPROVAL",
          input: { path: ["productId"], equals: targetProduct.id },
        },
      });
      await prisma.approvalRequest.create({
        data: {
          storeId: store.id,
          recommendationId: null,
          actionType: "update_product_image",
          input: { productId: targetProduct.id, imageUrl: candidate },
          previousValues: {
            productId: targetProduct.id,
            imageUrl: targetProduct.imageUrl,
            rejectedCandidates: [],
          },
          summary: `Replace image for "${targetProduct.name}"`,
          authorizationTier: GENESIS_ACTIONS.update_product_image.authorizationTier,
        },
      });
    }

    await prisma.storeMessage.create({
      data: {
        storeId: store.id,
        role: "assistant",
        content: candidate
          ? imageRequestResult.reply
          : `I looked for a new photo for "${targetProduct.name}" but couldn't find a good option — you may want to upload one directly for now.`,
      },
    });

    // A designed conversational outcome, not a generation failure — the
    // model call for this turn already succeeded either way.
    await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
      status: candidate ? "PENDING" : "WARNING",
      verified: false,
      message: candidate
        ? `Proposed a new image for "${targetProduct.name}"`
        : `Couldn't find a new image for "${targetProduct.name}"`,
      retryable: !candidate,
      userId,
      storeId: store.id,
      metadata: { productId: targetProduct.id },
    });

    redirect(returnTo);
  }

  const primaryStream = anthropic.messages.stream({
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

  const primaryMessage = await primaryStream.finalMessage();
  const primaryResult = primaryMessage.parsed_output;
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
    throw new Error("Genesis couldn't process that request");
  }

  let changes: string[] = [];
  // Summaries of anything created as an ApprovalRequest this turn, rather
  // than applied directly — used to correct the model's reply, which has
  // no idea some of what it just "did" is actually only proposed.
  const proposalSummaries: string[] = [];

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
    let secondaryContent: {
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

    if (primaryResult.touchesSecondaryContent) {
      const secondaryStream = anthropic.messages.stream({
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
      });
      const secondaryMessage = await secondaryStream.finalMessage();
      const secondaryResult = secondaryMessage.parsed_output;
      if (secondaryResult) {
        if (secondaryResult.touchesMarketingAssets) {
          proposedSeo = {
            seoTitle: secondaryResult.marketingAssets.seoTitle,
            seoMetaDescription: secondaryResult.marketingAssets.seoMetaDescription,
          };
        }
        secondaryContent = {
          storeContent: secondaryResult.touchesStoreContent
            ? secondaryResult.storeContent
            : secondaryContent.storeContent,
          marketingAssets: secondaryResult.touchesMarketingAssets
            ? {
                ...secondaryResult.marketingAssets,
                // Kept at the current value in the direct write — proposed
                // via update_seo instead.
                seoTitle: secondaryContent.marketingAssets.seoTitle,
                seoMetaDescription: secondaryContent.marketingAssets.seoMetaDescription,
              }
            : secondaryContent.marketingAssets,
          designDirection: secondaryResult.touchesDesignDirection
            ? secondaryResult.designDirection
            : secondaryContent.designDirection,
        };
      }
    }

    // Composition is a separate call, same reasoning as draft chat — adding
    // it to StoreChatPrimarySchema would risk the same grammar-size error.
    // The result is now a proposal (update_theme), not a direct write — see
    // the Phase 1 plan for why theme is the highest-value fork closure.
    let proposedTheme: ThemeWithComposition | null = null;
    if (primaryResult.touchesTheme) {
      const compositionStream = anthropic.messages.stream({
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
      });
      const compositionMessage = await compositionStream.finalMessage();
      const compositionResult = compositionMessage.parsed_output;
      proposedTheme = {
        ...primaryResult.theme,
        composition: compositionResult ?? currentTheme.composition,
      };
    }

    // touchesBrandContent covered brandIdentity and all of homepageContent
    // together — it now splits four further ways: brand identity, the
    // hero/scalar homepage fields, and section order all become proposals
    // (update_brand_identity / update_hero / update_homepage_content /
    // update_section_order — the last is Phase 3B, Genesis's first
    // structural Website action); the remaining structured homepage fields
    // (featuredCollections, FAQ, newsletter, footer, customSection) still
    // apply directly, since no diff/preview exists for them yet (still
    // explicitly deferred).
    let proposedBrandIdentity: BrandIdentity | null = null;
    let proposedHero: { heroHeadline: string; heroSubheadline: string } | null = null;
    let proposedHomepageScalars: {
      primaryCallToAction: string;
      secondaryCallToAction: string | null;
      aboutUs: string;
      whyChooseUs: string;
    } | null = null;
    let proposedSectionOrder: { sectionOrder: (typeof SECTION_KEYS)[number][] } | null = null;

    if (primaryResult.touchesBrandContent) {
      proposedBrandIdentity = primaryResult.brandIdentity;
      proposedHero = {
        heroHeadline: primaryResult.homepageContent.heroHeadline,
        heroSubheadline: primaryResult.homepageContent.heroSubheadline,
      };
      proposedHomepageScalars = {
        primaryCallToAction: primaryResult.homepageContent.primaryCallToAction,
        secondaryCallToAction: primaryResult.homepageContent.secondaryCallToAction,
        aboutUs: primaryResult.homepageContent.aboutUs,
        whyChooseUs: primaryResult.homepageContent.whyChooseUs,
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
        // The structured fields still apply directly — carried from the
        // model's output when brand content was touched, otherwise kept.
        featuredCollections: primaryResult.touchesBrandContent
          ? primaryResult.homepageContent.featuredCollections
          : currentHomepageContent?.featuredCollections ?? [],
        faq: primaryResult.touchesBrandContent
          ? primaryResult.homepageContent.faq
          : currentHomepageContent?.faq ?? [],
        newsletterSection: primaryResult.touchesBrandContent
          ? primaryResult.homepageContent.newsletterSection
          : currentHomepageContent?.newsletterSection ?? "",
        footerContent: primaryResult.touchesBrandContent
          ? primaryResult.homepageContent.footerContent
          : currentHomepageContent?.footerContent ?? "",
        // Now flows through update_section_order (Phase 3B) — the direct
        // write keeps the current order untouched until approved, same as
        // hero/scalars/brandIdentity/storeIdentity above.
        sectionOrder: currentHomepageContent?.sectionOrder ?? [],
        customSection: primaryResult.touchesBrandContent
          ? primaryResult.homepageContent.customSection
          : currentHomepageContent?.customSection ?? null,
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
    if (proposedHomepageScalars) {
      await proposeAction(
        "update_homepage_content",
        proposedHomepageScalars,
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
  const finalReply =
    proposalSummaries.length > 0
      ? `${primaryResult.reply}\n\nA few of these need your review before they go live — I've prepared them for you: ${proposalSummaries.join("; ")}.`
      : primaryResult.reply;

  await prisma.storeMessage.create({
    data: {
      storeId: store.id,
      role: "assistant",
      content: finalReply,
      changes: changes.length > 0 ? changes : undefined,
    },
  });

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
    products.map((p) => searchProductImage(p.name, p.imagePrompt))
  );

  const store = await prisma.store.create({
    data: {
      userId: session.user.id,
      name: draft.name,
      slug,
      description: draft.description,
      tagline: draft.tagline,
      theme,
      blueprint: draft.blueprint ?? Prisma.DbNull,
      version: draft.version,
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
// freshly-persisted GeneratedRecommendation rows — no inline result needed.
export async function reviewBusinessWithGenesis() {
  const { userId, storeId } = await requireStorePermission(PERMISSIONS.ANALYTICS_VIEW);
  await generateGenesisRecommendations({ storeId, userId });
  redirect("/dashboard");
}

// PH-07 Layer 4 — approving a Genesis-proposed action. ANALYTICS_VIEW is
// only the page-level gate (finds the section, resolves storeId); the real
// authorization is execute()'s own requiredPermission check on the
// underlying Executable (e.g. STORE_MANAGE) — same two-layer pattern as
// every prior phase, not just cosmetic.
export async function approveGenesisAction(approvalRequestId: string) {
  const { storeId, userId } = await requireStorePermission(PERMISSIONS.ANALYTICS_VIEW);
  const approval = await prisma.approvalRequest.findFirstOrThrow({
    where: { id: approvalRequestId, storeId, status: "PENDING_APPROVAL" },
  });

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

  redirect("/dashboard");
}

export async function rejectGenesisAction(approvalRequestId: string) {
  const { storeId, userId } = await requireStorePermission(PERMISSIONS.ANALYTICS_VIEW);
  const approval = await prisma.approvalRequest.findFirstOrThrow({
    where: { id: approvalRequestId, storeId, status: "PENDING_APPROVAL" },
  });

  await prisma.approvalRequest.update({
    where: { id: approval.id },
    data: { status: "REJECTED", decidedByUserId: userId, decidedAt: new Date() },
  });

  // A rejected suggestion shouldn't keep nagging until the next full refresh.
  if (approval.recommendationId) {
    await prisma.generatedRecommendation.deleteMany({ where: { id: approval.recommendationId } });
  }

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
export async function revertApprovalRequest(approvalRequestId: string) {
  const { storeId, userId } = await requireStorePermission(PERMISSIONS.ANALYTICS_VIEW);
  const original = await prisma.approvalRequest.findFirstOrThrow({
    where: { id: approvalRequestId, storeId, status: "EXECUTED" },
  });

  const definition = GENESIS_ACTIONS[original.actionType];
  if (!definition) {
    throw new Error(`Unknown Genesis action type: ${original.actionType}`);
  }

  // Defense in depth, same as every other creation path — previousValues
  // was itself computed by this same registry's getCurrentValues at
  // proposal time, but re-validate before trusting it as fresh input.
  const parsedRevertInput = definition.inputSchema.safeParse(original.previousValues);
  if (!parsedRevertInput.success) {
    throw new Error("Can't revert this action — its previous value no longer matches the expected shape.");
  }

  const result = await execute(
    definition.executable,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parsedRevertInput.data as any,
    { storeId, actorType: "USER" }
  );

  if (result.status === "FAILED") {
    throw new Error(result.message);
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
  const approval = await prisma.approvalRequest.findFirstOrThrow({
    where: {
      id: approvalRequestId,
      storeId,
      status: "PENDING_APPROVAL",
      actionType: "update_product_image",
    },
  });

  const input = approval.input as { productId: string; imageUrl: string };
  const previousValues = approval.previousValues as {
    productId: string;
    imageUrl: string | null;
    rejectedCandidates?: string[];
  };

  const product = await prisma.product.findUniqueOrThrow({
    where: { id: input.productId },
    select: { name: true, description: true },
  });

  const rejectedCandidates = previousValues.rejectedCandidates ?? [];
  const excludeUrls = [
    ...(previousValues.imageUrl ? [previousValues.imageUrl] : []),
    input.imageUrl,
    ...rejectedCandidates,
  ];

  const candidate = await sourceProductImageCandidate(product, excludeUrls);

  if (candidate) {
    await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: {
        input: { productId: input.productId, imageUrl: candidate },
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
