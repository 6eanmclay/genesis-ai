import { getBusinessUnderstanding, type BusinessUnderstanding } from "@/lib/businessModel/understanding";
import { businessContextOf } from "@/lib/businessModel/businessContext";
import { digestOf, renderDigest, digestIsSubstantive, type UnderstandingDigest } from "@/lib/businessModel/digest";
import { describeWorkspaceForJ4 } from "@/lib/j4/workspaceContext";
import { getOpenProposal } from "@/lib/storefront/proposals";
import { resolveMostRecentPendingApprovalBatch } from "@/lib/dashboard/pendingApprovals";

// WHAT J4 IS TOLD BEFORE IT DECIDES — ASSEMBLED ONCE (2026-08-22, Unified
// Intelligence UI4).
//
// THE DRIFT THIS ENDS, and it is not hypothetical. The streaming route and the
// Server Action each built this list themselves, line by line, and by the time
// this was written they had already diverged: the route told J4 about a proposal
// currently on the table — the signal that makes "I don't like that, keep it
// handmade" refine an existing idea instead of starting a fresh one — and the
// Server Action did not. So the same push-back produced two different J4s
// depending on which path happened to serve the turn.
//
// J4_FOUNDATION.md's Gap B rule is "both paths draw on identical understanding
// or neither can be trusted". Holding that by hand across two files did not
// work, and the evidence is in this milestone's own history: the provenance work
// had to patch both copies separately, and so did the digest, and each time was
// another chance for exactly this.
//
// A BUILDER, NOT A TURN. This assembles the input and returns it; it does not
// call the model, write a message, or decide anything. The two paths genuinely
// differ in how they respond — one streams, one redirects — and pretending
// otherwise would be a worse abstraction than the duplication it replaced.
// What they must not differ on is what J4 knew.

export interface TurnContextInput {
  storeId: string;
  /**
   * The authenticated viewer, not the store owner.
   *
   * Load-bearing: getBusinessUnderstanding withholds owner-scoped beliefs from
   * anyone who is not the owner, and with the store:manage gate now on
   * individual tools a member without it reaches this code.
   */
  userId: string;
  userMessage: string;
  /** Comma-joined, or "none" — what the caller already has in hand. */
  activeProductNames: string;
  /** Where the owner is while asking. Resolved through a closed registry. */
  workspacePath?: string | null;
  /** The lighter, non-ApprovalRequest confirmation loop edit_store_content uses. */
  pendingSummary?: string | null;
}

export interface TurnContext {
  /** The canonical object, fetched once and handed back so no caller re-reads it. */
  understanding: BusinessUnderstanding;
  digest: UnderstandingDigest;
  business: ReturnType<typeof businessContextOf>;
  /** The lines that become the user turn, in a fixed order. */
  parts: string[];
}

/**
 * Everything J4 is given about this turn, in one place.
 *
 * ORDER IS FIXED rather than incidental: the same business asking the same
 * question twice must produce the same prompt, or the ephemeral cache on the
 * conversation prefix stops hitting and two otherwise-identical turns become
 * impossible to compare.
 */
export async function buildTurnContext(input: TurnContextInput): Promise<TurnContext> {
  const understanding = await getBusinessUnderstanding(input.storeId, { viewerUserId: input.userId });
  const digest = digestOf(understanding);
  // THE THIRD SELECTION (D3). The digest stays what it is — a deliberately tiny
  // routing context against a 2,400-character budget — and is now accompanied by
  // the declared shape it is a selection OF, so a consumer needing more takes
  // more of the same thing rather than assembling its own.
  const business = businessContextOf(understanding, {
    asOf: understanding.asOf,
    throughEventSequence: understanding.throughEventSequence,
  });

  const parts = [input.userMessage, `(Active products: ${input.activeProductNames})`];

  // WHAT J4 KNOWS ABOUT THE BUSINESS. Omitted entirely for a store it knows
  // nothing real about yet — a line of identity on every turn teaches the model
  // nothing and costs context on every message.
  if (digestIsSubstantive(digest)) {
    parts.push(renderDigest(digest));
  }

  // What the owner is looking at while asking. Resolved through a closed
  // registry (lib/j4/workspaceContext.ts): an unrecognised path adds nothing,
  // and the browser's own string never reaches the prompt.
  const workspaceLine = describeWorkspaceForJ4(input.workspacePath ?? undefined);
  if (workspaceLine) parts.push(workspaceLine);

  // THE PROPOSAL CURRENTLY ON THE TABLE — the line the Server Action was
  // missing. Without it, "I don't like that, keep it handmade" reads as a brand
  // new request, with no idea there is a specific proposal being argued with.
  const proposalOnTable = await getOpenProposal(input.storeId);
  if (proposalOnTable && !proposalOnTable.settled) {
    const c = proposalOnTable.current;
    parts.push(
      `(You have a proposal on the table right now, version ${c.revision}, which the merchant can see below this conversation: "${c.summary}"${
        c.rationale ? ` Your reasoning was: "${c.rationale}"` : ""
      } If they are pushing back on it, refine THIS proposal rather than starting a new one: call refine_storefront again for the same target ("${c.target ?? "the storefront"}") with the change they asked for, and speak as someone improving their own idea, not proposing a new one.)`
    );
  }

  if (input.pendingSummary) {
    parts.push(`(You previously proposed this change, awaiting confirmation: "${input.pendingSummary}")`);
  }

  // The model's only way to know there is something real to authorize, distinct
  // from pendingSummary above: that is the lighter confirmation loop
  // edit_store_content uses, this is the structured, groupId-backed proposal
  // system every other tool writes into.
  const pendingApprovalBatch = await resolveMostRecentPendingApprovalBatch(input.storeId);
  if (pendingApprovalBatch) {
    parts.push(
      `(Awaiting your decision — ${pendingApprovalBatch.summaries.length} change${pendingApprovalBatch.summaries.length === 1 ? "" : "s"} you already proposed: ${pendingApprovalBatch.summaries.map((s: string) => `"${s}"`).join(", ")}. If the merchant now clearly authorizes you to proceed with these, call approve_pending_changes.)`
    );
  }

  // The supplier questions J4 itself asked and is still waiting on. Same purpose
  // as the line above: without it, "100 minimum, four ten each" reads as a
  // non-sequitur rather than the reply to a question it asked yesterday.
  const { outstandingEconomicsQuestions, describeOutstandingForJ4 } = await import(
    "@/lib/sourcing/economicsChat"
  );
  const economicsLine = describeOutstandingForJ4(await outstandingEconomicsQuestions(input.storeId));
  if (economicsLine) parts.push(economicsLine);

  return { understanding, digest, business, parts };
}
