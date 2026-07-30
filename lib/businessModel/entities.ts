import { z } from "zod";

// Phase 3 Milestone 1 (J4 Foundation) — the canonical entity registry.
// Adding a new entity type later (Location, Employee, Project, Subscription,
// Asset, Position — all named in the milestone's own design pass as things
// this must grow into without a redesign) is a new entry here, nothing else:
// no change to BusinessRecord's Prisma model (already generic/JSON), the
// mapping contract, or reasoning.ts's core primitives.
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

export const ENTITY_REGISTRY = {
  contact: { schema: ContactSchema, label: "Contact" },
  transaction: { schema: TransactionSchema, label: "Transaction" },
  item: { schema: ItemSchema, label: "Item" },
  appointment: { schema: AppointmentSchema, label: "Appointment" },
  campaign: { schema: CampaignSchema, label: "Campaign" },
  document: { schema: DocumentSchema, label: "Document" },
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
