import type { ExecutionStatus, ActorType } from "@/lib/execution/types";

// Shared shapes for the Owner Dashboard's "What happened / What needs
// attention / What should I do next" sections. See ARCHITECTURE.md.

export interface OrderSummary {
  orderCount: number;
  revenueInCents: number | null; // null when the caller lacks REVENUE_VIEW
  allTimeOrderCount: number;
  allTimeRevenueInCents: number | null;
  windowLabel: string; // "Last 30 days"
}

export interface ActivityItem {
  id: string;
  action: string;
  status: ExecutionStatus;
  message: string;
  actorType: ActorType;
  actorName: string | null;
  createdAt: Date;
  metadata: unknown;
  // Phase 6 — set only when this row's executionId matches a Genesis
  // ApprovalRequest, so the feed can distinguish "you approved this" from
  // "Genesis handled this automatically" without touching the underlying
  // (append-only, never rewritten) ExecutionLog.message itself.
  decisionMode?: "human" | "autonomous";
  // Genesis Experience Principles, "Spoken, not logged" — set only for
  // genesis.communicate_finding rows, whose `message` above has already
  // been swapped for the real CognitiveOutput.summary (see
  // getRecentActivity in whatHappened.ts). Lets ActivityFeed render the
  // same kind label Discovery uses, never a raw log wrapper.
  cognitiveOutputKind?: string;
}

export type AttentionKind =
  | "recent-failure"
  | "stale-pending"
  | "integration-issue"
  | "state-issue"
  | "unsellable-store"
  // The machinery failing at somebody (2026-08-31). A dead-lettered job, a
  // stalled one, an external operation with an unknown outcome, or a provider
  // delivery that could not be processed — all of which were computed for the
  // operator and never attributed to the business they happened to.
  | "operational-failure";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  severity: "FAILED" | "WARNING";
  message: string;
  occurredAt: Date | null; // null for ongoing state issues, no single timestamp
  actionHref?: string;
  // Notice dedup (2026-08-09) — "don't repeat the same insight multiple
  // times just because J4 found it in multiple places... group related/
  // duplicate findings into one concise insight with expandable details"
  // (Sean, after seeing the same Growth Points shortfall message 4-5 times
  // on one dashboard). Set only when this item represents 2+ real,
  // separately-logged occurrences sharing identical message text —
  // `occurredAt`/`id` above stay the most recent occurrence's own values,
  // `groupedItems` carries every real occurrence (including this one) for
  // an expand view. A card with no duplicates simply never gets these
  // fields, so every existing single-occurrence rendering is untouched.
  count?: number;
  groupedItems?: { id: string; occurredAt: Date | null }[];
}

export interface RecentOrder {
  id: string;
  productName: string;
  buyerEmail: string;
  amountInCents: number | null; // null when the caller lacks REVENUE_VIEW
  createdAt: Date;
}

export interface CustomerSummary {
  buyerEmail: string;
  orderCount: number;
  totalSpentInCents: number | null; // null when the caller lacks REVENUE_VIEW
  lastOrderAt: Date;
}

export interface InventorySnapshot {
  activeCount: number;
  inactiveCount: number;
  totalCount: number;
}

export interface Recommendation {
  // Stable, e.g. "recommend.publish_store" — enables future dismiss/track/
  // dedupe without a redesign.
  id: string;
  priority: "high" | "medium" | "low";
  message: string;
  actionLabel: string;
  actionHref: string;
  source: string; // producer name, for future attribution/filtering
}
