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
export const DesignSchema = z.object({
  // The approved assets this was composed from, in arrangement order.
  assetIds: z.array(z.string()),
  // A key from lib/design/surfaces.ts — never a free string.
  surface: z.string(),
  // "centered" | "grid" | ... — open vocabulary, same discipline as every
  // other categorical field here.
  arrangement: z.string(),
  arrangementScale: z.number().nullable(),
  // What the composition actually produced. Both real files, both uploaded.
  printFileUrl: z.string().nullable(),
  mockupUrl: z.string().nullable(),
  // Provenance: what it was made from, so a Product can answer "where did
  // this artwork come from" without guessing.
  sourceAssetUrls: z.array(z.string()),
  createdAt: z.string().nullable().default(null),
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
  shipment: { schema: ShipmentSchema, label: "Shipment" },
  commitment: { schema: CommitmentSchema, label: "Commitment" },
  offering: { schema: OfferingSchema, label: "Offering" },
  intent: { schema: IntentSchema, label: "Intent" },
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
