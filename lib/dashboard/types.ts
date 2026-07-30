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
}

export type AttentionKind =
  | "recent-failure"
  | "stale-pending"
  | "integration-issue"
  | "state-issue"
  | "unsellable-store";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  severity: "FAILED" | "WARNING";
  message: string;
  occurredAt: Date | null; // null for ongoing state issues, no single timestamp
  actionHref?: string;
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
