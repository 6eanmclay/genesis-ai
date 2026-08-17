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

/**
 * One visual direction offered by a revision.
 *
 * Sean: "I see two ways to make this feel more alive. [Direction A]
 * [Direction B]". Directions are alternatives at a single moment, which is a
 * different shape from revisions over time — so they live inside a revision
 * rather than forking the chain into rival proposals.
 */
export interface ProposalDirection {
  id: string;
  label: string;
  rationale: string | null;
  /** The change set this direction would apply. Same shape as input.changes. */
  changes: unknown[];
}

/**
 * Reads stored directions back defensively.
 *
 * Anything malformed resolves to no directions rather than a half-rendered
 * chooser: a proposal offering "Direction undefined" is worse than a proposal
 * offering one direction. Fewer than two is not a choice, so it is treated as
 * none.
 */
export function parseDirections(value: unknown): ProposalDirection[] {
  if (!Array.isArray(value)) return [];
  const parsed: ProposalDirection[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return [];
    const d = raw as Record<string, unknown>;
    if (typeof d.id !== "string" || typeof d.label !== "string") return [];
    if (!Array.isArray(d.changes)) return [];
    parsed.push({
      id: d.id,
      label: d.label,
      rationale: typeof d.rationale === "string" ? d.rationale : null,
      changes: d.changes,
    });
  }
  return parsed.length >= 2 ? parsed : [];
}

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
  /** Empty unless this revision is asking the owner to choose. */
  directions: ProposalDirection[];
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
  directions: unknown;
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
    directions: parseDirections(row.directions),
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
  directions: true,
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
  /**
   * Alternatives this revision is asking the owner to choose between. Stored
   * in their own column, never inside `input` — the executable's contract is
   * unchanged, so approving a proposal with directions executes exactly the
   * same shape as one without.
   */
  directions?: ProposalDirection[];
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
      directions: draft.directions && draft.directions.length >= 2 ? (draft.directions as never) : undefined,
    },
    select: { id: true },
  });

  // storeId in the where clause is required by lib/tenantIsolation.ts, which
  // refuses an unscoped update on a tenant-owned table. Scoping an update by
  // tenant is correct regardless, so this is not a workaround.
  await prisma.approvalRequest.update({
    where: { id: created.id, storeId },
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
  revision: {
    summary: string;
    rationale: string;
    target?: string | null;
    input: Record<string, unknown>;
    /** Fresh alternatives, if this revision is again offering a choice. */
    directions?: ProposalDirection[];
  }
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
      // storeId required by lib/tenantIsolation.ts, and correct regardless.
      where: { id: previous.id, storeId },
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
        // Deliberately not carried forward from the superseded revision: a
        // choice already made must not be re-offered as though it were still
        // open.
        directions:
          revision.directions && revision.directions.length >= 2 ? (revision.directions as never) : undefined,
        status: PROPOSAL_STATUS.pending,
      },
    }),
  ]);

  return getProposal(storeId, proposalId);
}

// ---------------------------------------------------------------------------
// Sibling creative branches (2026-08-16)
// ---------------------------------------------------------------------------
//
// Everything above answers "what is my current answer" — one pending row per
// chain, each revision superseding the last. Creative work needs the opposite
// shape, and Sean named it exactly:
//
//   "The original must remain intact when J4 creates alternatives. Each
//    alternative needs its own identity and lineage so J4 can understand that
//    'option 2' came from the original, rather than treating it as an
//    unrelated generation."
//
// So a creative lineage is several CHAINS sharing one groupId. Each candidate
// keeps its own revisions and can be refined independently through
// reviseProposal, unchanged — branching is a layer above chains, not a
// replacement for them.
//
// THREE CHOICES IS NOT THE MODEL. n siblings; three is one presentation.
//
// THE NO-PRESSURE RULE, IN DATA. Creating alternatives supersedes nothing.
// The original stays PENDING and stays the preferred candidate until the owner
// actually chooses something else. That is why branchOfProposalId is its own
// column rather than a reuse of supersedesId — see schema.prisma.

export interface BranchDraft {
  /** What the owner will call it. "Warm editorial", not "Option 2". */
  label: string;
  summary: string;
  rationale: string;
  input: Record<string, unknown>;
  target?: string | null;
}

export interface CreativeLineage {
  groupId: string;
  /** The first candidate. Never superseded by the act of branching. */
  original: Proposal;
  /** Alternatives derived from it, oldest first. */
  branches: { proposal: Proposal; label: string | null; branchOfProposalId: string | null }[];
}

/**
 * Creates alternative candidates from an existing proposal, leaving it intact.
 *
 * Each branch is a NEW chain: its own proposalId, revision 1, PENDING, sharing
 * the original's groupId so the lineage is one thing. previousValues is copied
 * from the original's first revision for the same reason reviseProposal does
 * it — "current" means the storefront as it really is, and no candidate has
 * been applied to it.
 */
export async function branchProposal(
  storeId: string,
  fromProposalId: string,
  branches: BranchDraft[]
): Promise<CreativeLineage | null> {
  const origin = await getProposal(storeId, fromProposalId);
  if (!origin || origin.settled || branches.length === 0) return null;

  const source = await prisma.approvalRequest.findFirst({
    where: { storeId, id: origin.current.id },
    select: { actionType: true, authorizationTier: true, groupId: true, proposalId: true },
  });
  if (!source) return null;

  // Every candidate in one lineage shares a groupId. The original may not have
  // had one, so it adopts its own proposalId — stable, already unique, and it
  // makes the original discoverable from any sibling.
  const groupId = source.groupId ?? origin.proposalId;
  if (!source.groupId) {
    await prisma.approvalRequest.updateMany({
      where: { storeId, proposalId: origin.proposalId },
      data: { groupId },
    });
  }

  const first = origin.revisions[0];

  for (const branch of branches) {
    const target = branch.target !== undefined ? branch.target : origin.current.target;
    const created = await prisma.approvalRequest.create({
      data: {
        storeId,
        actionType: source.actionType,
        authorizationTier: source.authorizationTier,
        groupId,
        summary: branch.summary,
        rationale: branch.rationale,
        target,
        scope: resolveProposalScope({ target, mutationCount: Object.keys(branch.input).length }),
        input: branch.input as never,
        previousValues: first.previousValues as never,
        revision: 1,
        status: PROPOSAL_STATUS.pending,
        branchOfProposalId: origin.proposalId,
        branchLabel: branch.label,
      },
      select: { id: true },
    });
    // Same identity rule as openProposal: a chain is named by its first row.
    // storeId in the where clause is required by lib/tenantIsolation.ts, which
    // refuses an unscoped update on a tenant-owned table.
    await prisma.approvalRequest.update({
      where: { id: created.id, storeId },
      data: { proposalId: created.id },
    });
  }

  return getCreativeLineage(storeId, groupId);
}

/** Every candidate in one creative lineage, original first. */
export async function getCreativeLineage(storeId: string, groupId: string): Promise<CreativeLineage | null> {
  const rows = await prisma.approvalRequest.findMany({
    where: { storeId, groupId, revision: 1 },
    orderBy: { createdAt: "asc" },
    select: { proposalId: true, branchLabel: true, branchOfProposalId: true },
  });
  if (rows.length === 0) return null;

  const originRow = rows.find((r) => !r.branchOfProposalId) ?? rows[0];
  if (!originRow.proposalId) return null;
  const original = await getProposal(storeId, originRow.proposalId);
  if (!original) return null;

  const branches: CreativeLineage["branches"] = [];
  for (const row of rows) {
    if (!row.proposalId || row.proposalId === originRow.proposalId) continue;
    const proposal = await getProposal(storeId, row.proposalId);
    if (proposal) {
      branches.push({ proposal, label: row.branchLabel, branchOfProposalId: row.branchOfProposalId });
    }
  }

  return { groupId, original, branches };
}

/**
 * The owner chose one candidate. Its siblings are set aside.
 *
 * SUPERSEDED, not REJECTED, and the distinction is the one this file already
 * defends: the owner did not turn these down on their merits, they preferred
 * another. Recording them as refused would poison the suggestion gate's record
 * of what the owner actually said no to.
 *
 * Deliberately does NOT approve anything itself. Execution stays with the
 * ordinary approval path, so approving a chosen branch remains an ordinary
 * ApprovalRequest going through the ordinary executable — this only closes the
 * alternatives, and is called alongside that path rather than replacing it.
 */
export async function setAsideSiblings(storeId: string, chosenProposalId: string): Promise<number> {
  const chosen = await prisma.approvalRequest.findFirst({
    where: { storeId, proposalId: chosenProposalId, revision: 1 },
    select: { groupId: true },
  });
  if (!chosen?.groupId) return 0;

  const result = await prisma.approvalRequest.updateMany({
    where: {
      storeId,
      groupId: chosen.groupId,
      status: PROPOSAL_STATUS.pending,
      proposalId: { not: chosenProposalId },
    },
    data: { status: PROPOSAL_STATUS.superseded },
  });
  return result.count;
}
