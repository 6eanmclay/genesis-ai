import { z } from "zod";
import type { RecordProvenance } from "@prisma/client";

// Phase 3 Milestone 1 (J4 Foundation) — the canonical entity registry.
// Adding a new entity type later (Location and Employee, added in Milestone
// 5; Project, Subscription, Asset, Position still future) is a new entry
// here, nothing else: no change to BusinessRecord's Prisma model (already
// generic/JSON), the mapping contract, or reasoning.ts's core primitives.
//
// Categorical/type-like fields (type, status, channel, category, roles) are
// z.string()/z.array(z.string()), never z.enum() — the same "avoid
// enum-migration friction" discipline this codebase already applies to
// ApprovalRequest.status, extended one level down: a closed Zod enum would
// mean every new value (e.g. a future Transaction.type of "transfer") needs
// a code change to the schema itself, defeating the point. Common values are
// documented in each field's comment, not enforced by the type system.
//
// Any field named `xxxId` (single) or `xxxIds` (array) holds another
// BusinessRecord's id by convention. It is no longer the ENTIRE relationship
// mechanism: as of 2026-08-22 these fields are projected into typed, indexed
// RecordRelationship rows (lib/businessModel/relationships.ts), which is what
// lets J4 say WHAT a connection is rather than only that one exists. The fields
// here remain the source of truth; PROJECTIONS in that file lists exactly which
// of them become relationships, and deliberately excludes the several that end
// in `Id` while pointing at something that is not a canonical record at all.

export const ContactSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  // Open vocabulary: "customer" | "vendor" | "employee" | "lead" | ... — a
  // Contact can hold more than one role at once (e.g. a business that's
  // both a customer and a supplier), so this is never a single value.
  roles: z.array(z.string()),
  firstSeenAt: z.string(), // ISO date
  lastSeenAt: z.string(), // ISO date
});
export type Contact = z.infer<typeof ContactSchema>;

export const TransactionSchema = z.object({
  amountInCents: z.number().int(),
  currency: z.string().default("usd"),
  // "sale" | "refund" | "payment" | "expense" | ...
  type: z.string(),
  date: z.string(), // ISO date
  contactId: z.string().nullable(),
  itemIds: z.array(z.string()),
  status: z.string().nullable(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

export const ItemSchema = z.object({
  name: z.string(),
  sku: z.string().nullable(),
  priceInCents: z.number().int().nullable(),
  category: z.string().nullable(),
  active: z.boolean().nullable(),
  // Phase 3 Milestone 3 — added for the "inventory low/depleted" event
  // named explicitly in that milestone's spec. Honest gap, stated plainly:
  // no connector populates this yet (none of the 3 proof integrations
  // track stock), so the change-detection rule reading this field has a
  // real code path but nothing to detect against until one does.
  quantityAvailable: z.number().int().nullable(),
});
export type Item = z.infer<typeof ItemSchema>;

export const AppointmentSchema = z.object({
  title: z.string(),
  startAt: z.string(), // ISO datetime
  endAt: z.string().nullable(),
  contactIds: z.array(z.string()),
  // Forward reference — no Location entity type exists yet. The field name
  // alone is enough for the reference convention to work once one does.
  locationId: z.string().nullable(),
  status: z.string().nullable(),
});
export type Appointment = z.infer<typeof AppointmentSchema>;

// Marketing Engine (Chapter 3) — extended additively so Mailchimp's real
// existing sync path (lib/integrations/mailchimp.ts) needs zero changes:
// every new field is nullable, and a synced-only historical campaign
// simply never populates them. This is what makes a J4-planned campaign
// and a Mailchimp-synced one the same real entity type rather than two
// parallel concepts — planning writes the new fields, sync writes the
// original ones, both are genuinely "a campaign" to J4's own understanding.
export const CampaignSchema = z.object({
  name: z.string(),
  // "email" | "social" | "ad" | ...
  channel: z.string(),
  // Optional + nullable (not just nullable) — so Mailchimp's real existing
  // sync code (lib/integrations/mailchimp.ts) can go on building a
  // Campaign literal that never mentions these fields at all, zero changes
  // required. Null/absent for every pre-existing/synced-only row (a synced
  // campaign has already happened — there's no real "draft" or "scheduled"
  // state to report for it). Set only on records J4/the owner planned.
  status: z.enum(["draft", "scheduled", "published"]).nullable().optional(),
  // The real per-channel copy J4 or the owner authored for this campaign.
  // Null/absent for synced-only rows — Genesis never wrote Mailchimp's own
  // past campaign content, only its performance.
  content: z.string().nullable().optional(),
  scheduledAt: z.string().nullable().optional(), // ISO datetime
  // Shared across every channel-record that's really one campaign idea —
  // mirrors ApprovalRequest.groupId's own proven "one idea, several
  // related rows" pattern, not a new concept. Null/absent for a
  // single-channel campaign or a synced row with no real group.
  groupId: z.string().nullable().optional(),
  sentAt: z.string().nullable(),
  audienceSize: z.number().int().nullable(),
  // Open bag: opens, clicks, conversions, ... — shape varies by channel.
  metrics: z.record(z.string(), z.number()).nullable(),
});
export type Campaign = z.infer<typeof CampaignSchema>;

export const DocumentSchema = z.object({
  // "invoice" | "estimate" | "receipt"
  type: z.string(),
  amountInCents: z.number().int().nullable(),
  // "paid" | "pending" | "overdue"
  status: z.string().nullable(),
  contactId: z.string().nullable(),
  issuedAt: z.string().nullable(),
  dueAt: z.string().nullable(),
});
export type Document = z.infer<typeof DocumentSchema>;

// Phase 3 Milestone 5 (J4 Business Understanding Model) — the first real
// proof that the registry design promised in the comment above actually
// holds: 4 new entity types, zero changes to BusinessRecord's Prisma model,
// the mapping contract, or reasoning.ts's core primitives. Goal/Challenge
// cross-reference each other and Employee references Location, all via the
// same xxxId/xxxIds convention every other entity already uses — findRelated
// needs no changes to traverse them.

export const GoalSchema = z.object({
  description: z.string(),
  // "revenue" | "growth" | "efficiency" | "expansion" | "customer_experience" | "product" | "hiring" | "other"
  category: z.string().nullable(),
  // "active" | "achieved" | "abandoned"
  status: z.string(),
  // "high" | "medium" | "low"
  priority: z.string().nullable(),
  targetDate: z.string().nullable(), // ISO date
  identifiedAt: z.string(), // ISO date — when first captured
  relatedChallengeIds: z.array(z.string()),
  // Phase 3 Milestone 6 (J4 Cognitive Layer) — a real, structured target
  // number, honest-null when the owner never stated one (e.g. "grow the
  // business" has no number; "$10k in monthly revenue" does). Without this,
  // a genuinely computed prediction (reasoning.ts's predictGoalTrajectory)
  // is impossible — description alone is prose, not something to do math
  // against. Only ever meaningful today for category: "revenue" goals.
  targetValueInCents: z.number().int().nullable(),
});
export type Goal = z.infer<typeof GoalSchema>;

export const ChallengeSchema = z.object({
  description: z.string(),
  // "cash_flow" | "staffing" | "competition" | "operations" | "marketing" | "supply_chain" | "other"
  category: z.string().nullable(),
  // "active" | "resolved"
  status: z.string(),
  // "high" | "medium" | "low"
  severity: z.string().nullable(),
  identifiedAt: z.string(), // ISO date
  resolvedAt: z.string().nullable(), // ISO date
  relatedGoalIds: z.array(z.string()),
});
export type Challenge = z.infer<typeof ChallengeSchema>;

export const EmployeeSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  // Open vocabulary: "manager" | "sales" | "support" | "operations" | ...
  roles: z.array(z.string()),
  email: z.string().nullable(),
  startedAt: z.string().nullable(), // ISO date
  // "active" | "former"
  status: z.string().nullable(),
  // Which Location this person works at/from — deliberately not a bridge to
  // StoreMember (the access-control role table): a business can have staff
  // with no dashboard login, and a dashboard user doesn't need a full staff
  // profile just to sign in. Different concerns, kept separate.
  locationId: z.string().nullable(),
});
export type Employee = z.infer<typeof EmployeeSchema>;

export const LocationSchema = z.object({
  name: z.string(),
  // "storefront" | "warehouse" | "office" | "service_area" | ...
  type: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
});
export type Location = z.infer<typeof LocationSchema>;

// Business Assets — the first real proof of the "Asset" entity type this
// file's own top comment named as future since Milestone 1. Deliberately
// not a reuse of DocumentSchema: that schema is narrowly shaped for synced
// financial documents (invoice/estimate/receipt with amount/status) and
// doesn't fit an uploaded product photo, contract, or flyer. `category` is
// a free string (not tied to ENTITY_TYPES) precisely because some real
// uploads — a lease, a marketing flyer — don't map onto any existing
// entity type ("legal"/"marketing" have none); an asset is still useful
// on its own, searchable and summarized, without forcing that mapping.
// `summary`/`extractionConfidence` start null at upload time and are
// filled in by a later classification pass — never guessed here.
export const AssetSchema = z.object({
  fileType: z.enum(["photo", "document", "video"]),
  // Free string, e.g. "product_photo" | "supplier_invoice" |
  // "business_license" | "marketing_flyer" | "unclassified" — see the
  // top-of-file note on why categorical fields here are never z.enum().
  category: z.string(),
  storageUrl: z.string(),
  originalFilename: z.string(),
  summary: z.string().nullable(),
  extractionConfidence: z.number().nullable(),
  // Set only when classification confidently ties this asset to an
  // existing record (e.g. a supplier invoice -> that Contact) — the same
  // xxxId/xxxIds convention every other entity already uses.
  relatedRecordId: z.string().nullable(),
  relatedEntityType: z.string().nullable(),

  // ---- Designation (2026-08-16) ----
  //
  // What this asset is FOR, as opposed to what it IS. `category` already
  // says "this file is a logo"; `role` says "this is the logo the brand
  // currently uses." That distinction is the whole point: without it, an
  // asset is a file in a list and "put THAT logo on a shirt" has nothing to
  // resolve against, because the only real answer lived in Store.logoUrl —
  // a column, not a referenceable object.
  //
  // Open vocabulary, same discipline as every other categorical field here:
  // "brand.logo" | "brand.mark" | "product.artwork" | "product.photo" |
  // "document" | ... Deliberately dotted and general — this is not a logo
  // feature, it is the designation layer every future creative asset uses.
  // Null means "held, but not designated for anything yet", which is the
  // honest state of most uploads until something classifies them.
  role: z.string().nullable().default(null),

  // "uploaded" | "generated" — where the file came from. Kept separate from
  // sourceProvider (which records WHICH system supplied it) because a
  // generated asset needs different handling downstream: it has a prompt, a
  // cost, and no original filename worth showing.
  origin: z.string().nullable().default(null),

  // Supersession. A new brand logo does not delete the old one — it takes
  // over the role, and the previous holder keeps its history and points
  // forward. So "the current logo" is a real query (role held, not
  // superseded) rather than "whatever row happens to be newest", and J4 can
  // still answer "what did the logo look like before?".
  supersedesAssetId: z.string().nullable().default(null),
  supersededByAssetId: z.string().nullable().default(null),

  // Provenance for generated assets — the exact prompt, and the real
  // AiUsageEvent row this generation cost. Same correlation ImageSourceResult
  // already carries; this is where it stops being discarded once the URL is
  // in hand.
  generationPrompt: z.string().nullable().default(null),
  aiUsageEventId: z.string().nullable().default(null),

  // ---- The Creation Station library (2026-08-28) ----
  //
  // ============ REMEMBERING AND OFFERING ARE DIFFERENT ==================
  //
  // Sean: "J4's memory is the business brain. Creation Station is the creative
  // workspace... Deleting an asset from Creation Station should not
  // automatically mean deleting J4's underlying memory."
  //
  // Two facts about one asset, and they were the same fact until now: the
  // Creation Station's picker WAS J4's memory, queried for photos. So an owner
  // tidying their toolbox had no way to do it that did not mean forgetting.
  //
  // WHY THIS IS NOT `role`. Role says what an asset is FOR — "brand.logo",
  // "product.artwork" — and it is a single string. An asset can be the brand
  // logo AND be in the toolbox, so overloading role would force a choice
  // between two unrelated truths.
  //
  // WHY A TIMESTAMP AND NOT A BOOLEAN. Removal is reversible by construction:
  // null is available, a date is "the owner took it out, on this day". Nothing
  // is deleted, J4's record is untouched, and restoring is clearing a field
  // rather than recreating a row. A boolean would have been the same size and
  // told us nothing about when.
  //
  // Null by default, so every existing asset — generated or uploaded, from
  // before this field existed — is in the library without a migration.
  creationLibraryRemovedAt: z.string().nullable().default(null),

  // ---- Does this file actually have transparency? ----
  //
  // Sean: "Do not assume that every PNG has transparency... A PNG can have a
  // completely opaque background."
  //
  // A FACT ABOUT THE FILE, read from its alpha channel at ingest — not from
  // the extension and not from the MIME type, both of which say "png" for a
  // fully opaque image. Determined once, because it cannot change, and stored
  // on the asset rather than per product: the same artwork has to behave the
  // same way on a hoodie, a mug and a tote.
  //
  // Null means "not inspected" — an asset ingested before this existed, or one
  // whose bytes could not be read. Distinct from false, which is a measurement.
  hasTransparency: z.boolean().nullable().default(null),

  createdAt: z.string().nullable().default(null), // ISO date
});
export type Asset = z.infer<typeof AssetSchema>;

// A Design: asset(s) + surface + arrangement, and what that produced
// (2026-08-16). Sits between Asset and Product in the chain recorded in
// WORK_STUDIO.md, and is stored as an ordinary BusinessRecord for the same
// reason assets are — the model is already generic, so this needs no
// migration and inherits the same validated-upsert path.
//
// assetIds is an ARRAY, deliberately, and that is the load-bearing decision:
// print placement is one asset on one surface, a collage is five. A
// single-asset shape would foreclose composition entirely and force it to
// arrive as a second system. Follows the xxxIds convention documented at the
// top of this file, so findRelated already understands it.
// ONE LAYER OF ARTWORK, EXACTLY AS THE EDITOR HOLDS IT (2026-08-28).
//
// Fractions of the print area rather than pixels, because the print area is not
// the same shape on every side — Printful's hoodie prints front at 2100x2100
// and back at 1800x2400, measured on 2026-08-28. A design stored in pixels
// would mean one side or the other.
const DesignLayerSchema = z.object({
  id: z.string(),
  assetUrl: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  flipX: z.boolean().default(false),
  flipY: z.boolean().default(false),
  rotation: z.number().default(0),
});

// WHAT THE OWNER IS ACTUALLY MAKING, WHEN THEY ARE MAKING A PRODUCT.
//
// ============ WHY THIS IS A BLOCK ON Design AND NOT A NEW ENTITY =======
//
// Sean: "Save is a design state. Create is product creation." A saved design
// has to survive the owner leaving, so it needs a record — and the record it
// needs is the one that already exists. `design` is an entity type, createDesign
// writes it, and lib/execution/executables/productFromDesign.ts already turns
// one into a Product. Adding a second design table to hold a second kind of
// design is exactly the "two creation systems" WORK_STUDIO.md exists to forbid.
//
// It is a separate BLOCK rather than new top-level fields because the two
// shapes genuinely differ today. A composed design is artwork flattened onto
// ONE Genesis surface. A product design is layers on SEVERAL supplier
// placements of one catalogue variant. Pretending they are one shape by
// flattening this into `arrangement` would lose the placements, which are the
// whole thing being saved.
//
// The composition fields below therefore gained defaults: a product design has
// no honest answer for `surface` or `arrangement`, and inventing one would put
// a fake key into a closed registry. Exactly one of the two blocks is populated
// on any given record, and scripts/verify-creation-draft.ts asserts it.
export const PlacementDesignSchema = z.object({
  /** Declared by the garment the supplier returned. Never assumed. */
  provider: z.string(),
  externalProductId: z.string(),
  /**
   * THE REFERENCE VARIANT — the exact one the design was laid out against.
   *
   * ============ NOT "THE ONLY SIZE WE SELL" (2026-08-28) ==============
   *
   * Sean: "The size selected during design is a reference/design variant, not
   * the only size we sell... if I'm designing an Ash Bella + Canvas 3719 hoodie
   * and happen to use the 2XL variant to work on the canvas, Create should
   * still produce one hoodie product with all supported sizes."
   *
   * So this stays exact and keeps its old meaning for the canvas: it is the
   * colourway and size whose blank, print areas and photograph the owner
   * actually designed against. What changed is that nothing may read it as the
   * catalogue of what is for sale. That is `sellableVariantIds`.
   */
  externalVariantId: z.string().nullable(),
  /**
   * Every supplier variant this product should be sellable in — the reference
   * variant's colour, in all the sizes the supplier stocks it in.
   *
   * Read off the supplier's own variant list rather than a list of sizes
   * written down here: "Genesis should use the supplier's actual supported
   * variants rather than hardcoding sizes." A blank that comes in four sizes
   * gets four; one that comes in nine gets nine.
   */
  sellableVariantIds: z.array(z.string()).default([]),
  /** Those variants' size names, in the supplier's order, for showing a person. */
  sellableSizes: z.array(z.string()).default([]),
  /** Named, not just referenced, so a saved draft still reads as a thing. */
  productName: z.string().nullable().default(null),
  color: z.string().nullable().default(null),
  /**
   * The supplier's own hex for that colour.
   *
   * Frozen alongside the name because the MOCKUP is composed from it — the
   * blank is a shading layer that gets tinted, so without the hex the product
   * image cannot be rebuilt as the owner saw it.
   */
  colorHex: z.string().nullable().default(null),
  size: z.string().nullable().default(null),
  /**
   * The blank image the owner was actually looking at, per placement.
   *
   * WHAT THEY PREVIEWED, NOT WHAT WE COULD FIND LATER. Sean: "verify that the
   * image attached to the Store Product is the actual composition the user
   * previewed, not a generic supplier image or a newly generated
   * approximation." Re-resolving a blank at creation time could quietly pick a
   * different view or a different colourway; recording it makes the mockup a
   * rebuild of the same picture rather than a fresh interpretation.
   */
  blanks: z.record(z.string(), z.string()).default({}),
  /** Layers per supplier placement — "front", "back", and whatever else. */
  placements: z.record(z.string(), z.array(DesignLayerSchema)).default({}),
  /** The supplier's own areas, frozen, so a reopened draft is not re-derived. */
  printAreas: z
    .array(z.object({ placement: z.string(), width: z.number(), height: z.number(), unit: z.string() }))
    .default([]),
  retailPriceInCents: z.number().int().nullable().default(null),
  /**
   * WHAT BECAME OF IT. Null until the owner presses Create.
   *
   * Kept on the draft rather than inferred from a product pointing back, so
   * "have I already made this?" is one read, and a draft whose product was
   * deleted still says what happened rather than looking unmade.
   */
  productId: z.string().nullable().default(null),
  /** True only when a supplier has actually accepted it. Never optimistic. */
  supplierProductCreated: z.boolean().default(false),
  updatedAt: z.string().nullable().default(null),
});
export type PlacementDesign = z.infer<typeof PlacementDesignSchema>;

export const DesignSchema = z.object({
  // The approved assets this was composed from, in arrangement order.
  assetIds: z.array(z.string()).default([]),
  // A key from lib/design/surfaces.ts — never a free string.
  surface: z.string().default(""),
  // "centered" | "grid" | ... — open vocabulary, same discipline as every
  // other categorical field here.
  arrangement: z.string().default(""),
  arrangementScale: z.number().nullable().default(null),
  // What the composition actually produced. Both real files, both uploaded.
  printFileUrl: z.string().nullable().default(null),
  mockupUrl: z.string().nullable().default(null),
  // Provenance: what it was made from, so a Product can answer "where did
  // this artwork come from" without guessing.
  sourceAssetUrls: z.array(z.string()).default([]),
  createdAt: z.string().nullable().default(null),
  /** The product-design half. Null on a composed design. See above. */
  placement: PlacementDesignSchema.nullable().default(null),
});
export type Design = z.infer<typeof DesignSchema>;

// Social Connections & Business Intelligence (2026-08-09) — "J4 should be
// able to interpret the data rather than simply display it... follower/
// audience size, demographics, geographic distribution, growth, reach/
// views/impressions, engagement, top-performing content" (Sean). One row
// per (store, platform) — externalId is the platform's own account id, so
// a re-sync updates this record in place via BusinessRecord's existing
// @@unique constraint, same as every other entity type. Deliberately NOT
// CampaignSchema: a campaign is one promotional push with a start/end; this
// is an ongoing account's own standing presence — a genuinely different
// shape (Sean's own examples are all cross-platform/audience-level
// comparisons, never about one specific post's send).
//
// "If a platform doesn't expose a particular audience metric... store that
// metric as unavailable rather than fabricating or estimating it" — every
// metric-bearing field here is nullable for exactly that honest reason, and
// unavailableMetrics names which ones a given platform/account genuinely
// doesn't expose (vs. simply not yet synced), so a consumer (J4's own
// reasoning, a future UI) never has to guess why a field is null.
//
// recentDailyMetrics is a real, provider-returned rolling window (e.g.
// Instagram Insights' own day-period series), refreshed whole on every
// sync — not an unbounded history Genesis accumulates indefinitely itself.
// That's an honest, deliberately modest v1 scope for "growth/trends over
// time": what the platform's own API already returns, not a promise of
// unlimited historical analytics this integration doesn't actually have.
export const SocialAccountSchema = z.object({
  // "facebook" | "instagram" | "tiktok" — lowercase, matching this file's
  // own free-string categorical-field convention (never z.enum()).
  platform: z.string(),
  accountName: z.string().nullable(),
  accountUsername: z.string().nullable(),
  profileUrl: z.string().nullable(),
  followerCount: z.number().int().nullable(),
  followingCount: z.number().int().nullable(),
  mediaCount: z.number().int().nullable(),
  engagementRate: z.number().nullable(), // 0-1, null when not computable from what the platform returns
  audienceDemographics: z
    .object({
      // e.g. {"18-24": 0.31, "25-34": 0.42, ...} — shares of the audience, not raw counts.
      ageRanges: z.record(z.string(), z.number()).nullable(),
      genderSplit: z.record(z.string(), z.number()).nullable(),
      topCountries: z.record(z.string(), z.number()).nullable(),
      topCities: z.record(z.string(), z.number()).nullable(),
    })
    .nullable(),
  recentDailyMetrics: z
    .array(
      z.object({
        date: z.string(), // ISO date
        followerCount: z.number().int().nullable(),
        reach: z.number().int().nullable(),
        impressions: z.number().int().nullable(),
        profileViews: z.number().int().nullable(),
      })
    )
    .nullable(),
  topContent: z
    .array(
      z.object({
        externalId: z.string(),
        caption: z.string().nullable(),
        postedAt: z.string().nullable(), // ISO datetime
        permalink: z.string().nullable(),
        // Open bag — reach/impressions/likes/comments/shares/views, whatever
        // the platform actually returned for this piece of content.
        metrics: z.record(z.string(), z.number()),
      })
    )
    .nullable(),
  // Real field names this platform/account genuinely doesn't expose right
  // now (e.g. "audienceDemographics" for a TikTok Display API-only
  // connection, or any demographic field for an account under a platform's
  // own minimum-follower threshold) — never inferred from a field simply
  // being null, always explicitly set by the connector that knows why.
  unavailableMetrics: z.array(z.string()),
  syncedFromApiAt: z.string(), // ISO datetime — when this snapshot was actually pulled from the platform
});
export type SocialAccount = z.infer<typeof SocialAccountSchema>;


// Phase 2 (EasyPost) — a parcel on its way to a customer.
//
// DELIBERATELY PROVIDER-INDEPENDENT, like every other entity here. The status
// vocabulary is EasyPost's, but EasyPost's is the industry's — a future Shippo
// or UPS connector maps onto these same words without translation, which is the
// whole reason the canonical layer exists.
//
// WHY THIS IS NOT A FIELD ON Order. Genesis already stores a tracking NUMBER on
// the order, which is the promise that something shipped. What it never had is
// what happened next: in transit, delivered, or stuck. That is a stream of
// events about a parcel, not a property of the sale, and it comes from a
// provider that may not be connected at all. Keeping it as its own record means
// an order with no shipment is simply an order with no shipment, and no
// migration was needed to say so.
export const ShipmentSchema = z.object({
  trackingCode: z.string(),
  carrier: z.string().nullable(),
  // pre_transit | in_transit | out_for_delivery | delivered |
  // available_for_pickup | return_to_sender | failure | cancelled | error |
  // unknown. A free string rather than an enum, matching every other
  // categorical field in this file: a carrier inventing a new state must not
  // break the sync.
  status: z.string(),
  statusDetail: z.string().nullable(),
  estimatedDeliveryAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  lastScanAt: z.string().nullable(),
  lastScanDescription: z.string().nullable(),
  lastScanLocation: z.string().nullable(),
  // The Genesis Order this parcel belongs to, using the same xxxId convention
  // findRelated already walks.
  orderId: z.string().nullable(),
  // Derived from status, stored so a reader never has to know the vocabulary.
  // Honest booleans: "not delivered" is not the same as "went wrong".
  isDelivered: z.boolean(),
  isException: z.boolean(),
});
export type Shipment = z.infer<typeof ShipmentSchema>;

// A DATED COMMITMENT THE BUSINESS MADE, found inside a document (2026-08-21).
//
// The last non-blocked gap in J4_FOUNDATION.md's own coverage list: "if an
// uploaded lease says it expires in December, that's understood as a sentence in
// Asset.summary — not a date J4 holds anywhere it could act on weeks later. J4
// can tell you what a document says right now; it can't yet proactively resurface
// an obligation buried inside one."
//
// NOT AN APPOINTMENT. An appointment is a calendar event, synced from a calendar
// the owner keeps. This is a deadline the business is bound by whether or not
// anyone put it in a calendar — a lease expiry, an insurance renewal, a licence,
// a contract term. Nothing syncs these, which is exactly why they get forgotten.
//
// NOT "obligations". lib/businessModel/obligations.ts already owns that word for
// orders a customer is waiting on. Two unrelated things called obligations would
// be a trap for whoever read one and reasoned about the other.
//
// dueDate IS REQUIRED, and it is the whole point. A commitment with no date is a
// sentence, and a sentence is what the summary already held. Nothing here may
// infer, round or guess a date — see the extractor: a document that states a term
// without a date produces no commitment at all, which is the honest outcome.
export const CommitmentSchema = z.object({
  title: z.string(),
  // lease | insurance | licence | contract | tax | warranty | subscription |
  // other. A free string like every other categorical field here, so a real
  // document naming something nobody anticipated does not break the write.
  kind: z.string(),
  /** ISO date. The reason this record exists. */
  dueDate: z.string(),
  /** Who it is with, when the document says. Never inferred from a filename. */
  counterparty: z.string().nullable(),
  amountInCents: z.number().int().nullable(),
  /**
   * THE SENTENCE IT CAME FROM, quoted from the document itself.
   *
   * Provenance the owner can check without reopening the file. A date extracted
   * by a model and shown as fact, with no way to see what it was read from, is
   * exactly the kind of confident claim this codebase refuses to make elsewhere.
   */
  sourceQuote: z.string(),
  /** The asset record this was read out of, so the document is one hop away. */
  sourceAssetRecordId: z.string().nullable(),
  /** The extractor's own confidence, carried rather than hidden. */
  confidence: z.number().nullable(),
});
export type Commitment = z.infer<typeof CommitmentSchema>;

// WHAT THE OWNER TOLD US, kept structurally apart from what Genesis wrote
// about it.
//
// The business already had somewhere to put its DERIVED self-description:
// Store.description, and blueprint.brandIdentity's brandStory, missionStatement
// and visionStatement. All of it model-written, all of it for the storefront to
// say. What it had nowhere to put was the owner's own answer to the two
// questions onboarding actually asks them — what do you sell, and what do you
// want this to be. Those answers were used for one generation prompt and one
// hero image and then dropped on the floor at confirmation.
//
// SOURCE INFORMATION, NOT COPY. Neither of these is ever rendered to a
// customer, ever generated, and ever substituted for the other. A record here
// exists only because a person asserted the thing; see lib/businessModel/
// ownerFacts.ts, which is the only writer, and DRAFT_FIELD_SPLIT_CONTRACT.md
// section 4c for the rule both onboarding paths obey.
//
// ONE SENTENCE EACH, deliberately. The fact IS the statement. Everything else
// worth knowing about it — who said it, when, and whether a model stood between
// them and these words — is already carried by BusinessRecord's provenance
// columns rather than duplicated into the payload.

export const OfferingSchema = z.object({
  /** The owner's own words for what this business sells or provides. */
  statement: z.string(),
});
export type Offering = z.infer<typeof OfferingSchema>;

export const IntentSchema = z.object({
  /** The owner's own words for what they want the business or brand to be. */
  statement: z.string(),
});
export type Intent = z.infer<typeof IntentSchema>;

// THE FOUR CLAIMS J4 REASONS FROM (2026-08-24, D1-A).
//
// These lived in Store.blueprint.brandIdentity, a JSON blob holding two
// different kinds of thing at once. Who read them showed the split: brandStory
// is rendered on the storefront as "Our Story" — it is copy. These four were
// read by cognitiveLayer and marketing/assets to REASON and GENERATE, and were
// never rendered anywhere: zero references under app/store.
//
// A claim about the business belongs where claims live. In the blob they had no
// author, no date, no correction path, and — worst — nothing could tell a
// targetAudience the owner stated from one a model invented during onboarding.
// The proactive layer read it either way.
//
// THE COPY FIELDS DID NOT MOVE. brandStory, missionStatement, visionStatement,
// brandPromise and coreValues stay in the blueprint and stay generated by the
// content pipeline. The test is the one insights.ts was resolved by: is the
// owner the authoritative source, and does J4 reason from it? These four pass
// both. A brand story passes neither — J4 does not reason from the story, it
// renders it.

/** Who this business is for, as a claim someone made. */
export const TargetAudienceSchema = z.object({ statement: z.string() });
export type TargetAudience = z.infer<typeof TargetAudienceSchema>;

/** How the brand behaves. */
export const BrandPersonalitySchema = z.object({ statement: z.string() });
export type BrandPersonality = z.infer<typeof BrandPersonalitySchema>;

/** How the brand speaks. */
export const BrandVoiceSchema = z.object({ statement: z.string() });
export type BrandVoice = z.infer<typeof BrandVoiceSchema>;

/** Why a customer chooses this business over another. */
export const SellingPropositionSchema = z.object({ statement: z.string() });
export type SellingProposition = z.infer<typeof SellingPropositionSchema>;

// ============ A POST IS SHAPED BY THE PLATFORM IT IS FOR ================
//
// Sean, 2026-08-28: "Keep platform-specific content generation separate — never
// assume one caption can simply be copied across platforms."
//
// A single `caption: string` would have made that a convention, and a
// convention is a thing that holds until somebody is in a hurry. So the content
// is a DISCRIMINATED UNION and the four shapes genuinely differ: an Instagram
// post without a picture is not a post, an X post is one field with a hard
// limit, and a TikTok is a hook and an ordered list of shots.
//
// The consequence is the point. There is no assignment that moves an X post's
// text into an Instagram post, because the compiler asks what the picture is.
// Copying across platforms is not forbidden by a rule somebody has to remember;
// it is not expressible.
//
// PLATFORM IDS LIVE IN lib/social/platforms.ts and are checked against this
// union by scripts/verify-social-creation.ts — see the mirrored-registry
// invariant in ARCHITECTURE.md.

/** Instagram is visual-first: the picture is the post, the caption serves it. */
export const InstagramContentSchema = z.object({
  kind: z.literal("instagram"),
  /**
   * WHAT THE PICTURE SHOWS, in the owner's words.
   *
   * Separate from `imageUrl` on purpose: the brief exists before any image
   * does, it is what J4 is asked to make one from, and it survives replacing
   * the image. A draft with a brief and no picture is a real, useful draft.
   */
  imageBrief: z.string().default(""),
  /** The picture itself, once there is one. */
  imageUrl: z.string().nullable().default(null),
  caption: z.string().default(""),
  /** Without the leading #, so the tag is the data and the # is presentation. */
  hashtags: z.array(z.string()).default([]),
});

/** Facebook earns its place by starting conversations, not by being seen. */
export const FacebookContentSchema = z.object({
  kind: z.literal("facebook"),
  body: z.string().default(""),
  /**
   * The line that invites a reply, kept as its own field rather than trusted to
   * be the last sentence of the body. A post that ends in a question by
   * accident is not the same as one written to be answered.
   */
  question: z.string().default(""),
});

/** X is one field with a hard limit, and the limit is the format. */
export const XContentSchema = z.object({
  kind: z.literal("x"),
  text: z.string().default(""),
});

/** One beat of a TikTok, in order. */
export const TikTokShotSchema = z.object({
  id: z.string(),
  description: z.string().default(""),
  /** Roughly how long this beat runs. Null while nobody has decided. */
  seconds: z.number().nullable().default(null),
});

/** TikTok is a plan before it is a caption: a hook, then what happens. */
export const TikTokContentSchema = z.object({
  kind: z.literal("tiktok"),
  /** The first two seconds. Its own field because it is the whole job. */
  hook: z.string().default(""),
  shots: z.array(TikTokShotSchema).default([]),
  caption: z.string().default(""),
});

export const SocialContentSchema = z.discriminatedUnion("kind", [
  InstagramContentSchema,
  FacebookContentSchema,
  XContentSchema,
  TikTokContentSchema,
]);
export type SocialContent = z.infer<typeof SocialContentSchema>;

/**
 * A post being written, for one platform.
 *
 * ============ PUBLISHING IS A FIELD THAT IS ALWAYS NULL TODAY ==========
 *
 * No platform is connected, so nothing has ever been published and both fields
 * below are null on every row. They exist now because the alternative is adding
 * them later to a table that already holds drafts, and because `publishedAt`
 * being null is what "in progress" MEANS — the grouping in the Continue panel
 * reads this, exactly as the product side reads `productId`.
 */
export const SocialPostSchema = z.object({
  /** A platform id from lib/social/platforms.ts. */
  platform: z.string(),
  /** What the owner calls this post. Null until they name it. */
  name: z.string().nullable().default(null),
  content: SocialContentSchema,
  updatedAt: z.string().nullable().default(null),
  /** Set the first time this actually reaches the platform. Never today. */
  publishedAt: z.string().nullable().default(null),
  /** Where it landed, once it has landed. */
  publishedUrl: z.string().nullable().default(null),
});
export type SocialPost = z.infer<typeof SocialPostSchema>;

export const ENTITY_REGISTRY = {
  contact: { schema: ContactSchema, label: "Contact" },
  transaction: { schema: TransactionSchema, label: "Transaction" },
  item: { schema: ItemSchema, label: "Item" },
  appointment: { schema: AppointmentSchema, label: "Appointment" },
  campaign: { schema: CampaignSchema, label: "Campaign" },
  document: { schema: DocumentSchema, label: "Document" },
  goal: { schema: GoalSchema, label: "Goal" },
  challenge: { schema: ChallengeSchema, label: "Challenge" },
  employee: { schema: EmployeeSchema, label: "Employee" },
  location: { schema: LocationSchema, label: "Location" },
  asset: { schema: AssetSchema, label: "Asset" },
  design: { schema: DesignSchema, label: "Design" },
  socialAccount: { schema: SocialAccountSchema, label: "Social Account" },
  socialPost: { schema: SocialPostSchema, label: "Social post" },
  shipment: { schema: ShipmentSchema, label: "Shipment" },
  commitment: { schema: CommitmentSchema, label: "Commitment" },
  offering: { schema: OfferingSchema, label: "Offering" },
  intent: { schema: IntentSchema, label: "Intent" },
  targetAudience: { schema: TargetAudienceSchema, label: "Target audience" },
  brandPersonality: { schema: BrandPersonalitySchema, label: "Brand personality" },
  brandVoice: { schema: BrandVoiceSchema, label: "Brand voice" },
  sellingProposition: { schema: SellingPropositionSchema, label: "Selling proposition" },
} as const;

export type EntityType = keyof typeof ENTITY_REGISTRY;

export const ENTITY_TYPES = Object.keys(ENTITY_REGISTRY) as EntityType[];

export type EntityDataFor<T extends EntityType> = z.infer<
  (typeof ENTITY_REGISTRY)[T]["schema"]
>;

// A single canonical record, regardless of whether it's persisted
// (BusinessRecord row, from a real connector) or computed live (internal
// mapper output) — both shapes must match exactly so the reasoning layer
// never needs to special-case one over the other.
export interface CanonicalRecord<T extends EntityType = EntityType> {
  id: string;
  entityType: T;
  sourceProvider: string;
  data: EntityDataFor<T>;
  syncedAt: Date;
  /**
   * WHERE THIS RECORD'S FACTS CAME FROM (2026-08-22).
   *
   * On the canonical shape rather than only on the Prisma row, because the two
   * kinds of record this interface unifies have genuinely different answers and
   * a reader must not have to know which it is holding: a persisted row carries
   * whatever its writer declared, while a live-computed one is DERIVED by
   * definition, being arithmetic over the store's own orders.
   *
   * Nullable in every field, together, for rows written before the column
   * existed. Null provenance means nobody recorded it — an honest unknown, not
   * a claim that it came from nowhere.
   */
  provenance: RecordProvenance | null;
  provenanceDetail: string | null;
  statedAt: Date | null;
  statedById: string | null;
  modelExtracted: boolean | null;
}
