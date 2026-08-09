import type { AttentionItem } from "./types";
import type { PendingApproval } from "./pendingApprovals";
import type { DiscoveryItem } from "./discovery";
import type { NextBestAction } from "@/lib/intelligence/nextBestAction";
import { ACTION_SECTIONS } from "@/lib/execution/genesisActions";
import { prisma } from "@/lib/prisma";

// J4 Noticed dismiss/exit (2026-08-08) — one real, shared fetch for every
// page rendering AttentionCards (Home + the 5 secondary pages), so each
// doesn't duplicate the same query. A dismissal lasts 7 days — long
// enough that "I don't want to see this right now" genuinely means
// something, short enough that a real, still-true issue ("no payment
// method connected") can't be permanently buried by one tap and silently
// forgotten. Real, finer-grained resurfacing ("when the user asks what
// needs attention, or when it becomes especially relevant" — Sean's own
// words) is a real Reason-engine capability for later, not built here;
// this is the honest, simple mechanism for now.
const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export async function getDismissedCardIds(storeId: string): Promise<Set<string>> {
  const rows = await prisma.dismissedAttentionCard.findMany({
    where: { storeId, dismissedAt: { gte: new Date(Date.now() - DISMISS_DURATION_MS) } },
    select: { cardId: true },
  });
  return new Set(rows.map((r) => r.cardId));
}

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
export type AttentionCardKind = "proposal" | "issue" | "discovery" | "task" | "observation";

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
  // Phase 1 (2026-08-08) — carried through specifically so a caller can
  // conditionally offer the same Regenerate action ApprovalRequestsPanel
  // already offers for update_product_image proposals, preserving that
  // real capability rather than quietly dropping it during consolidation.
  actionType: string;
  input: Record<string, unknown>;
  previousValues: Record<string, unknown>;
  reviewHref: string | null;
  // J4 recommendations -> real approvals (2026-08-09) — "for multiple
  // proposed changes, allow individual approval and, where appropriate,
  // Approve All" (Sean). Several real proposals from the same turn (e.g.
  // request_product_content_change resolving to 3 products) already
  // share one real ApprovalRequest.groupId — this just carries it through
  // to the card so a caller can group and offer Approve All, rather than
  // inventing a second grouping concept.
  groupId: string | null;
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

// Phase 1 (2026-08-08) — Brand/Website/Products/Marketing/Settings each
// independently rendered ObservationsPanel (a real GenesisObservation row
// — "Genesis flagged this as urgent"/"Genesis noticed an opportunity",
// purely informational, no action). Folded into the same card language
// as everything else rather than left as a fifth visual pattern. Purely
// a presentation change — ObservationsPanel had no action button before
// this either, so this card has none now: adding one would be a
// behavioral change, not the consistency pass this is.
export interface ObservationAttentionCard extends AttentionCardCommon {
  kind: "observation";
  dedupeKey: string;
}

export type AttentionCard =
  | ProposalAttentionCard
  | IssueAttentionCard
  | DiscoveryAttentionCard
  | TaskAttentionCard
  | ObservationAttentionCard;

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

// Shared by both buildAttentionCards (Home, capped/multi-source) and
// buildPageAttentionCards (a single secondary page, uncapped) — one real
// approval always becomes one real proposal card, regardless of which
// caller built it.
function buildProposalCard(approval: PendingApproval): ProposalAttentionCard {
  const section = ACTION_SECTIONS[approval.actionType];
  return {
    id: `proposal:${approval.id}`,
    kind: "proposal",
    rank: 1,
    summary: approval.summary,
    detail: null,
    occurredAt: approval.createdAt,
    dotClassName: DOT_DECISION,
    approvalRequestId: approval.id,
    actionType: approval.actionType,
    input: approval.input,
    previousValues: approval.previousValues,
    reviewHref: section?.href ?? null,
    groupId: approval.groupId,
  };
}

function buildObservationCard(obs: { dedupeKey: string; genesisState: string; summary: string }): ObservationAttentionCard {
  const isUrgent = obs.genesisState === "urgent";
  return {
    id: `observation:${obs.dedupeKey}`,
    kind: "observation",
    rank: isUrgent ? 0 : 2,
    summary: obs.summary,
    detail: null,
    occurredAt: null,
    dotClassName: isUrgent ? DOT_URGENT : DOT_OPPORTUNITY,
    dedupeKey: obs.dedupeKey,
  };
}

// Phase 1 (2026-08-08) — the page-scoped counterpart to buildAttentionCards
// below: one secondary page's own pre-filtered approvals/observations
// (Brand's own update_brand_identity/update_store_identity approvals plus
// its own /dashboard/brand-scoped observations, and so on), rendered
// through the exact same AttentionCard component Home uses. Deliberately
// NOT capped (ATTENTION_ZONE_CAP is a Home-specific "at a glance" concern
// — a page the owner navigated to specifically should show everything
// relevant to it) and deliberately doesn't touch issues/discoveryItems/
// tasks/nextRecommendation, which are Home-only concepts with no meaning
// scoped to one section. A highlighted card (the owner arrived via a
// "?focus=" deep link) always sorts first, regardless of rank — the same
// real intent ApprovalRequestsPanel/ObservationsPanel's own highlightId
// already served, just applied before the normal rank/recency sort
// instead of only affecting styling.
export function buildPageAttentionCards(params: {
  approvals: PendingApproval[];
  observations: { dedupeKey: string; genesisState: string; summary: string }[];
  highlightId?: string;
  // J4 Noticed dismiss/exit (2026-08-08) — real dismissed AttentionCard.id
  // strings for this store (DismissedAttentionCard rows, fetched by the
  // page itself). Filtered out here, before sort/cap, so a dismissed card
  // simply never appears — never touches the real underlying record.
  dismissedCardIds?: Set<string>;
}): AttentionCard[] {
  const all: AttentionCard[] = [
    ...params.approvals.map(buildProposalCard),
    ...params.observations.map(buildObservationCard),
  ].filter((card) => !params.dismissedCardIds?.has(card.id));

  all.sort((a, b) => {
    const aHighlighted = isHighlighted(a, params.highlightId);
    const bHighlighted = isHighlighted(b, params.highlightId);
    if (aHighlighted !== bHighlighted) return aHighlighted ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    const aTime = a.occurredAt?.getTime() ?? 0;
    const bTime = b.occurredAt?.getTime() ?? 0;
    return bTime - aTime;
  });

  return all;
}

// A card's own "natural" id (what a real ?focus= deep link actually
// points at) is never the same as its prefixed AttentionCard.id — a
// proposal is focused by approvalRequestId, an observation by dedupeKey,
// matching exactly what ApprovalRequestsPanel/ObservationsPanel already
// compared against before this.
export interface AttentionCardGroup {
  groupId: string | null;
  cards: AttentionCard[];
}

// "For multiple proposed changes, allow individual approval and, where
// appropriate, Approve All" (Sean, 2026-08-09) — groups consecutive-or-not
// proposal cards sharing one real ApprovalRequest.groupId into one
// AttentionCardGroup, preserving each card's own individual position
// otherwise (first occurrence's spot in the already-sorted list). Only
// "proposal" cards can ever have a non-null groupId; every other kind (and
// an ungrouped proposal) is always its own group of exactly one — grouping
// is purely presentational (a shared "Approve All" header), never a
// combined decision: each card underneath keeps its own real Approve/
// Reject regardless of which group it's in.
export function groupAttentionCards(cards: AttentionCard[]): AttentionCardGroup[] {
  const groups: AttentionCardGroup[] = [];
  const groupIndexByGroupId = new Map<string, number>();
  for (const card of cards) {
    const groupId = card.kind === "proposal" ? card.groupId : null;
    const existingIndex = groupId ? groupIndexByGroupId.get(groupId) : undefined;
    if (existingIndex !== undefined) {
      groups[existingIndex].cards.push(card);
    } else {
      if (groupId) groupIndexByGroupId.set(groupId, groups.length);
      groups.push({ groupId, cards: [card] });
    }
  }
  return groups;
}

export function isHighlighted(card: AttentionCard, highlightId: string | undefined): boolean {
  if (!highlightId) return false;
  if (card.kind === "proposal") return card.approvalRequestId === highlightId;
  if (card.kind === "observation") return card.dedupeKey === highlightId;
  return false;
}

export function buildAttentionCards(params: {
  issues: AttentionItem[];
  pendingApprovals: PendingApproval[];
  nextRecommendation: NextBestAction | null;
  discoveryItems: DiscoveryItem[];
  tasks: { id: string; title: string; summary: string }[];
  // J4 Noticed dismiss/exit (2026-08-08) — see buildPageAttentionCards's
  // own identical comment; same real mechanism, same filtering point.
  dismissedCardIds?: Set<string>;
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
      actionType: rec.actionType,
      input: rec.input,
      previousValues: rec.previousValues,
      reviewHref: null,
      // The single lead recommendation is never part of a multi-proposal
      // group by construction — it's deliberately the one standout card.
      groupId: null,
    });
  }

  for (const approval of params.pendingApprovals) {
    // Already carried as the lead recommendation above — never show the
    // same real ApprovalRequest twice.
    if (params.nextRecommendation?.approvalRequestId === approval.id) continue;
    all.push(buildProposalCard(approval));
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

  const visible = all.filter((card) => !params.dismissedCardIds?.has(card.id));

  visible.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const aTime = a.occurredAt?.getTime() ?? 0;
    const bTime = b.occurredAt?.getTime() ?? 0;
    return bTime - aTime;
  });

  return {
    cards: visible.slice(0, ATTENTION_ZONE_CAP),
    overflowCount: Math.max(0, visible.length - ATTENTION_ZONE_CAP),
  };
}
