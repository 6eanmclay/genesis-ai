import { z } from "zod";

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
// Any field named `xxxId` (single) or `xxxIds` (array) is understood by
// convention to hold another BusinessRecord's id — this is the entire
// relationship mechanism (see reasoning.ts's findRelated), not a separate
// join table.

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
});
export type Asset = z.infer<typeof AssetSchema>;

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
}
