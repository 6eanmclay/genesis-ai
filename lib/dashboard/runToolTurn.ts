import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { recordGenesisExecution } from "@/lib/execution/genesis";
import {
  routeToolHandlers,
  type ToolTurnContext,
  type ToolTurnResult,
  type TurnProduct,
} from "@/lib/execution/toolHandlers";
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
   * A tool threw AFTER an earlier one had already changed something (D1/D2).
   *
   * The distinction from `invalid_input` is the whole point: there, nothing
   * happened and falling back to another path costs the owner nothing. Here
   * something real happened — a logo was set, a proposal was written — and
   * throwing that away means the owner is answered by a different code path
   * while their business quietly changed underneath them.
   *
   * Carries what genuinely succeeded so the caller can record it, and the tool
   * that did not so the caller can say so.
   */
  | {
      kind: "partial";
      results: Extract<ToolTurnResult, { handled: true }>[];
      failedTool: string;
      /** The real cause, for the log. Never shown to the owner. */
      cause: string;
      /**
       * Whether asking again is a real option.
       *
       * False only for a refusal — repeating it sends the owner into the same
       * wall. `approve_pending_changes` already draws this line and this uses
       * the same test.
       */
      retryable: boolean;
    }
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
/**
 * The context one planned tool is run with.
 *
 * SEPARATE AND EXPORTED because of `onDelta`, which is the one field whose
 * value depends on WHERE the tool sits in the turn rather than on the turn
 * itself — see below. That is a rule worth being able to assert directly
 * instead of inferring from a stream.
 */
export function toolContextFor(
  input: RunToolsInput,
  tool: Anthropic.ToolUseBlock,
  index: number
): ToolTurnContext {
  return {
    storeId: input.storeId,
    userId: input.userId,
    userMessage: input.userMessage,
    conversationalReply: input.conversationalReply,
    input: tool.input,
    status: input.status,
    products: input.products,
    // ONLY THE FIRST TOOL MAY STREAM, and the reason is ordering.
    //
    // Every handler runs before any reply is emitted, so a handler that streams
    // puts its words on the wire DURING execution while the replies of the
    // tools before it are still waiting for the loop that emits them. Ask for
    // "take me to orders, and what sold worst last month" and the answer
    // arrived first, with "Taking you to Commerce" appended underneath it —
    // while the stored conversation had them the other way round, because that
    // is written in plan order.
    //
    // A handler that is not first returns its whole text instead and is emitted
    // in its turn. Slower for that one arrangement, and always in the order the
    // owner asked.
    onDelta: index === 0 ? input.onDelta : undefined,
    understanding: input.understanding,
    previousAssistantMessage: input.previousAssistantMessage,
  };
}

export async function runPlannedTools(input: RunToolsInput): Promise<RunToolsOutcome> {
  // BEFORE ANY OF THEM RUN, and about all of them. Checking the first and
  // running the rest is the failure this replaces, not a hypothetical one.
  const refused = firstRefusedTool(input.role, input.plannedTools.map((t) => t.name));
  if (refused) return { kind: "refused", toolName: refused.name };

  const handlers = routeToolHandlers({ resolveHref: input.resolveHref });
  const results: Extract<ToolTurnResult, { handled: true }>[] = [];

  for (const [index, tool] of input.plannedTools.entries()) {
    // Object.hasOwn, not `handlers[name]`: the key came from a model, and a
    // prototype key is not a handler.
    const handler = Object.hasOwn(handlers, tool.name) ? handlers[tool.name] : null;
    if (!handler) return { kind: "no_handler", toolName: tool.name };

    let outcome: ToolTurnResult;
    try {
      outcome = await handler(toolContextFor(input, tool, index));
    } catch (err) {
      // NOTHING EARLIER IS THROWN AWAY (D1). If this is the first tool, nothing
      // has happened yet and the ordinary fallback is still the honest answer —
      // the caller can go somewhere else and the owner loses nothing. Once an
      // earlier tool has changed something, that is no longer true.
      if (results.length === 0) return { kind: "invalid_input" };

      const cause = err instanceof Error ? err.message : String(err);
      return {
        kind: "partial",
        results,
        failedTool: tool.name,
        cause,
        // Same test approve_pending_changes already uses: a permission refusal
        // is not worth repeating, anything else is.
        retryable: !/permission/i.test(cause),
      };
    }

    if (!outcome.handled) {
      // The same rule for a handler that could not use its input. Earlier work
      // is real whether the later tool threw or simply declined.
      if (results.length === 0) return { kind: "invalid_input" };
      return {
        kind: "partial",
        results,
        failedTool: tool.name,
        cause: "handler could not use the model's input",
        retryable: true,
      };
    }
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
  /**
   * The tool that did not run, when the turn stopped part-way (D1).
   *
   * Written as its own assistant message AFTER the replies of everything that
   * did work, because that is the order it happened in. Says nothing about
   * which tool or why — the owner has no idea tools exist — and the real cause
   * goes to the execution row instead.
   */
  unfinished?: { failedTool: string; cause: string; retryable: boolean } | null;
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
    // THE EXECUTION ROW FIRST, so the message can carry its id (UI6).
    //
    // These two were always written together and never joined, so a reader of
    // the conversation had only the prose. The prose is written once, at the
    // moment J4 speaks; the execution row is what it MEANT — proposed and
    // waiting, done, or not done at all — and a conversation that cannot see it
    // can only repeat what was said and hope it is still true.
    //
    // Order matters and this is the safe one: a message with no execution row
    // reads as "no execution to speak of", which is exactly right for an
    // ordinary reply. An execution row with no message is an orphan nobody
    // renders. If the message write fails, the log still holds what happened.
    const logged = await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
      // PENDING is the honest status for a PROPOSAL: real work happened and
      // nothing changed yet. Defaulting everything to SUCCESS would record a
      // proposed deletion as a completed one.
      //
      // AND A TURN THAT FAILED IS NOT A SUCCESS HERE EITHER (2026-08-23).
      // `outcome` and `executionStatus` are separate fields and the default tied
      // them to nothing, so fourteen handlers said `outcome: "failure"` and were
      // written to the execution log as SUCCESS — two records of the same turn,
      // disagreeing, and the one anybody scans for trouble was the one that said
      // everything was fine.
      //
      // WARNING rather than an error status, following the precedent already set
      // for a refused tool: a designed conversational decline is not a crash. A
      // handler that means something more specific still says so, and this only
      // fills in where nothing was stated.
      status: result.executionStatus ?? (result.outcome === "failure" ? "WARNING" : "SUCCESS"),
      verified: false,
      message: result.logMessage ?? result.reply,
      retryable: result.retryable ?? false,
      userId: input.userId,
      storeId: input.storeId,
      metadata: { kind: result.kind, ...(result.metadata ?? {}) },
    });

    await prisma.storeMessage.create({
      data: {
        storeId: input.storeId,
        role: "assistant",
        content: result.reply,
        // How a rendered artefact — a composition, a mockup — reaches the panel
        // that draws it.
        ...(result.messageChanges ? { changes: result.messageChanges } : {}),
        // What actually happened, joined to what was said about it.
        executionLogId: logged.id,
      },
    });
  }

  // AND THEN, IF THE TURN STOPPED PART-WAY, that it stopped (D1). Last, because
  // it happened last: everything above really did happen, and this says only
  // that the remainder did not.
  if (input.unfinished) {
    const content = unfinishedTurnMessage(input.unfinished.retryable);
    const logged = await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
      // WARNING, never SUCCESS. A turn that did not finish is exactly the turn
      // somebody scanning the log needs to find.
      status: "WARNING",
      verified: false,
      // The real cause here, the owner's sentence in the message.
      message: `Turn stopped at ${input.unfinished.failedTool}: ${input.unfinished.cause}`,
      retryable: input.unfinished.retryable,
      userId: input.userId,
      storeId: input.storeId,
      metadata: { kind: "turn_unfinished", failedTool: input.unfinished.failedTool },
    });
    await prisma.storeMessage.create({
      data: { storeId: input.storeId, role: "assistant", content, executionLogId: logged.id },
    });
  }
}

/**
 * What the owner is told when a turn stopped part-way.
 *
 * NOTHING ABOUT MECHANISM. Not the tool, not the error, not that there were
 * several things — "the rest of that" is what a person would say. The real
 * cause is in the execution row where somebody debugging can find it.
 *
 * And it never claims the earlier work is undone: the replies above it already
 * said what happened, and those things really did happen.
 */
export function unfinishedTurnMessage(retryable: boolean): string {
  return retryable
    ? "I couldn't get to the rest of that — nothing else changed. Ask me again and I'll pick it up."
    : "I couldn't get to the rest of that — nothing else changed, and it isn't something I can do for you.";
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
  results: Extract<ToolTurnResult, { handled: true }>[],
  // D1: a turn that stopped part-way is not a success, however well the tools
  // that did run went. Defaulted so every existing caller is unchanged.
  unfinished = false
): "success" | "failure" {
  if (unfinished) return "failure";
  return results.some((r) => r.outcome === "failure") ? "failure" : "success";
}

/** The turn's kind, for the log — several tools joined, so one row still says what ran. */
export function turnKind(results: Extract<ToolTurnResult, { handled: true }>[]): string {
  return results.map((r) => r.kind).join("+");
}
