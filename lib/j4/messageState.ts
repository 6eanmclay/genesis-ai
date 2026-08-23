/**
 * What a message in the conversation actually turned out to be.
 *
 * UI6, 2026-08-23. The conversation used to render prose and nothing else, so
 * every assistant message looked alike: a question answered, a change waiting
 * for a decision, and a change that failed and can be retried were the same
 * grey paragraph. The owner had to read J4's sentence and believe it.
 *
 * THE PROSE IS NOT THE EVIDENCE. It is written at the moment J4 speaks and is
 * never revised; the execution row written in the same breath is what actually
 * happened, and it is the only thing this reads. That is the rule the whole
 * milestone before this one was spent on — a reply that says "done" and an
 * execution row that says WARNING cannot both be shown as a success, and when
 * they disagree the row wins.
 *
 * Deliberately a pure function of the row. No prose is parsed, no wording is
 * matched: a label derived from what J4 said would restate the claim rather
 * than check it.
 */

/** The execution row as this needs it — the honest half of a message. */
export interface MessageExecution {
  /** SUCCESS | PENDING | WARNING | FAILED, as ExecutionLog stores it. */
  status: string;
  /** Whether trying again is a real option, not a suggestion to repeat work. */
  retryable: boolean;
  /** What the turn was: "data_question", "product_removal_request", … */
  kind: string | null;
}

export type MessageState =
  /** No execution to speak of: an ordinary reply, or a message older than this. */
  | "spoken"
  /** A question answered from the business's own data. */
  | "answered"
  /** Real work happened and nothing has changed yet — it is waiting on a decision. */
  | "proposed"
  /** A change was made and recorded. */
  | "done"
  /** It did not happen, and trying again is a real option. */
  | "failed_retryable"
  /** It did not happen, and repeating it would hit the same wall. */
  | "failed";

/**
 * The kinds that only ever propose. Named rather than inferred from the status
 * alone, because PENDING is also what an in-flight execution would look like if
 * one were ever written — and telling an owner a change is "waiting for you"
 * when it is actually mid-flight would be a different lie.
 */
const PROPOSING_KINDS = new Set([
  "product_removal_request",
  "image_request",
  "product_content_change_request",
  "campaign_request",
  "create_composition",
  "refine_storefront",
  "improve_storefront",
]);

export function messageStateOf(execution: MessageExecution | null): MessageState {
  // A MISSING ROW IS NOT A SUCCESS. Most messages have none — every ordinary
  // reply, the merchant's own words, and everything written before the join
  // existed. Defaulting these to "done" would decorate the entire history with
  // a claim nothing supports.
  if (!execution) return "spoken";

  if (execution.status === "PENDING") return "proposed";

  if (execution.status === "WARNING" || execution.status === "FAILED") {
    return execution.retryable ? "failed_retryable" : "failed";
  }

  if (execution.status === "SUCCESS") {
    if (execution.kind === "data_question") return "answered";
    // A tool that proposes and reports SUCCESS did the proposing successfully.
    // The change itself is still waiting, and saying "done" here is precisely
    // the claim that must never be made.
    if (execution.kind && PROPOSING_KINDS.has(execution.kind)) return "proposed";
    return "done";
  }

  // An unrecognised status is not a success either. Falling through to "done"
  // would mean any future ExecutionStatus silently reads as a completed change.
  return "spoken";
}

/**
 * What the owner is told the state is.
 *
 * Short, and about the work rather than the system: "Waiting for you", not
 * "PENDING". Nothing here names a tool, a status enum, or a code path.
 */
export const MESSAGE_STATE_LABEL: Record<MessageState, string | null> = {
  // An ordinary reply gets no badge at all — labelling every sentence J4 says
  // would make the ones that matter invisible.
  spoken: null,
  answered: "Answered from your data",
  proposed: "Waiting for you",
  done: "Done",
  failed_retryable: "Didn't go through",
  failed: "Couldn't do that",
};

/**
 * Whether this state is something the owner still has to act on.
 *
 * Used to decide emphasis, not wording. Both a proposal and a retryable failure
 * leave something outstanding; a completed change and an answered question do
 * not.
 */
export function needsOwner(state: MessageState): boolean {
  return state === "proposed" || state === "failed_retryable";
}
