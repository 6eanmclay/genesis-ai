import { FIELD_LABELS, formatDiffValue, HIDDEN_DIFF_KEYS } from "@/lib/execution/fieldLabels";
import { GENESIS_ACTIONS } from "@/lib/execution/genesisActions";
import { buildActionContext } from "@/lib/execution/genesisAutonomy";


// A PROPOSAL LEFT SITTING MUST NOT OVERWRITE THE WORK DONE SINCE.
//
// ============ WHAT THIS PREVENTS ====================================
//
// An ApprovalRequest freezes two things: `input`, the change being offered,
// and `previousValues`, what the action's own getCurrentValues returned at the
// moment it was offered. Approving one handed `input` straight to execute()
// and never looked at the store again — so a proposal the owner left sitting
// applied a plan written against a business that may have moved on.
//
// Measured in production 2026-09-02: 48 proposals pending across 13
// businesses, four of them more than thirty days old and the oldest
// thirty-six. Nothing expired them and nothing compared them against anything.
//
// ============ AGE IS A PROXY; DRIFT IS THE CONDITION =================
//
// Sean approved the rule as: a pending proposal must not apply a frozen
// payload if its underlying current values have changed — refuse, and explain
// what changed. Deliberately NOT a timer. A six-day-old proposal overwrites
// yesterday's edit exactly as thoroughly as a thirty-six-day-old one, so an
// expiry would look like a fix while leaving the case that matters, and would
// throw away good proposals for the crime of being patient.
//
// ============ THE COMPARISON IS THE ONE ALREADY BEING MADE ===========
//
// previousValues is getCurrentValues' output. So "has it drifted" is that same
// function run again now, against the same shape, and nothing new is invented
// to answer it. What the check needs is a CONTEXT as complete as the one that
// froze the value — see buildActionContext, which became the single builder
// for exactly this reason.

/** One field whose current value no longer matches what was frozen. */
export interface DriftedField {
  key: string;
  /** The owner-facing name, never the camelCase key. */
  label: string;
  /** What getCurrentValues returned when the proposal was made. */
  was: string;
  /** What it returns now. */
  now: string;
}

/**
 * Every field of `previousValues` the store no longer agrees with.
 *
 * COMPARED BY VALUE, NOT BY IDENTITY. Both sides are Json-shaped, so this
 * compares their serialisations — an object or array field (a theme's colours)
 * has to compare by content or every proposal of that type would read as
 * drifted forever.
 *
 * ONLY THE KEYS THAT WERE FROZEN. Iterating `current` instead would report a
 * field the proposal never recorded as having "changed from nothing", which is
 * a statement about our own schema rather than about the business.
 *
 * Machine plumbing is skipped for the same reason the approval card hides it:
 * a productId is which record to act on, not a value the owner changed, and a
 * refusal reading "Product Id changed" would be both true and useless.
 */
export function driftedFields(
  previousValues: Record<string, unknown>,
  currentValues: Record<string, unknown>
): DriftedField[] {
  const drifted: DriftedField[] = [];
  for (const key of Object.keys(previousValues)) {
    if (HIDDEN_DIFF_KEYS.has(key)) continue;
    const was = previousValues[key];
    const now = currentValues[key];
    if (JSON.stringify(was ?? null) === JSON.stringify(now ?? null)) continue;
    drifted.push({
      key,
      label: FIELD_LABELS[key] ?? key,
      was: formatDiffValue(key, was),
      now: formatDiffValue(key, now),
    });
  }
  return drifted;
}

/** How many changed fields a refusal names before it summarises the rest. */
const NAMED_LIMIT = 3;

/**
 * What the owner is told, in their words rather than the machine's.
 *
 * IT SAYS WHAT CHANGED, NOT MERELY THAT SOMETHING DID. "This is out of date"
 * leaves someone staring at a card with no idea what to do; naming the field
 * and both values lets them see at a glance whether the change was theirs.
 *
 * IT DOES NOT GUESS WHO CHANGED IT. Genesis cannot tell the owner's own edit
 * from another employee's from an earlier approval, and saying "you changed
 * this" to someone who did not is worse than saying nothing about it at all.
 *
 * IT NEVER CLAIMS THE PROPOSAL IS WRONG. The plan may still be exactly right —
 * what is no longer true is the ground it was written against, so the offer is
 * to look again rather than a verdict on the idea.
 */
export function explainDrift(drifted: DriftedField[]): string {
  if (drifted.length === 0) {
    // Unreachable through the approval path, which only calls this when
    // something drifted. Kept because a caller that got here with nothing
    // should say nothing rather than an empty accusation.
    return "Nothing has changed since this was proposed.";
  }

  const named = drifted.slice(0, NAMED_LIMIT);
  const rest = drifted.length - named.length;

  const changes = named
    .map((field) => `${field.label} was "${field.was}" and is now "${field.now}"`)
    .join("; ");

  const andMore = rest > 0 ? `, and ${rest} other field${rest === 1 ? "" : "s"}` : "";

  return (
    `I haven't applied this — the business has changed since I proposed it. ` +
    `${changes}${andMore}. ` +
    `Applying what I wrote back then would overwrite that. ` +
    `Ask me to take another look and I'll propose against how things are now.`
  );
}

/**
 * The gate itself: has the ground moved under this proposal?
 *
 * ONE IMPLEMENTATION, TWO CALL SITES. performApproveGenesisAction and the
 * group loop both decide the same question, and the group loop is the
 * one-click 'approve all' — the path where a stale proposal would be
 * applied without anybody reading it. Two copies of this comparison is the
 * mirrored-registry problem; the copy that drifted would be the one nobody
 * read.
 *
 * READ-ONLY AND FREE OF SESSION. Everything it touches is the store's own
 * data, which is what lets it be driven against real proposals in a
 * database test even though its callers need a request scope.
 *
 * THE CONTEXT IS THE SAME BUILDER THAT FROZE previousValues. A thinner one
 * would report every field it could not see as changed and refuse proposals
 * that were perfectly current — which is not a hypothetical: cognitiveLayer
 * passed three fields until 2026-09-02 and froze defaults for seven of the
 * twenty-three registered actions because of it.
 */
export async function driftFor(
  approval: { actionType: string; input: unknown; previousValues: unknown },
  storeId: string
): Promise<DriftedField[]> {
  const definition = GENESIS_ACTIONS[approval.actionType];
  if (!definition) return [];
  const input = approval.input as Record<string, unknown> | null;
  const context = await buildActionContext(
    storeId,
    typeof input?.recordId === "string" && typeof input?.entityType === "string"
      ? { id: input.recordId as string, entityType: input.entityType as string }
      : null,
    typeof input?.productId === "string" ? (input.productId as string) : null
  );
  const current = (await definition.getCurrentValues(context)) as Record<string, unknown>;
  return driftedFields(approval.previousValues as Record<string, unknown>, current);
}
