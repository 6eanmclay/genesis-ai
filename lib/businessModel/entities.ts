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

export const CampaignSchema = z.object({
  name: z.string(),
  // "email" | "social" | "ad" | ...
  channel: z.string(),
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
