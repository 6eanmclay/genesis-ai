import type { AttentionItem } from "./types";
import type { PendingApproval } from "./pendingApprovals";
import type { DiscoveryItem } from "./discovery";
import type { NextBestAction } from "@/lib/intelligence/nextBestAction";
import { ACTION_SECTIONS } from "@/lib/execution/genesisActions";

// Home Redesign (2026-08-08) — "the dashboard shows the business, J4
// handles the work" (Sean). Previously Home stacked four independently-
// designed sections for anything needing the owner's eyes or a decision —
// AttentionPanel (issues), ApprovalsSummary (pending approvals),
// DiscoveryFeed (J4's findings), TaskCards (open tasks) — four different
// visual languages for what's really one question: "does this business
// need me right now?" This file normalizes all four real sources into one
// shared card shape so the page can render one consistent, compact
// language instead of four.
//
// Two variants only, matching Sean's own explicit distinction:
// - "proposal": J4 already did the work and has a fully-specified change
//   ready — the owner's real choice is yes/no, so it stays directly
//   approvable right on the card (unchanged mechanism: approveGenesisAction/
//   rejectGenesisAction), never forced into a conversation just to say yes.
// - everything else ("issue"/"discovery"/"task"): J4 hasn't yet turned
//   this into a concrete action, or it's the owner's own open work — the
//   real next step is judgment/execution, so the card hands off to a real
//   J4 conversation with the exact originating context already seeded in,
//   never a second surface asking the owner to re-explain what they're
//   acting on.
export type AttentionCardKind = "proposal" | "issue" | "discovery" | "task";

interface AttentionCardCommon {
  id: string;
  kind: AttentionCardKind;
  // Lower sorts first. Not shown to the owner — purely an internal
  // "what matters most right now" ordering, per kind and per source
  // severity/priority, so the capped zone below surfaces the right things
  // without the page needing its own bespoke sort per source.
  rank: number;
  summary: string;
  detail: string | null;
  occurredAt: Date | null;
  dotClassName: string;
}

export interface ProposalAttentionCard extends AttentionCardCommon {
  kind: "proposal";
  approvalRequestId: string;
  input: Record<string, unknown>;
  previousValues: Record<string, unknown>;
  reviewHref: string | null;
}

export interface IssueAttentionCard extends AttentionCardCommon {
  kind: "issue";
  message: string;
}

export interface DiscoveryAttentionCard extends AttentionCardCommon {
  kind: "discovery";
  discoveryId: string;
  discoverySummary: string;
}

export interface TaskAttentionCard extends AttentionCardCommon {
  kind: "task";
  taskId: string;
}

export type AttentionCard = ProposalAttentionCard | IssueAttentionCard | DiscoveryAttentionCard | TaskAttentionCard;

// A calm, fixed J4 identity color for this zone — deliberately NOT the
// merchant's own --brand-accent (an arbitrary per-store color that could
// clash with or be mistaken for the store's own content) and deliberately
// blue, not the red/orange the live avatar currently uses (Sean, 2026-08-08:
// "the original blue feels calmer, cleaner, and more consistent with what
// Genesis should feel like" — the avatar's own color is a separate,
// deferred visual-polish item, but nothing new built here should extend
// the red/orange treatment).
export const J4_ATTENTION_ACCENT = "#2563eb";

const DOT_URGENT = "bg-red-500";
// Written as a literal class string, not interpolated from
// J4_ATTENTION_ACCENT — Tailwind's build-time scanner only ever detects
// classes it can find as literal text in source, never a runtime-computed
// string.
const DOT_DECISION = "bg-[#2563eb]";
const DOT_OPPORTUNITY = "bg-amber-500/70";
const DOT_NEUTRAL = "bg-zinc-400 dark:bg-zinc-600";

// Only the cap that matters for "at a glance" — real content stays
// available (see overflowCount below), nothing is discarded.
export const ATTENTION_ZONE_CAP = 5;

export function buildAttentionCards(params: {
  issues: AttentionItem[];
  pendingApprovals: PendingApproval[];
  nextRecommendation: NextBestAction | null;
  discoveryItems: DiscoveryItem[];
  tasks: { id: string; title: string; summary: string }[];
}): { cards: AttentionCard[]; overflowCount: number } {
  const all: AttentionCard[] = [];

  for (const item of params.issues) {
    all.push({
      id: `issue:${item.id}`,
      kind: "issue",
      rank: item.severity === "FAILED" ? 0 : 2,
      summary: item.message,
      detail: null,
      occurredAt: item.occurredAt,
      dotClassName: item.severity === "FAILED" ? DOT_URGENT : DOT_OPPORTUNITY,
      message: item.message,
    });
  }

  // The Growth Engine's own single highest-confidence "next best action" is
  // a real, already-fully-specified proposal (same ApprovalRequest shape
  // every other proposal here is) — folded into the same list rather than
  // kept as its own separate lead card, so the owner learns one card
  // language for every proposal, not "the big one up top" plus "the small
  // ones below."
  if (params.nextRecommendation) {
    const rec = params.nextRecommendation;
    all.push({
      id: `proposal:${rec.approvalRequestId}`,
      kind: "proposal",
      rank: 1,
      summary: rec.summary,
      detail: null,
      occurredAt: null,
      dotClassName: DOT_DECISION,
      approvalRequestId: rec.approvalRequestId,
      input: rec.input,
      previousValues: rec.previousValues,
      reviewHref: null,
    });
  }

  for (const approval of params.pendingApprovals) {
    // Already carried as the lead recommendation above — never show the
    // same real ApprovalRequest twice.
    if (params.nextRecommendation?.approvalRequestId === approval.id) continue;
    const section = ACTION_SECTIONS[approval.actionType];
    all.push({
      id: `proposal:${approval.id}`,
      kind: "proposal",
      rank: 1,
      summary: approval.summary,
      detail: null,
      occurredAt: approval.createdAt,
      dotClassName: DOT_DECISION,
      approvalRequestId: approval.id,
      input: approval.input,
      previousValues: approval.previousValues,
      reviewHref: section?.href ?? null,
    });
  }

  for (const item of params.discoveryItems) {
    all.push({
      id: `discovery:${item.id}`,
      kind: "discovery",
      rank: item.priority === "high" ? 3 : 4,
      summary: item.summary,
      detail: null,
      occurredAt: item.generatedAt,
      dotClassName: item.priority === "high" ? DOT_OPPORTUNITY : DOT_NEUTRAL,
      discoveryId: item.id,
      discoverySummary: item.summary,
    });
  }

  for (const task of params.tasks) {
    all.push({
      id: `task:${task.id}`,
      kind: "task",
      rank: 5,
      summary: task.title,
      detail: task.summary && task.summary !== task.title ? task.summary : null,
      occurredAt: null,
      dotClassName: DOT_NEUTRAL,
      taskId: task.id,
    });
  }

  all.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const aTime = a.occurredAt?.getTime() ?? 0;
    const bTime = b.occurredAt?.getTime() ?? 0;
    return bTime - aTime;
  });

  return {
    cards: all.slice(0, ATTENTION_ZONE_CAP),
    overflowCount: Math.max(0, all.length - ATTENTION_ZONE_CAP),
  };
}
