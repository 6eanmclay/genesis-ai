import { prisma } from "@/lib/prisma";
import { isProposalScope, resolveProposalScope, type ProposalScope } from "./proposalScope";

// A proposal that survives being argued with (2026-08-14).
//
// Sean's requirement, and the whole reason this file exists: "J4 needs to be
// able to have a real back-and-forth with the owner before deciding what to
// build. If the owner disagrees with the first idea, J4 should refine the same
// proposal rather than treating the rebuttal as a new unrelated request."
//
// The loop being served:
//
//   IDEA -> DISCUSSION -> REBUTTAL -> REFINEMENT -> VISUAL PROPOSAL
//        -> APPROVAL -> IMPLEMENTATION -> VERIFICATION
//
// WHAT A PROPOSAL IS. A chain of ApprovalRequest rows sharing a proposalId.
// Every revision is a real, separate, auditable row, so the existing
// Request -> Execute -> Verify -> Record -> Display pipeline is untouched:
// approving revision 3 approves an ordinary ApprovalRequest, executed by the
// ordinary executable, verified the ordinary way. Nothing here is a second
// competing state system, which Sean ruled out explicitly.
//
// WHY NOT MUTATE ONE ROW. Because "here's what I proposed, here's what you
// said, here's what I changed" is the product. Overwriting a row would answer
// the rebuttal and destroy the evidence of it in the same operation, and an
// owner who says "actually, go back to your first idea" would be talking about
// something that no longer exists.

/** The closed set of statuses a proposal row can hold. */
export const PROPOSAL_STATUS = {
  pending: "PENDING_APPROVAL",
  executed: "EXECUTED",
  rejected: "REJECTED",
  // Replaced by a newer revision of the same proposal. Distinct from REJECTED:
  // the owner did not turn this down, J4 improved on it. Conflating the two
  // would poison the record of what the owner actually refused, which the
  // suggestion gate reads (see storefrontSuggestionGate.ts).
  superseded: "SUPERSEDED",
} as const;

export interface ProposalRevision {
  id: string;
  /** Which executable will run on approval. Decides how this can be previewed. */
  actionType: string;
  revision: number;
  summary: string;
  rationale: string | null;
  status: string;
  target: string | null;
  scope: ProposalScope | null;
  input: unknown;
  previousValues: unknown;
  createdAt: Date;
}

export interface Proposal {
  proposalId: string;
  storeId: string;
  /** Oldest first, so the chain reads as the conversation happened. */
  revisions: ProposalRevision[];
  /** The revision the owner is being asked about right now. */
  current: ProposalRevision;
  /** True once any revision has been executed. */
  settled: boolean;
}

function toRevision(row: {
  id: string;
  actionType: string;
  revision: number;
  summary: string;
  rationale: string | null;
  status: string;
  target: string | null;
  scope: string | null;
  input: unknown;
  previousValues: unknown;
  createdAt: Date;
}): ProposalRevision {
  return {
    id: row.id,
    actionType: row.actionType,
    revision: row.revision,
    summary: row.summary,
    rationale: row.rationale,
    status: row.status,
    target: row.target,
    // A stored scope that is not in the registry is treated as absent rather
    // than trusted. Presentation falls back to the derived size, never to a
    // value nothing recognises.
    scope: isProposalScope(row.scope) ? row.scope : null,
    input: row.input,
    previousValues: row.previousValues,
    createdAt: row.createdAt,
  };
}

const REVISION_SELECT = {
  id: true,
  actionType: true,
  revision: true,
  summary: true,
  rationale: true,
  status: true,
  target: true,
  scope: true,
  input: true,
  previousValues: true,
  createdAt: true,
} as const;

/**
 * Loads one proposal and every revision of it.
 *
 * Returns null rather than throwing for an unknown id: a proposal the owner
 * can no longer see is a normal outcome (rejected, cleaned up, another
 * store's), not an error worth breaking a chat turn over.
 */
export async function getProposal(storeId: string, proposalId: string): Promise<Proposal | null> {
  const rows = await prisma.approvalRequest.findMany({
    // storeId is part of the filter, not checked afterwards — tenant isolation
    // belongs in the query, so a caller cannot forget it.
    where: { storeId, proposalId },
    orderBy: { revision: "asc" },
    select: REVISION_SELECT,
  });
  if (rows.length === 0) return null;

  const revisions = rows.map(toRevision);
  return {
    proposalId,
    storeId,
    revisions,
    current: revisions[revisions.length - 1],
    settled: revisions.some((r) => r.status === PROPOSAL_STATUS.executed),
  };
}

/**
 * The proposal J4 and the owner are currently arguing about, if any.
 *
 * "Currently" means its newest revision is still awaiting a decision. Used to
 * answer the question that makes refinement possible at all: when the owner
 * says "I don't like that," is there something on the table to revise, or is
 * this a new request?
 */
export async function getOpenProposal(storeId: string): Promise<Proposal | null> {
  const newest = await prisma.approvalRequest.findFirst({
    where: { storeId, status: PROPOSAL_STATUS.pending, proposalId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { proposalId: true },
  });
  if (!newest?.proposalId) return null;
  return getProposal(storeId, newest.proposalId);
}

/**
 * Every proposal awaiting the owner's decision, newest first.
 *
 * Includes rows written before the revision chain existed (proposalId null),
 * which is every update_hero / update_theme / update_homepage_content /
 * update_section_order proposal. Those used to render at the bottom of the
 * Website page — Sean: "never put an approval somewhere else just because the
 * underlying target belongs to Website, Products, Identity... the conversation
 * about changing it belongs to the active J4 interaction." So they are read
 * here, to be shown where the conversation is.
 *
 * A chainless row is presented as a single-revision proposal whose identity is
 * its own id, so one renderer handles both without asking which kind it has.
 */
export async function getOpenProposals(storeId: string, limit = 5): Promise<Proposal[]> {
  const rows = await prisma.approvalRequest.findMany({
    where: { storeId, status: PROPOSAL_STATUS.pending },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { ...REVISION_SELECT, proposalId: true },
  });

  const chainIds = new Set<string>();
  const proposals: Proposal[] = [];

  for (const row of rows) {
    if (row.proposalId) {
      // One chain contributes one proposal however many revisions are pending.
      if (chainIds.has(row.proposalId)) continue;
      chainIds.add(row.proposalId);
      const full = await getProposal(storeId, row.proposalId);
      if (full) proposals.push(full);
      continue;
    }
    const revision = toRevision(row);
    proposals.push({
      proposalId: row.id,
      storeId,
      revisions: [revision],
      current: revision,
      settled: false,
    });
  }

  return proposals;
}

export interface ProposalDraft {
  actionType: string;
  summary: string;
  /** J4's reasoning. What the owner argues with. */
  rationale: string;
  target: string | null;
  input: Record<string, unknown>;
  previousValues: Record<string, unknown>;
  authorizationTier: string;
  groupId?: string | null;
}

/**
 * Opens a new proposal. The first revision of a new chain.
 *
 * proposalId is set to the row's own id after insert, so a proposal's identity
 * is its first revision — stable, and requiring no second source of ids.
 */
export async function openProposal(storeId: string, draft: ProposalDraft): Promise<Proposal> {
  const scope = resolveProposalScope({
    target: draft.target,
    mutationCount: Object.keys(draft.input).length,
  });

  const created = await prisma.approvalRequest.create({
    data: {
      storeId,
      actionType: draft.actionType,
      summary: draft.summary,
      rationale: draft.rationale,
      target: draft.target,
      scope,
      input: draft.input as never,
      previousValues: draft.previousValues as never,
      authorizationTier: draft.authorizationTier,
      groupId: draft.groupId ?? null,
      revision: 1,
      status: PROPOSAL_STATUS.pending,
    },
    select: { id: true },
  });

  await prisma.approvalRequest.update({
    where: { id: created.id },
    data: { proposalId: created.id },
  });

  const proposal = await getProposal(storeId, created.id);
  if (!proposal) {
    // Only reachable if the row vanished between two statements in the same
    // request, which would mean something is very wrong. Loud, not silent.
    throw new Error(`Proposal ${created.id} could not be read back after creation.`);
  }
  return proposal;
}

/**
 * Answers a rebuttal by revising the proposal already on the table.
 *
 * The previous revision becomes SUPERSEDED, never REJECTED — the owner did not
 * turn it down, J4 improved on it, and the difference matters to every reader
 * of that record.
 *
 * `previousValues` deliberately carries forward from the FIRST revision rather
 * than the one being replaced. "Current" means the storefront as it really is,
 * and no revision has been applied to it yet, so comparing revision 3 against
 * revision 2 would show the owner a diff against something that never existed.
 */
export async function reviseProposal(
  storeId: string,
  proposalId: string,
  revision: { summary: string; rationale: string; target?: string | null; input: Record<string, unknown> }
): Promise<Proposal | null> {
  const existing = await getProposal(storeId, proposalId);
  if (!existing) return null;
  // A proposal that already ran is history. Refining it would silently propose
  // a second change against a storefront that has already moved.
  if (existing.settled) return null;

  const first = existing.revisions[0];
  const previous = existing.current;
  const target = revision.target !== undefined ? revision.target : previous.target;
  const scope = resolveProposalScope({
    target,
    mutationCount: Object.keys(revision.input).length,
  });

  const source = await prisma.approvalRequest.findFirst({
    where: { storeId, id: previous.id },
    select: { actionType: true, authorizationTier: true, groupId: true },
  });
  if (!source) return null;

  await prisma.$transaction([
    prisma.approvalRequest.update({
      where: { id: previous.id },
      data: { status: PROPOSAL_STATUS.superseded },
    }),
    prisma.approvalRequest.create({
      data: {
        storeId,
        proposalId,
        revision: previous.revision + 1,
        supersedesId: previous.id,
        actionType: source.actionType,
        authorizationTier: source.authorizationTier,
        groupId: source.groupId,
        summary: revision.summary,
        rationale: revision.rationale,
        target,
        scope,
        input: revision.input as never,
        previousValues: first.previousValues as never,
        status: PROPOSAL_STATUS.pending,
      },
    }),
  ]);

  return getProposal(storeId, proposalId);
}
