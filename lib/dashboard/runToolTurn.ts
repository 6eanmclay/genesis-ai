import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { recordGenesisExecution } from "@/lib/execution/genesis";
import { routeToolHandlers, type ToolTurnResult, type TurnProduct } from "@/lib/execution/toolHandlers";
import { firstRefusedTool } from "@/lib/execution/toolPolicy";
import type { StoreRole } from "@prisma/client";
import type { BusinessUnderstanding } from "@/lib/businessModel/understanding";

// RUNNING THE TOOLS A TURN DECIDED ON — once, for both paths
// (2026-08-23, Unified Intelligence UI4).
//
// THE GAP THIS CLOSES, and it was not hypothetical. Every tool branch existed
// TWICE: once inline in app/api/chat/route.ts and once inline in
// app/dashboard/ai-actions.ts — except that the Server Action only ever had
// eleven of the nineteen. The other eight matched nothing there and fell
// through to the legacy content pipeline, so asking for a logo on that path ran
// a full store-content regeneration and reported it as the answer.
//
// That was guarded first — a declared list of what the Server Action could
// actually do, so the gap was named rather than silent — and is now GONE: both
// paths run the same handlers, so every tool works on both, and there is one
// implementation of what a tool does. The list has been deleted with it.
//
// WHAT IS DELIBERATELY NOT SHARED. How a turn RESPONDS. One streams tokens and
// closes a controller; the other revalidates and redirects. Those are genuinely
// different and collapsing them would be a worse abstraction than the
// duplication it replaced. What they must not differ on is what a tool DOES,
// and what gets written down afterwards.

export interface RunToolsInput {
  storeId: string;
  /** The authenticated viewer. */
  userId: string;
  /**
   * What the viewer is to this business.
   *
   * BOTH CALLERS ALREADY REFUSED AN UNAUTHORIZED TURN, and this checks again
   * anyway. Not belt and braces for its own sake: the reason this module exists
   * is that a capability reachable from two callers was reached by the one that
   * had forgotten a step, for weeks, silently. Authorization is the step where
   * that is least acceptable — and it has already happened once here, when a
   * per-tool check met a multi-tool turn and only the first tool was asked
   * about.
   *
   * The callers keep their own check because they can say something useful
   * about it; this one exists so that a third caller, written later by somebody
   * who has not read them, cannot execute anything.
   */
  role: StoreRole;
  userMessage: string;
  /** The model's own accompanying text, if it wrote any. */
  conversationalReply: string;
  products: TurnProduct[];
  /** What policy allowed to run, in order. */
  plannedTools: Anthropic.ToolUseBlock[];
  /** Where the store is addressed, so navigation stays inside this business. */
  resolveHref: (href: string) => string;
  /** A progress line for the owner while real work happens. */
  status: (text: string) => void;
  /** Where to send words as they arrive, when the caller can show them. */
  onDelta?: (delta: string) => void;
  /** The canonical understanding this turn already fetched. */
  understanding?: BusinessUnderstanding;
  /** What J4 said last turn — the only state "ask again" needs. */
  previousAssistantMessage?: string;
}

export type RunToolsOutcome =
  | { kind: "handled"; results: Extract<ToolTurnResult, { handled: true }>[] }
  /**
   * The model's input did not make sense to a handler.
   *
   * Nothing was written, so the caller should fall back rather than report a
   * result — confirming something that never happened is the worse outcome.
   */
  | { kind: "invalid_input" }
  /**
   * A planned tool has no handler at all.
   *
   * Should be unreachable — scripts/verify-tool-handlers.ts asserts every
   * registered tool has one — and is surfaced rather than swallowed precisely
   * because "falls through to whatever comes next" is the failure that made
   * this module necessary.
   */
  | { kind: "no_handler"; toolName: string }
  /**
   * The viewer may not invoke one of these tools.
   *
   * Should be unreachable — both callers refuse before they get here, with copy
   * that says something useful about which capability and why. Reaching it
   * means a caller skipped that, so nothing runs and the caller is told which
   * tool stopped the turn.
   */
  | { kind: "refused"; toolName: string };

/**
 * The previous assistant turn's text, or undefined on a fresh conversation.
 *
 * The only state buildScopeClarification needs to tell "ask" from "ask again",
 * and it lives here because both callers already hold the recent messages and
 * neither should compute it its own way.
 */
export function lastAssistantContent(
  messages: { role: string; content: string }[]
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i].content;
  }
  return undefined;
}

/**
 * Run the planned tools in order, collecting what each one did.
 *
 * Stops at the first tool that cannot be handled, because a turn that half-ran
 * and then reported an unrelated fallback would leave the owner unable to tell
 * what happened.
 */
export async function runPlannedTools(input: RunToolsInput): Promise<RunToolsOutcome> {
  // BEFORE ANY OF THEM RUN, and about all of them. Checking the first and
  // running the rest is the failure this replaces, not a hypothetical one.
  const refused = firstRefusedTool(input.role, input.plannedTools.map((t) => t.name));
  if (refused) return { kind: "refused", toolName: refused.name };

  const handlers = routeToolHandlers({ resolveHref: input.resolveHref });
  const results: Extract<ToolTurnResult, { handled: true }>[] = [];

  for (const tool of input.plannedTools) {
    // Object.hasOwn, not `handlers[name]`: the key came from a model, and a
    // prototype key is not a handler.
    const handler = Object.hasOwn(handlers, tool.name) ? handlers[tool.name] : null;
    if (!handler) return { kind: "no_handler", toolName: tool.name };

    const outcome = await handler({
      storeId: input.storeId,
      userId: input.userId,
      userMessage: input.userMessage,
      conversationalReply: input.conversationalReply,
      input: tool.input,
      status: input.status,
      products: input.products,
      onDelta: input.onDelta,
      understanding: input.understanding,
      previousAssistantMessage: input.previousAssistantMessage,
    });

    if (!outcome.handled) return { kind: "invalid_input" };
    results.push(outcome);
  }

  return { kind: "handled", results };
}

/**
 * Write down what happened, once, however many handlers ran.
 *
 * THE MERCHANT'S OWN MESSAGE IS WRITTEN EXACTLY ONCE. It used to be written
 * inside each branch, which is fine when only one can run and silently wrong
 * the moment two do.
 */
export async function persistToolTurn(input: {
  storeId: string;
  userId: string;
  userMessage: string;
  userMessageChanges: unknown;
  results: Extract<ToolTurnResult, { handled: true }>[];
  /**
   * Whether to write the merchant's own message.
   *
   * EXPLICIT, not inferred. The Server Action path writes it at the top of the
   * turn, before the model is even called; the streaming route writes nothing
   * until it knows the turn resolved locally. Guessing from an empty string
   * would work until somebody sent an empty message.
   */
  writeUserMessage: boolean;
  /**
   * What the owner asked for that is not part of this turn, if anything.
   *
   * WRITTEN HERE RATHER THAN WHERE IT IS SAID, and the ordering is the reason.
   * The streaming route says it before doing the work — correctly, the reader
   * should not wait — but it does not write the merchant's own message until it
   * knows the turn resolved locally, so persisting the notice at the moment it
   * is spoken filed it BEFORE the message it answers. Somebody scrolling back
   * read J4 declining something the merchant had not said yet.
   *
   * The other half of the same problem: a turn that then falls back is re-run
   * by the Server Action, which would write its own notice. Keeping this on the
   * path that also writes the merchant's message means it is persisted exactly
   * when that turn is the one being recorded, and not otherwise.
   */
  droppedNotice?: string | null;
}): Promise<void> {
  if (input.writeUserMessage) {
    await prisma.storeMessage.create({
      data: {
        storeId: input.storeId,
        role: "user",
        content: input.userMessage,
        ...(input.userMessageChanges ? { changes: input.userMessageChanges as object } : {}),
      },
    });
  }

  if (input.droppedNotice) {
    await prisma.storeMessage.create({
      data: { storeId: input.storeId, role: "assistant", content: input.droppedNotice },
    });
  }

  for (const result of input.results) {
    await prisma.storeMessage.create({
      data: {
        storeId: input.storeId,
        role: "assistant",
        content: result.reply,
        // How a rendered artefact — a composition, a mockup — reaches the panel
        // that draws it.
        ...(result.messageChanges ? { changes: result.messageChanges } : {}),
      },
    });
    await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
      // PENDING is the honest status for a PROPOSAL: real work happened and
      // nothing changed yet. Defaulting everything to SUCCESS would record a
      // proposed deletion as a completed one.
      status: result.executionStatus ?? "SUCCESS",
      verified: false,
      message: result.logMessage ?? result.reply,
      retryable: result.retryable ?? false,
      userId: input.userId,
      storeId: input.storeId,
      metadata: { kind: result.kind, ...(result.metadata ?? {}) },
    });
  }
}

/** Every path a turn's results ask to be re-rendered, flattened and de-duplicated. */
export function revalidationPaths(
  results: Extract<ToolTurnResult, { handled: true }>[]
): string[] {
  const paths = results.flatMap((r) =>
    r.revalidate ? (Array.isArray(r.revalidate) ? r.revalidate : [r.revalidate]) : []
  );
  return [...new Set(paths)];
}

/**
 * How the turn as a whole is logged.
 *
 * A turn where any handler could not give the owner what they asked for is not
 * a success, and recording it as one hides the turns worth looking at.
 */
export function turnOutcome(
  results: Extract<ToolTurnResult, { handled: true }>[]
): "success" | "failure" {
  return results.some((r) => r.outcome === "failure") ? "failure" : "success";
}

/** The turn's kind, for the log — several tools joined, so one row still says what ran. */
export function turnKind(results: Extract<ToolTurnResult, { handled: true }>[]): string {
  return results.map((r) => r.kind).join("+");
}
