import { z } from "zod";
import { ASSET_ROLES } from "@/lib/businessModel/assets";
import { productSurfaceKeys } from "@/lib/design/surfaces";
import type Anthropic from "@anthropic-ai/sdk";
import { GoalCaptureSchema, ChallengeCaptureSchema, EmployeeCaptureSchema, LocationCaptureSchema, OfferingCaptureSchema, IntentCaptureSchema } from "@/lib/businessModel/factCapture";
import { STOREFRONT_TARGET_KEYS } from "@/lib/storefront/targets";
import { REFINABLE_DIMENSION_KEYS, MAX_MUTATIONS_PER_IMPROVEMENT } from "@/lib/storefront/dimensions";

// UPLOAD INTENT IS A TOOL NOW (2026-08-22, Unified Intelligence).
//
// It was the last surviving pre-call: a full Opus round trip, on EVERY message,
// to answer one question — before the unified call ran at all. It stayed there
// for a permission reason rather than a reasoning one ("it must run before the
// store:manage gate"), and that gate has since moved onto the individual tool
// (lib/execution/toolPolicy.ts), so the ordering constraint is gone.
//
// NOT REPLACED WITH A PATTERN MATCH, deliberately, and the old prompt says why:
// it had to distinguish "I have a PDF for you" from "the photo on my homepage
// looks bad" from "remove the old products and let's upload the first ring" —
// where uploading is real but is NOT the whole message, and answering it as
// though it were would silently drop a real removal instruction. That is
// genuine language understanding, and a regex doing it badly would make J4
// worse, not cheaper. As a tool it costs nothing extra: the unified call is
// already reading the whole message and already choosing among seventeen other
// things it could mean.
//
// Response Modes plan (2026-08-07), Phase 1 — replaces four sequential
// classifier calls (data-question, business-fact, campaign-request,
// image-request) plus the implicit "none matched" fallthrough to PRIMARY
// with one tool-enabled call in applyGenesisMessageToStore. Upload-intent
// stays a separate, earlier classifier there for a real permission reason
// (it must run before the store:manage gate) — these five tools all
// require store:manage and only ever run after that gate.
//
// Each input schema deliberately drops the trigger boolean and reply-text
// fields the old classifier schemas carried (isDataQuestion, isImageRequest,
// confirmationReply, etc.) — calling the tool at all IS the trigger now, and
// the natural-language reply comes from the model's own accompanying text
// block in the same turn, not a schema field.

// WHICH EXISTING FACT A STATEMENT CORRECTS (D5). On every member, because any
// owner-authoritative fact can be restated — and nullable, because most
// statements correct nothing at all.
const CORRECTS = { supersedesRecordId: z.string().nullable().optional() };

export const BusinessFactCaptureInputSchema = z.discriminatedUnion("entityType", [
  z.object({ entityType: z.literal("goal"), data: GoalCaptureSchema, ...CORRECTS }),
  z.object({ entityType: z.literal("challenge"), data: ChallengeCaptureSchema, ...CORRECTS }),
  z.object({ entityType: z.literal("employee"), data: EmployeeCaptureSchema, ...CORRECTS }),
  z.object({ entityType: z.literal("location"), data: LocationCaptureSchema, ...CORRECTS }),
  z.object({ entityType: z.literal("offering"), data: OfferingCaptureSchema, ...CORRECTS }),
  z.object({ entityType: z.literal("intent"), data: IntentCaptureSchema, ...CORRECTS }),
]);
export type BusinessFactCaptureInput = z.infer<typeof BusinessFactCaptureInputSchema>;

// Real production bug, found via trace evidence (2026-08-08) — every
// single J4 Portal message was failing the unified call with a genuine
// Anthropic 400 ("tools.1.custom.input_schema.type: Field required"),
// silently forcing every turn onto the old non-streaming fallback path.
// Root cause, reproduced locally: z.toJSONSchema() on a discriminated
// union puts "oneOf" at the schema root with no root "type" key —
// Anthropic's tool input_schema requires "type": "object" at the root.
// This is a separate, looser schema purely for what Anthropic sees;
// BusinessFactCaptureInputSchema (the real discriminated union) stays
// the source of truth for TypeScript narrowing in route.ts, and the real
// per-entityType strict validation still happens there via
// ENTITY_REGISTRY[entityType].schema.safeParse after the tool call
// returns, completely unchanged.
const BUSINESS_FACT_CAPTURE_TOOL_SCHEMA = z.object({
  // THE SIX OWNER-AUTHORITATIVE TYPES (D3). offering and intent joined on
  // 2026-08-24: the owner is the authoritative source for what a business sells
  // and what they want it to be, and until now those two could be recorded at
  // onboarding and never corrected. A connector-owned type is deliberately not
  // here — "correcting" a QuickBooks transaction would write a fact the next
  // sync silently overwrites.
  entityType: z.enum(["goal", "challenge", "employee", "location", "offering", "intent"]),
  data: z.record(z.string(), z.unknown()),
  // WHICH EXISTING FACT THIS CORRECTS, when it corrects one (D5).
  //
  // Named explicitly or left null — never guessed. A restatement with no target,
  // of a type the business may have many of, is a NEW fact rather than a silent
  // correction of whichever one looked closest. offering and intent do not need
  // it: a business has one of each, so the target is unambiguous.
  supersedesRecordId: z.string().nullable(),
});

export const RequestImageChangeInputSchema = z.object({
  scope: z.enum(["all", "specific"]).nullable(),
  productNames: z.array(z.string()).nullable(),
});
export type RequestImageChangeInput = z.infer<typeof RequestImageChangeInputSchema>;

// 2026-08-08 — the missing product-delete capability, same real scope-
// resolution shape as RequestImageChangeInputSchema above (an "all"/
// "specific" split resolved against the real active product list, never
// trusting the model's own restatement of which product it means). A
// separate tool, not folded into edit_store_content: this is a discrete,
// list-based structural removal, not a content-generation request, and
// (unlike edit_store_content) never needs the PRIMARY content pipeline —
// it's handled as its own real fast path exactly like request_image_change.
export const RequestProductRemovalInputSchema = z.object({
  scope: z.enum(["all", "specific"]).nullable(),
  productNames: z.array(z.string()).nullable(),
});
export type RequestProductRemovalInput = z.infer<typeof RequestProductRemovalInputSchema>;

// J4 approvable product content changes (2026-08-09) — "if J4 can perform
// the change, J4 should perform the change after I approve it... product
// names, descriptions" (Sean, real production feedback after J4 told him
// to "paste the winners" into each product's name field by hand). Same
// real scope-resolution shape as RequestImageChangeInputSchema/
// RequestProductRemovalInputSchema — this tool only ever resolves WHICH
// products and WHAT KIND of change; it deliberately does not generate the
// actual proposed name/description text itself (a routing-call schema is
// the wrong place for real, grounded content generation — see
// generateProductContentChanges, called separately once scope is
// resolved, same real "resolve scope here, generate content in a focused
// follow-up call" split request_image_change already established for
// photos).
export const RequestProductContentChangeInputSchema = z.object({
  scope: z.enum(["all", "specific"]).nullable(),
  productNames: z.array(z.string()).nullable(),
  changeType: z.enum(["name", "description", "both"]),
});
export type RequestProductContentChangeInput = z.infer<typeof RequestProductContentChangeInputSchema>;

// Storefront Canvas, step 3 reachability (2026-08-12) — the tool that lets a
// merchant ask for one small storefront improvement in conversation.
//
// Its own tool rather than folded into edit_store_content, for exactly the
// reason RequestProductRemovalInputSchema above already documents for itself:
// this is a discrete, enum-bounded structural change, not a content-generation
// request. It never needs the PRIMARY content pipeline, so it is handled as
// its own fast path like request_image_change and request_product_removal.
//
// Both vocabularies are closed at the tool boundary, so the model picks from
// real targets and real dimensions rather than inventing either. The same
// values are validated again by GENESIS_ACTIONS.refine_storefront.inputSchema
// after the call returns, and a third time inside the executable — the tool
// schema is a guide for the model, never the security boundary.
const RefineChangeSchema = z.object({
  dimension: z.enum(REFINABLE_DIMENSION_KEYS as [string, ...string[]]),
  value: z.string(),
});

// At most three directions. Two is the shape Sean described ("I see two
// strong directions"); three is the outer limit before a chooser stops being
// a choice and becomes a menu. Also kept deliberately small because this
// codebase has a recorded API ceiling on tool schema size — see
// lib/intelligence/cognitiveLayer.ts, where a union of nine full input shapes
// returned "compiled grammar is too large". Reusing RefineChangeSchema rather
// than restating it keeps the compiled grammar as small as this can be.
const MAX_DIRECTIONS = 3;

export const RefineStorefrontToolInputSchema = z.object({
  target: z.enum(STOREFRONT_TARGET_KEYS as [string, ...string[]]),
  changes: z.array(RefineChangeSchema).min(1).max(MAX_MUTATIONS_PER_IMPROVEMENT),
  reason: z.string(),
  summary: z.string(),
  // Optional, and genuinely optional: most requests have one right answer and
  // offering a choice for its own sake is worse than proposing one. Set only
  // when there are real, meaningfully different ways to satisfy the request.
  // When present, `changes` above must be the FIRST direction's change set, so
  // every existing reader that knows nothing about directions still sees a
  // complete, valid proposal.
  directions: z
    .array(
      z.object({
        label: z.string(),
        reason: z.string(),
        changes: z.array(RefineChangeSchema).min(1).max(MAX_MUTATIONS_PER_IMPROVEMENT),
      })
    )
    .min(2)
    .max(MAX_DIRECTIONS)
    .optional(),
});
export type RefineStorefrontToolInput = z.infer<typeof RefineStorefrontToolInputSchema>;

// "Make me a logo" (2026-08-16). ownerDirection carries the merchant's own
// words when they asked for something specific, and it is weighted LAST in the
// generation prompt so it outranks everything J4 inferred about the business.
// wantsAlternatives is ONLY ever true when the merchant actually asked for
// options — never a default, because an offer that always fires is not an
// offer (see WORK_STUDIO.md's no-pressure rule).
export const GenerateBrandLogoInputSchema = z.object({
  ownerDirection: z.string().nullable(),
  wantsAlternatives: z.boolean(),
});

// "Put my logo on a T-shirt" (2026-08-16). surface is a key from
// lib/design/surfaces.ts, never a free string — the model picks from the real
// registry, so a garment we do not support cannot reach the compositor.
export const CreateDesignInputSchema = z.object({
  // DERIVED FROM THE REGISTRY, never hand-listed (2026-08-18). This used to
  // name two garments, which meant adding a mug to the catalogue also meant
  // remembering to edit this file. Now a new surface is one entry in
  // surfaces.ts and the model sees it immediately.
  surface: z.enum(productSurfaceKeys() as [string, ...string[]]),
  assetRole: z.string().nullable(),
  // Colour is a real input. Asking for a black hoodie and receiving a grey one
  // is a wrong answer, not a stylistic near-miss.
  color: z.enum(["black", "white", "navy", "grey", "sand", "forest"]).nullable(),
});

// "Yes, add it to my store" (2026-08-17). The end of the Studio chain: an
// approved Design becomes a real Product the storefront sells. name and price
// come from J4 because the owner should not have to fill in a form to say yes
// — they can correct either one afterwards the way they would any product.
export const ApproveDesignAsProductInputSchema = z.object({
  name: z.string(),
  priceInCents: z.number().int().positive(),
  description: z.string().nullable(),
});

// Storefront compositions (2026-08-18). The same Design model as apparel —
// assets + surface + arrangement — pointed at a storefront surface instead of a
// garment. subject is the merchant's own words for what to compose from, so J4
// can pick the right assets rather than guessing from a filename.
export const CreateCompositionInputSchema = z.object({
  surface: z.enum(["section.collage", "section.hero", "section.feature"]),
  columns: z.number().int().min(1).max(4),
  subject: z.string().nullable(),
});

// Approving a composition as a STOREFRONT ASSET rather than a product. This is
// the distinction Sean called huge: "something the customer can buy" versus
// "something that makes the store look better and tells the brand story."
export const ApproveCompositionInputSchema = z.object({
  // Left as literals: this is a model-facing zod enum, and the schema the
  // model is shown must read as the exact strings it may emit.
  role: z.enum([ASSET_ROLES.storefrontHero, "storefront.feature", "brand.graphic"]),
  summary: z.string(),
});

// Evaluating and improving the storefront (2026-08-18). No input: J4 reads the
// real structural state itself rather than being told what to look at, which is
// the whole point of it having an opinion.
// Taking the owner somewhere (2026-08-18).
//
// Sean: "Do not make J4 simply respond with instructions like 'Go to Studio and
// click...' when J4 can take the user there itself." And the rule that keeps it
// from becoming a chatbot with links: "Don't make every question trigger
// navigation." A question gets an answer; a decision gets a destination.
//
// Destinations are a closed list matching the real rooms, so a hallucinated
// route can never reach the router.
export const TakeMeThereInputSchema = z.object({
  /**
   * A THING ON THE BUSINESS MAP, by the name the merchant uses (P2).
   *
   * Optional, and the surface destinations below are untouched: this is for
   * "show me the Copper Mug", which used to be answerable only as "here is
   * Products, look for it". Resolved server-side against this store's own
   * map - a name that is not on it goes nowhere rather than somewhere
   * approximate.
   *
   * A NAME, not an id. Node ids are deliberately never put in front of the
   * model, so it could not send one even if this asked for it.
   */
  nodeLabel: z.string().min(1).nullable().optional(),
  destination: z.enum([
    "studio",
    "studio.upload",
    "storefront",
    "commerce",
    "office",
    "account",
    "connections",
  ]),
  // What they want to do when they get there, in their own words. Carried
  // through so the destination arrives ready rather than blank.
  intent: z.string().nullable(),
});

const EMPTY_INPUT_SCHEMA = z.object({});

// Hard J4 capability requirement (2026-08-08): once an upload succeeds,
// the file is already permanently saved (ingestBusinessAsset writes a
// real BusinessRecord unconditionally, before classification even runs)
// — confirmed by direct audit that businessProfile's own asset query has
// no limit or expiry, so every uploaded asset is always reachable in
// every future conversation. The real gap was never storage, it was that
// a LATER turn referencing an already-uploaded file ("save this," "save
// this as my logo") had no tool to reach at all, so the honest-capability
// rule elsewhere correctly said it couldn't help — even though the file
// was already safely saved. `role` is deliberately the one real input
// this needs today (null = "just keep it," a string = the merchant's own
// words for what they want it designated as) — this exact shape is what
// the future asset-designation milestone will consume too, so wiring
// real designation in later is additive to this tool, never a rebuild.
export const ManageBusinessAssetInputSchema = z.object({
  role: z.string().nullable(),
});
export type ManageBusinessAssetInput = z.infer<typeof ManageBusinessAssetInputSchema>;

// The merchant answering J4's own question about what a supplier charges.
//
// NO IDENTITY FIELDS, deliberately. A supplier product is identified by business,
// source, external id and variant, and a language model cannot know the last
// three — letting it emit a sourceKey would mean a hallucinated string deciding
// which supplier's terms an owner's answer lands on. The model names the product
// in the merchant's own words and the server resolves it against the question it
// actually asked (lib/sourcing/economicsChat.ts).
//
// EVERY FIGURE NULLABLE, also deliberately. An owner who rang their supplier and
// came back with one of the two answers has found out something real; a schema
// that demanded both would either lose it or invite the model to fill in the
// half nobody said.
export const AnswerSupplierEconomicsToolInputSchema = z.object({
  productName: z
    .string()
    .nullable()
    .describe("The product the merchant is talking about, in their own words. Null only if they genuinely did not say and there is more than one question outstanding."),
  outcome: z
    .enum(["quoted", "supplier_would_not_say", "dont_know_yet"])
    .describe("What actually happened: they were given figures, the supplier refused to say, or they have not found out yet."),
  minimumOrderUnits: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("How many units the supplier makes them order at once. Null if they did not say."),
  bulkUnitCostInCents: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("What one unit costs at that quantity, IN CENTS — $4.10 is 410. Null if they did not say."),
  shippingPerUnitInCents: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Delivery per unit on that order, in cents. 0 only if they actually said delivery is included; null if they did not mention it."),
  leadTimeDays: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("How many days the supplier takes to deliver. Null if they did not say."),
  note: z
    .string()
    .nullable()
    .describe("Anything else the merchant said about the quote, in their words. Null if nothing."),
});
export type AnswerSupplierEconomicsToolInput = z.infer<typeof AnswerSupplierEconomicsToolInputSchema>;

/**
 * The merchant telling J4 that something he BELIEVES is wrong.
 *
 * A CLAIM, NEVER AN ID. Beliefs reach the model as prose - renderDigest
 * writes "You currently believe: <claim> [maturity]" - so the claim is the
 * only handle either of them has, and a belief id has never been in front of
 * the model to send back.
 */
export const ContradictBeliefInputSchema = z.object({
  claim: z.string().min(1),
  /**
   * Their reason, in their own words, stored verbatim. Null when they only
   * said it was wrong.
   *
   * NULLABLE BUT REQUIRED, the same shape take_me_there's intent uses: the
   * key must be present. A tool call that omits it fails this parse, which is
   * the intended strictness rather than an oversight.
   */
  note: z.string().nullable(),
});
export type ContradictBeliefInput = z.infer<typeof ContradictBeliefInputSchema>;
export const STORE_CHAT_UNIFIED_TOOL_NAMES = [
  "look_up_business_data",
  "capture_business_fact",
  "contradict_belief",
  "plan_campaign",
  "request_image_change",
  "request_product_removal",
  "request_product_content_change",
  "request_sale",
  "toggle_order_fulfilled",
  "attach_tracking",
  "correct_tracking",
  "approve_pending_changes",
  "edit_store_content",
  "manage_business_asset",
  "refine_storefront",
  "answer_supplier_economics",
] as const;
export type StoreChatUnifiedToolName = (typeof STORE_CHAT_UNIFIED_TOOL_NAMES)[number];

/**
 * A sale or a discount code, as the model proposes it.
 *
 * SCOPE IS INCLUDE/EXCLUDE, which is the whole reason this tool exists. The
 * three older scoped tools understand "all" or an exact list of names, and no
 * way at all to say the most ordinary sentence a merchant says: "everything
 * except the T-shirt, hoodie and mug". The model can already READ which
 * products are which — it receives the list every turn — so what was missing
 * was never comprehension, only vocabulary.
 */
/**
 * STARTING a sale and ENDING one are different requests (2026-09-03).
 *
 * This was one flat create shape, and the tool's own description promised
 * "take the pyramid off sale" — a request the schema could not express. A
 * model following that description faithfully emitted a CREATE for an END,
 * so an owner asking to stop a sale was offered a new one, in the `money`
 * category. Absent is safe; wrong is not.
 *
 * A DISCRIMINATED UNION rather than an optional flag, because a flag that
 * defaults silently is the same bug again: an end request that forgets the
 * flag becomes a creation. Here the model must say which it means, and the
 * handler refuses anything it did not say.
 *
 * MODIFYING an existing sale (changing its discount, dates or products) is
 * deliberately NOT here. `update_promotion` supports it and this tool does
 * not, so the description says so and tells the model to say so too —
 * rather than reaching for the shape it does have.
 */
/**
 * Saying a parcel has gone out, or fixing a number already sent (2026-09-03).
 *
 * NO ORDER NUMBER EXISTS TO ASK FOR. The Order model carries a cuid and
 * Stripe's session id, and neither is something an owner says. So an order is
 * named the way they actually refer to one - what was bought, and who bought
 * it - and the handler resolves that against their own orders. Inventing a
 * customer-facing order number to make this tidier would be a new identifier
 * nobody asked for, on a record customers already receive email about.
 *
 * ATTACH AND CORRECT ARE DIFFERENT ACTS, not one with a flag. Attaching is
 * additive and the executable refuses an order that already has a number.
 * Correcting REPLACES one a customer may already be following, which is a
 * different thing to agree to, so it is a different tool with its own
 * approval.
 */
/**
 * Which order to mark shipped, or un-mark. No tracking number involved -
 * that is attach_tracking, which marks it fulfilled as a side effect of
 * having a number to give the customer. This is the plain flag, for an order
 * that went out without one or was marked by mistake.
 */
export const OrderFulfilmentInputSchema = z.object({
  productName: z.string().min(1).nullable().optional(),
  buyerEmail: z.string().min(1).nullable().optional(),
});

export const TrackingInputSchema = z.object({
  /** The product as it appears on the order, e.g. "Copper Mug". */
  productName: z.string().min(1).nullable().optional(),
  /** The buyer's email as it appears on the order, when the owner names them. */
  buyerEmail: z.string().min(1).nullable().optional(),
  trackingNumber: z.string().min(1),
  /** USPS when the owner does not say. */
  carrier: z.string().nullable().optional(),
});

export const RequestSaleInputSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("create"),
    /** What the merchant will see it called. For a code, name it for them. */
    name: z.string().min(1),
    kind: z.enum(["SALE", "CODE"]),
    /** Required for a CODE. Ignored for a SALE. */
    code: z.string().nullable().optional(),
    discountType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]),
    percentOff: z.number().int().min(1).max(100).nullable().optional(),
    amountOffInCents: z.number().int().min(1).nullable().optional(),
    /** "all", or the exact product names the merchant named. */
    include: z.enum(["all", "named"]),
    includeNames: z.array(z.string()).nullable().optional(),
    /** Products to leave out of whatever `include` selected. */
    excludeNames: z.array(z.string()).nullable().optional(),
    startsAt: z.string().nullable().optional(),
    endsAt: z.string().nullable().optional(),
  }),
  z.object({
    intent: z.literal("end"),
    /**
     * The promotion's own name, as the owner says it and as it appears in
     * the "Running now:" line of the business context.
     *
     * A NAME, never an id. The id exists in the understanding for the
     * handler to resolve this against; putting one in front of a model is
     * how a cuid ends up quoted back to an owner.
     */
    promotionName: z.string().min(1),
  }),
]);

export function buildStoreChatUnifiedTools(): Anthropic.Tool[] {
  return [
    {
      name: "look_up_business_data",
      description:
        "Call this when the merchant is asking to be TOLD or EXPLAINED something using real business data or understanding — a factual question (revenue, orders, customers, appointments, WHICH SYSTEMS ARE CONNECTED and what they have synced — including whether one is stale or has never synced — or how their connected social accounts are performing — reach, engagement, followers, which posts did well), or a genuine planning/strategy question ('what should I do next', 'build me a 90-day plan', 'how would you spend N Growth Points'). Never call this for a request to actually change something, and never for a request to CREATE something — making a logo, a design, a product or any other real artefact is the relevant creation tool, not this one. You already have a summary of the business above, so do not reach for this as a preliminary step before acting; call it when being TOLD something IS what was asked for. CONNECTIONS ARE UNDERSTANDING, NOT SETTINGS. Tell me about my connections, what is connected, is my accounting still syncing — these are questions about the business and this tool answers them: businessProfile.connectedSystems and the invoice, campaign and appointment summaries built from those systems are the real answer. Never send the merchant to a settings screen to read something you were already given, and never describe integrations as somebody else's department — what the business is connected to is part of what you understand about it. Taking them to the Connections screen is take_me_there; actually connecting or disconnecting something is neither tool and is not something you can do yet, so say that plainly rather than implying either.",
      input_schema: z.toJSONSchema(EMPTY_INPUT_SCHEMA) as Anthropic.Tool.InputSchema,
    },
    {
      name: "contradict_belief",
      description:
        "Call this when the merchant tells you that something YOU BELIEVE about their business is wrong. You are shown these every turn as 'You currently believe: ...' - they are your own conclusions drawn from evidence, not facts the merchant gave you, so being corrected is them doing you a favour and should be received that way rather than defended. Pass claim as the belief they are contradicting, in the words it was shown to you. Pass note as their reason in THEIR words, verbatim and untidied, or null when they only said it was wrong - a reason you invented or smoothed is worse than none, because somebody reading the record later will take it for theirs. Do NOT call this when they disagree with something you merely said in conversation, when they are stating a business fact (that is capture_business_fact), or when a belief has simply gone out of date rather than being wrong - retiring and contradicting are different records and a later reader must be able to tell them apart. Only the business owner can do this; if an employee says it the write is refused, and you must say so plainly rather than implying it worked.",
      input_schema: z.toJSONSchema(ContradictBeliefInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "show_upload_options",
      description:
        "Call this when the WHOLE message is the merchant saying they have files they want to give you — photos, documents, PDFs, spreadsheets, contracts, logos, invoices — or asking how to upload or share files with you. 'I have files I want to upload', 'can I send you my logo', 'I have a PDF of my supplier contract', 'how do I upload photos'. Do NOT call this for a message that merely mentions a photo or document in passing without offering one right now ('the photo on my homepage looks bad' is about existing content), and critically do NOT call it for a compound message where uploading is only one part of what is being asked ('remove the old products and let's upload the first ring' is a real instruction about removal that happens to mention uploading — handle the removal). Calling this when something else was also asked silently drops everything else they said.",
      input_schema: z.toJSONSchema(EMPTY_INPUT_SCHEMA) as Anthropic.Tool.InputSchema,
    },
    {
      name: "capture_business_fact",
      description:
        "Call this when the merchant is stating a durable fact about their business you should remember — a goal they have, a challenge they're currently facing, a new employee, or a location — not a question, not a content-change request, not ordinary conversation. Fill in only what you can confidently infer from the actual message; leave optional fields null rather than guessing.",
      input_schema: z.toJSONSchema(BUSINESS_FACT_CAPTURE_TOOL_SCHEMA) as Anthropic.Tool.InputSchema,
    },
    {
      name: "plan_campaign",
      description:
        "Call this when the merchant is asking you to actually plan or create a marketing campaign — real promotional content across one or more channels (email, social, or similar). Not a question about marketing strategy — that's look_up_business_data.",
      input_schema: z.toJSONSchema(EMPTY_INPUT_SCHEMA) as Anthropic.Tool.InputSchema,
    },
    {
      name: "request_image_change",
      description:
        "Call this when the merchant is asking to replace, regenerate, or find a new photo for one or more existing products. Resolve scope yourself: 'all' when they clearly mean every active product, 'specific' with productNames set to the exact matching names, or null only when the scope is genuinely unclear (then ask a specific clarifying question in your reply text).",
      input_schema: z.toJSONSchema(RequestImageChangeInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "request_product_removal",
      description:
        "Call this when the merchant explicitly asks to remove, delete, discontinue, or get rid of one or more existing products — e.g. 'the old ones are obsolete, remove them', 'discontinue the wipes', 'delete that product'. This is a DESTRUCTIVE, irreversible action: calling this tool only PROPOSES the removal for the merchant's own review and approval, it never deletes anything immediately. Resolve scope against the active product list the same way as request_image_change: 'all' when they clearly mean every active product, 'specific' with productNames set to the exact matching names, or null only when genuinely unclear (then ask a specific clarifying question in your reply text).",
      input_schema: z.toJSONSchema(RequestProductRemovalInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "request_product_content_change",
      description:
        "Call this when the merchant is asking you to rename, rewrite, improve, or clean up the name and/or description of one or more EXISTING products — this includes both an explicit instruction ('change the name to X') and a genuine request for your own recommendation ('these names are too keyword-stuffed, what should they be', 'review my products and suggest better descriptions'). Either way, you have the real capability to prepare the actual change for the merchant's approval — never just describe what they should type in themselves. Resolve scope the same way as request_image_change: 'all' when they clearly mean every active product, 'specific' with productNames set to the exact matching names, or null only when genuinely unclear (then ask a specific clarifying question in your reply text). Set changeType to whichever the merchant is actually asking about — 'name', 'description', or 'both'. This tool only decides WHICH products and WHAT KIND of change; the actual proposed wording is generated separately, grounded in what you really know about the business and each product, not guessed from the existing text alone.",
      input_schema: z.toJSONSchema(RequestProductContentChangeInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "request_sale",
      description:
        "Call this to START a sale or discount code, or to END one that is already running. Set intent to whichever the merchant is actually asking for. " +
        "intent 'create' — 'put everything 26% off', 'put all the tensor rings on sale except the t-shirt, hoodie and mug', 'make me a code for 10% off'. Resolve the scope yourself from the product list you were given: include 'all' when they mean every product, or 'named' with includeNames set to the exact matching names — and put anything they explicitly want left OUT into excludeNames, which is how 'everything except X and Y' is expressed. Use the real product names as they appear in that list, not the merchant's shorthand. " +
        "intent 'end' — 'take the pyramid off sale', 'stop the spring sale', 'end that discount code'. Set promotionName to the name of the promotion as it appears in the 'Running now:' line of the business context above. If nothing is running, or the merchant names something that is not there, say so — do not create a new promotion instead. " +
        "You CANNOT change an existing promotion's discount, dates or products with this tool. If that is what they are asking for, tell them plainly that you can start one or end one, and never propose a NEW promotion as a way of changing an old one — that leaves both running. " +
        "Either way this PROPOSES the change for the merchant's own review and approval; it never changes a price immediately. Never tell the merchant to go and do it themselves; you can prepare the real thing for them to approve.",
      input_schema: z.toJSONSchema(RequestSaleInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "toggle_order_fulfilled",
      description:
        "Call this when the merchant wants an order marked as SHIPPED without giving you a tracking number, or wants one un-marked because it was flagged by mistake — 'the mug order went out yesterday', 'mark Jane's ring as shipped', 'that one has not actually shipped, undo it'. " +
        "If they give you a tracking NUMBER, use attach_tracking instead — that records the number and marks it shipped in one step, which is what the customer actually needs. " +
        "Identify the order the way they did: productName and/or buyerEmail as they appear in the orders you were given. Never ask for an order id; they do not have one. If more than one order matches, ask which. " +
        "This PROPOSES the change for their approval. If the order's state changes before they approve it, Genesis refuses the stale approval rather than flipping the flag the wrong way — so tell them what you are about to do in terms of where the order is NOW.",
      input_schema: z.toJSONSchema(OrderFulfilmentInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "attach_tracking",
      description:
        "Call this when the merchant says an order has SHIPPED and gives you a tracking number — 'the mug order went out, tracking 1Z999AA10123456784', 'shipped Jane's ring today, here's the number'. " +
        "Identify the order the way they did: set productName to the product on that order and/or buyerEmail to the customer, using the values as they appear in the orders you were given — call look_up_business_data first if you do not have them. Do not ask the merchant for an order id; they do not have one. " +
        "If more than one order matches, ask which one rather than guessing — attaching a number to the wrong order sends a real customer to a courier page about somebody else's parcel. " +
        "Use attach_tracking only for an order with NO tracking yet. If it already has one and they are fixing it, that is correct_tracking. " +
        "This PROPOSES the change for their approval and marks the order fulfilled when approved; it never writes to the order immediately.",
      input_schema: z.toJSONSchema(TrackingInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "correct_tracking",
      description:
        "Call this when the merchant wants to REPLACE a tracking number already on an order — 'I put the wrong tracking on the mug order', 'that number was for a different parcel, the right one is ...'. " +
        "Identify the order exactly as for attach_tracking: productName and/or buyerEmail, never an id. " +
        "Only for an order that ALREADY has a number. If it has none, that is attach_tracking. " +
        "This matters more than an attach, because the customer may already be following the old number — so it PROPOSES the change for the merchant's approval and records what it replaced.",
      input_schema: z.toJSONSchema(TrackingInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "approve_pending_changes",
      description:
        "Call this when the merchant gives clear, explicit authorization to proceed with change(s) you already proposed and are still awaiting their decision on (see 'Awaiting your decision' in the context below, if present) — e.g. 'approve all', 'approve them', 'yes, make the changes', 'take care of everything', 'do it'. This executes the real, already-prepared proposal(s) exactly as shown — it never re-analyzes or regenerates anything, so never call this to prepare a NEW change (that's request_product_content_change, request_image_change, request_product_removal, or edit_store_content instead). Only call this when there really is something awaiting a decision noted below; if there's nothing pending, treat the message as plain conversation instead.",
      input_schema: z.toJSONSchema(EMPTY_INPUT_SCHEMA) as Anthropic.Tool.InputSchema,
    },
    {
      name: "edit_store_content",
      description:
        "Call this when the merchant is asking to actually change the store's identity, tagline, description, theme, brand identity, homepage content, policies, or design direction — anything that edits the live store, rather than answering a question, capturing a fact, planning a campaign, or changing a product photo.",
      input_schema: z.toJSONSchema(EMPTY_INPUT_SCHEMA) as Anthropic.Tool.InputSchema,
    },
    {
      name: "manage_business_asset",
      description:
        "Call this when the merchant asks you to save, keep, hold onto, or designate a file they've already uploaded — e.g. 'save this', 'keep this for later', 'save this as my logo', 'use this as the product photo', 'remember this as our supplier agreement'. This ALWAYS refers to the most recently uploaded photo or document in this conversation, never something never uploaded. If the merchant names a specific role or purpose for it (a logo, a product photo, a brand guide, an agreement — their own words, don't invent one), set role to that; if they just say 'save this' / 'keep this' with no stated purpose, set role to null. Saying 'this is our logo' or 'use this as my logo' is the normal way a merchant who ALREADY HAS a logo gives it to you — take it, designate it, and work with it from then on. Never follow that by suggesting you could make them a different one.",
      input_schema: z.toJSONSchema(ManageBusinessAssetInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "generate_brand_logo",
      description:
        // TWO WORKAROUNDS REMOVED FROM THIS DESCRIPTION (2026-08-22).
        //
        // It used to say "this tool reads their real business understanding
        // itself, so do NOT call look_up_business_data first" — a rule that
        // existed only because the deciding call had no business context and
        // might otherwise have gone looking for some. It has the context now.
        //
        // And it used to say "if the merchant already has a logo, do NOT call
        // this" — an instruction the model had NO DATA TO OBEY, since
        // designated assets were not in its context at all. The digest now
        // states which asset roles are held, so this is a fact it can check
        // rather than a rule it had to take on trust.
        "THE tool for making a logo. Call this whenever the merchant asks you to make, design, create or generate a LOGO or brand mark for their business — 'make me a logo', 'can you design a logo', 'I need a mark for the brand'. Build the direction from what you already know about their business rather than asking them to describe everything first; one specific question is fine only if you truly have nothing to work from. Set ownerDirection to the merchant's OWN words about what they want whenever they gave any ('something with a wave', 'no blue', 'keep it simple') — those words outrank anything you inferred — and null when they just asked for a logo. Set wantsAlternatives ONLY when they actually asked for options or said they are unsure ('show me a few', 'I don't know what I want'); never set it true just because options are possible. If the context above shows a brand logo is already held, do not offer to make another unless they explicitly ask for one — being able to make another is not a reason to raise it. This PROPOSES a logo for their approval; it never changes their brand immediately.",
      input_schema: z.toJSONSchema(GenerateBrandLogoInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "create_design",
      description:
        "Call this when the merchant asks you to MAKE THEM A PRODUCT, or to put an existing asset of theirs — usually their logo — onto something physical. Both are the same job: 'make me a hoodie', 'I want a mug', 'can you do a tote bag' mean their logo on that item unless they name something else, so act rather than asking which asset. Examples: 'put my logo on a t-shirt', 'can you make a hoodie with our mark on it', 'let's see that on a shirt'. Pick surface from the supported list based on what they said. The catalogue covers apparel, headwear, drinkware, accessories and print, so match their words to the closest real surface rather than refusing. Set assetRole to 'brand.logo' when they mean their logo (which is almost always), or null if you genuinely cannot tell which asset they mean, in which case ask them in your reply. Set color whenever they name one ('a black hoodie', 'on white'), and null when they do not — do not pick a colour they did not ask for. This composes their REAL approved asset onto the surface and shows them a mockup for approval; it does not create a product to sell yet, and it never invents artwork. Do NOT call this to create the logo itself — that is generate_brand_logo.",
      input_schema: z.toJSONSchema(CreateDesignInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "approve_design_as_product",
      description:
        "Call this when the merchant approves a design you have just shown them AND wants it in their store — 'yes', 'approve it', 'add it to my store', 'let's sell that', 'put it on the storefront'. Only call this when there is a design in this conversation they are actually responding to; a bare 'yes' with no design on the table is not this. Set name to a real product name you would put in a shop (their brand plus the item, not 'Design 1'), priceInCents to a sensible retail price for that item, and description to one honest sentence about it, or null. This CREATES a real product the storefront will sell, so never call it speculatively — only on their explicit approval. If they are still deciding, or asking for a change, that is not this tool.",
      input_schema: z.toJSONSchema(ApproveDesignAsProductInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "create_composition",
      description:
        "Call this when the merchant asks you to make a GRAPHIC out of their own images — a collage, a hero banner, a promotional or brand graphic, a featured section, something for social. Any of those is the same job: several of their images composed into one image — 'make a collage of these three bracelet photos', 'build me a hero image using my product shots', 'put together a featured section from my candles'. Choose surface by what it is for: section.collage for a square multi-image collage or a promotional/social graphic, section.hero for a wide banner across the top of the storefront, section.feature for a section highlighting a group of products. A request with no obvious shape ('make me a promotional graphic') is section.collage. Set columns to how many across the arrangement should read (2 for a pair or a 2x2, 3 for a row of three). Set subject to the merchant's OWN words for what to include ('bracelets', 'the candles', 'lifestyle shots') so the right images are used. If they do not say which images — 'create a collage', 'make me a promotional graphic' — set subject to null and compose from what they already have rather than asking them to choose first. They can tell you to change it once they can see it, which is faster than a question. This composes their REAL images and shows the result for approval; it is NOT a product and does not go on sale. Use create_design instead for putting one asset onto a garment.",
      input_schema: z.toJSONSchema(CreateCompositionInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "approve_composition",
      description:
        "Call this when the merchant approves a composition you just showed them and wants it USED on their storefront — 'yes, put that on my storefront', 'use it as the hero', 'that's the one'. Pick role by where it belongs: storefront.hero for the banner at the top, storefront.feature for a section further down, brand.graphic for something they will reuse elsewhere. summary is one honest sentence describing it. This makes it a storefront asset, NOT a product for sale — if they want to SELL what you made, that is approve_design_as_product instead. Only call this on their explicit approval.",
      input_schema: z.toJSONSchema(ApproveCompositionInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "improve_storefront",
      description:
        "Call this when the merchant asks how their store LOOKS overall, or asks you to improve it, or asks what you would change — 'how does my storefront look', 'can you make this better', 'what would you improve', 'make the store feel more premium', 'this looks plain'. You will be given a real structural read of their storefront: how many products have photography, what imagery they have that isn't product photos, whether anything is composed at the top, whether products could be grouped into collections. Use it to say what you would actually change and why, in your own words, and a proposed composition is generated for them to look at. Use refine_storefront instead when they name ONE specific part to adjust ('the hero feels cramped', 'the buttons are too round'); use this when the question is about the whole store or when they are asking for your judgement rather than a specific edit.",
      input_schema: z.toJSONSchema(EMPTY_INPUT_SCHEMA) as Anthropic.Tool.InputSchema,
    },
    {
      name: "take_me_there",
      description:
        "Call this when the merchant wants to GO somewhere or DO something that lives on a particular screen, and no other tool actually performs the work. A question phrased as 'how do I...' or 'where do I...' about reaching a screen or doing something on one is asking to BE TAKEN THERE, not asking for instructions — answering it with directions when you could simply take them is the failure this tool exists to prevent — 'how do I upload my logo', 'take me to my products', 'where do I change my website', 'I want to see my orders', 'how do I make a hoodie' (when they are asking where to start rather than asking you to make one). Pick destination: studio for creating anything visual, studio.upload when they want to bring their OWN file in, storefront for the website and brand presentation, commerce for products and orders, office for the conversation history and business record, account for settings and billing, connections for the systems the business is connected to — payments, accounting, social, messaging — when they want to MANAGE one rather than hear about it (explaining what is connected is look_up_business_data, not a trip). Put what they actually want into intent, in their words, so the screen arrives ready. DO NOT call this when you can just do the thing — 'make me a logo', 'put it on a hoodie', 'make a collage' all have their own tools and should use them, because taking someone to a screen to do what you could have done yourself is worse than doing it. And DO NOT call this for a question about advice or reasoning: 'what makes a good hoodie design', 'why would I put my logo on a mug', 'what colours work best' all want an answer, not a trip. The line is what the question is ABOUT — a screen or a decision means take them, an opinion or an explanation means answer them.",
      input_schema: z.toJSONSchema(TakeMeThereInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "answer_supplier_economics",
      description:
        "Call this when the merchant is telling you what a supplier charges for a product you have ASKED them about — a minimum order quantity, a price per unit in bulk, that the supplier refused to quote, or that they have not found out yet. Only call it when there is genuinely a supplier question outstanding (you will see it noted in the context below); an unprompted remark about pricing is ordinary conversation. Set outcome to what really happened: 'quoted' if they were given figures, 'supplier_would_not_say' if the supplier refused, 'dont_know_yet' if the merchant has not asked or does not know. GIVE ONLY THE FIGURES THEY ACTUALLY STATED and leave every other field null — half an answer is genuinely useful and will be kept, and a number they did not say is worse than no number, because they will act on it. Prices are in CENTS: 'four pounds ten' or '$4.10' is 410. Set productName to the product in their own words; leave it null only when they did not say and you cannot tell. Never call this to ASK the question — you have already asked it.",
      input_schema: z.toJSONSchema(AnswerSupplierEconomicsToolInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "refine_storefront",
      description:
        "Call this when the merchant asks you to improve how one part of their storefront LOOKS or is STRUCTURED, rather than what it says — e.g. 'make the hero feel more premium', 'the product grid feels cramped', 'this looks too plain', 'give the headings more presence'. You are changing structure and presentation only: hero layout, type scale, section layout, background treatment, image treatment, call to action emphasis, card style, button style, shadow style, and spacing. Pick target as the part of the page they mean, and changes as the one to four adjustments that together achieve that single improvement — four is the implementation detail of ONE idea, never a way to bundle several separate requests or quietly redesign the store. reason must state the real evidence behind it in your own words. summary is one plain sentence the merchant will read above the visual comparison. Do NOT use this for copy or wording (that's edit_store_content), for colours or fonts (that's edit_store_content, which reaches the full theme), or for product photos (that's request_image_change). This only PROPOSES the improvement for the merchant's approval; it never changes the storefront immediately. The merchant sees your proposal immediately, inline in the conversation you are already having, rendered as their real storefront next to how it looks now, with the controls to apply or refine it. Never tell them to go and find it somewhere else. Describe the change plainly and let the picture do the arguing. OPTIONALLY, when a request genuinely has two or three meaningfully different good answers — usually an open-ended one like 'make this feel more alive' rather than a specific one like 'the buttons are too round' — set directions to those alternatives, each with a short label the merchant would recognise ('Warm editorial', 'Bolder and more expressive'), the reason it is worth considering, and its own changes. Only do this when you would genuinely struggle to pick between them yourself; a merchant asked to choose between two options you do not really rate equally is being given work, not help. Most requests should have no directions at all. When you do set directions, changes must repeat the FIRST direction's change set.",
      input_schema: z.toJSONSchema(RefineStorefrontToolInputSchema) as Anthropic.Tool.InputSchema,
    },
  ];
}

// Picks the first tool_use block, matching today's own "exactly one
// classifier ever matches" behavior — if a future model version calls more
// than one tool in a turn, the rest are deliberately ignored for now rather
// than handled, a real open question named in the plan (how a turn with
// multiple tool calls reports back to the owner), not silently guessed at.
/**
 * EVERY tool the model asked for, in the order it asked (2026-08-22).
 *
 * firstToolUse returned the first block and discarded the rest — silently, with
 * no error and no log line. A turn where the merchant asked for two things did
 * one of them and said nothing about the other, which is the same class of
 * failure as reporting a change that did not happen: the owner is left believing
 * something was done.
 */
export function allToolUses(content: Anthropic.Message["content"]): Anthropic.ToolUseBlock[] {
  return content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
}

/**
 * The first tool, kept because most turns have exactly one and every dispatch
 * site is written against a single choice.
 *
 * NOT the whole answer any more — callers take this from the PLANNED list
 * (lib/execution/toolPolicy.ts's planToolRun), so what runs is what policy
 * allows rather than whatever happened to be emitted first.
 */
export function firstToolUse(content: Anthropic.Message["content"]): Anthropic.ToolUseBlock | null {
  return allToolUses(content)[0] ?? null;
}

export function textOf(content: Anthropic.Message["content"]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
