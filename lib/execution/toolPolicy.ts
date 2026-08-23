import { PERMISSIONS, hasPermission, type Permission } from "@/lib/permissions";
import type { StoreRole } from "@prisma/client";

// WHAT EACH TOOL IS ALLOWED TO DO, AND BY WHOM (2026-08-22, Unified
// Intelligence UI2).
//
// THE DEFECT THIS FIXES. The `store:manage` check sat BEFORE the unified call,
// so it gated the whole conversation rather than the individual capability. A
// member with `genesis:chat` but not `store:manage` was declined for
// EVERYTHING — including "what was my revenue last week", which
// look_up_business_data is read-only and would happily answer — with copy
// reading "That's something only the store owner can change". Which is not even
// true of a question.
//
// The gate was coarser than the capabilities behind it, and that coarseness had
// a second cost: because it had to run before anything else, the upload-intent
// classifier could not be a tool, and every single message paid a full model
// round trip to answer a question a regular expression can answer.
//
// NOT A LOOSENING, except where a tool genuinely reads. Every mutating tool
// keeps exactly the permission it has today — `store:manage`. Two tools move to
// `genesis:chat`, and only because neither changes anything: one answers from
// data the reader is already entitled to, and the other returns a link. A
// registry like this makes it tempting to "tidy" a proposal tool down to
// `products:manage` because an employee holds that; nothing here does, because
// nobody has decided that, and inventing authorization policy is not a
// refactor.
//
// PERMISSION IS ONLY HALF. `mutates` is the other, and it is deliberately a
// separate fact rather than derivable from the permission: it is what lets a
// multi-tool turn allow two reads and refuse two writes (UI3), and "requires
// store:manage" and "changes something" are not the same statement — an
// approval tool executes work already authorised, and a read tool could in
// principle need a high permission for sensitivity reasons alone.

export interface ToolPolicy {
  /** What the actor must hold to invoke this tool at all. */
  permission: Permission;
  /**
   * Whether invoking this can change anything about the business or the store —
   * including proposing a change for approval, which creates a real row.
   *
   * A tool that only reads, answers, or navigates is false.
   */
  mutates: boolean;
}

/**
 * Every tool the unified call may emit, and what it takes to invoke it.
 *
 * A hand-maintained mirror of `buildStoreChatUnifiedTools()`, which
 * ARCHITECTURE.md's standing invariant says must carry a runtime cross-check —
 * `scripts/verify-tool-policy.ts` asserts the two agree in BOTH directions. The
 * failure this prevents is specific and silent: a tool present in the catalog
 * and absent here has no policy, and a lookup that fell back to a default would
 * either refuse a legitimate read or, far worse, wave a mutation through.
 */
export const TOOL_POLICY: Record<string, ToolPolicy> = {
  // ---- Reads. The only two that move. -------------------------------------
  /**
   * Answers from the business's own data. The viewer scoping that matters
   * happens inside `getBusinessUnderstanding`, which already withholds
   * owner-scoped beliefs from anyone who is not the owner — this permission
   * governs whether the question may be asked at all, not what the answer
   * contains.
   */
  look_up_business_data: { permission: PERMISSIONS.GENESIS_CHAT, mutates: false },
  /** Returns a destination. Changes nothing, and refusing it helps nobody. */
  take_me_there: { permission: PERMISSIONS.GENESIS_CHAT, mutates: false },
  /**
   * Points at the upload buttons. Reads nothing, writes nothing.
   *
   * genesis:chat is not a loosening but a RESTORATION: as a pre-call this ran
   * ahead of the store:manage gate precisely so any member could be shown where
   * the upload buttons are, and that was the whole reason it could not be a
   * tool. Requiring store:manage for it now would take away something members
   * already had.
   */
  show_upload_options: { permission: PERMISSIONS.GENESIS_CHAT, mutates: false },

  // ---- Everything below keeps store:manage, exactly as today. -------------
  capture_business_fact: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  plan_campaign: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  request_image_change: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  request_product_removal: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  request_product_content_change: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  approve_pending_changes: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  edit_store_content: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  manage_business_asset: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  generate_brand_logo: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  create_design: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  approve_design_as_product: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  create_composition: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  approve_composition: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  improve_storefront: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  answer_supplier_economics: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
  refine_storefront: { permission: PERMISSIONS.STORE_MANAGE, mutates: true },
};

/**
 * The policy for a tool the model named.
 *
 * `Object.hasOwn`, not `TOOL_POLICY[name]`, for the reason ARCHITECTURE.md's
 * sibling rule spells out: the key comes from OUTSIDE — a model chose it — and
 * `TOOL_POLICY["constructor"]` is a truthy object that is not a policy. This
 * codebase has shipped that defect before.
 *
 * Returns null for anything unregistered, and null must be treated as a refusal
 * rather than a default. A tool with no policy is a tool nobody decided the
 * rules for.
 */
export function policyFor(toolName: string): ToolPolicy | null {
  return Object.hasOwn(TOOL_POLICY, toolName) ? TOOL_POLICY[toolName] : null;
}

export type ToolRefusal =
  | { allowed: true; policy: ToolPolicy }
  | { allowed: false; reason: "unknown_tool" | "insufficient_permission"; policy: ToolPolicy | null };

/**
 * May this actor invoke this tool?
 *
 * ONE FUNCTION, called by both turn implementations. The streaming route and
 * the Server Action each had their own copy of the gate, and a permission
 * decision that exists twice is a permission decision that will eventually
 * disagree with itself — which is the same drift that made last night's
 * provenance work patch two files instead of one.
 */
export function mayInvokeTool(role: StoreRole, toolName: string): ToolRefusal {
  const policy = policyFor(toolName);
  if (!policy) return { allowed: false, reason: "unknown_tool", policy: null };
  if (!hasPermission(role, policy.permission)) {
    return { allowed: false, reason: "insufficient_permission", policy };
  }
  return { allowed: true, policy };
}

/**
 * What to say when a tool is refused.
 *
 * SPECIFIC TO WHAT WAS ACTUALLY ASKED FOR, because the message this replaces
 * was not. "That's something only the store owner can change" was returned for
 * every message including questions, which told a member their question was a
 * change attempt — wrong, and confusing in a way that reads as the system not
 * understanding them.
 */
export function refusalMessage(refusal: ToolRefusal): string {
  if (refusal.allowed) throw new Error("refusalMessage called on an allowed invocation");
  if (refusal.reason === "unknown_tool" || !refusal.policy) {
    // Deliberately not "that tool does not exist" — the owner has no idea tools
    // exist, and naming one is naming an internal.
    return "I can't do that one — let me know what you're after and I'll take another run at it.";
  }
  return refusal.policy.mutates
    ? "That's a change only the store owner can make — I don't have permission to update the store on your account. Ask them to make it, or to give you broader access."
    : "I can't get to that on your account. Ask the store owner to give you broader access.";
}

/**
 * Whether a turn may run this set of tools together, and what it must drop.
 *
 * NOT USED YET — the multi-tool turn is a later surface in this milestone (UI3)
 * and this is where its policy will live, so the rule sits beside the
 * permission it has to be checked alongside rather than being invented twice.
 * Exported and asserted now so the two decisions stay in one file.
 *
 * The rule, stated once: a turn may read as often as the cap allows and may
 * change something at most once. Two reads in a turn is J4 doing its job; two
 * unreviewed mutations in a turn is a turn nobody watched.
 */
export const MAX_TOOLS_PER_TURN = 3;

export function planToolRun(
  toolNames: string[]
): { run: string[]; dropped: { name: string; why: "cap" | "second_mutation" }[] } {
  const run: string[] = [];
  const dropped: { name: string; why: "cap" | "second_mutation" }[] = [];
  let mutated = false;

  for (const name of toolNames) {
    if (run.length >= MAX_TOOLS_PER_TURN) {
      dropped.push({ name, why: "cap" });
      continue;
    }
    const policy = policyFor(name);
    // An unregistered name is not silently dropped here — mayInvokeTool refuses
    // it explicitly, with a message. Planning treats it as runnable so that
    // refusal is the thing the owner hears.
    if (policy?.mutates && mutated) {
      dropped.push({ name, why: "second_mutation" });
      continue;
    }
    if (policy?.mutates) mutated = true;
    run.push(name);
  }

  return { run, dropped };
}

/**
 * What to tell the owner about the things they asked for that are not happening.
 *
 * NOT AN APOLOGY AND NOT AN ERROR — the request was understood, it simply is not
 * part of this turn. Written forward-looking because that is what is true, and
 * because the alternative the product had until now was saying nothing at all,
 * which left somebody who asked for two things believing both had been done.
 *
 * The two reasons read differently on purpose. Hitting the cap is J4 having more
 * to do than fits in one turn; a second mutation is a deliberate refusal to
 * change two things in one unreviewed pass, and saying so plainly is better than
 * implying J4 merely ran out of room.
 */
export function describeDroppedTools(
  dropped: { name: string; why: "cap" | "second_mutation" }[]
): string {
  if (dropped.length === 0) return "";
  const count = dropped.length;
  const thing = count === 1 ? "one other thing" : `${count} other things`;
  const anySecondMutation = dropped.some((d) => d.why === "second_mutation");
  return anySecondMutation
    ? `I'm doing one of these at a time so you can see each change before the next — tell me when you want me to pick up ${thing} you asked for.`
    : `That was more than I'll take on in one go — say the word and I'll pick up ${thing} you asked for next.`;
}

/**
 * The tools the non-streaming Server Action can actually carry out.
 *
 * FOUND BY AUDIT, NOT ASSUMED (2026-08-22). app/dashboard/ai-actions.ts has a
 * branch for eleven of the nineteen registered tools. The other eight —
 * generate_brand_logo, create_design, approve_design_as_product,
 * create_composition, approve_composition, improve_storefront, take_me_there
 * and refine_storefront — live only on the streaming route.
 *
 * That was silent and expensive. A message the unified call answered with
 * generate_brand_logo, arriving on this path, matched no branch and fell
 * through to the legacy content pipeline — so asking for a logo ran a full
 * store-content regeneration instead. Genesis doing something other than what
 * it was asked, and reporting the something else as though it were the answer.
 *
 * This list exists so the gap is DECLARED rather than accidental, and so the
 * Server Action can say plainly that it could not do the thing instead of doing
 * a different thing. scripts/verify-tool-policy.ts cross-checks it against that
 * file's real branches, in both directions, so implementing one of the eight
 * fails here until it is listed and removing a branch fails here too.
 */
export const SERVER_ACTION_TOOLS: readonly string[] = [
  "look_up_business_data",
  "show_upload_options",
  "capture_business_fact",
  "plan_campaign",
  "request_image_change",
  "request_product_removal",
  "request_product_content_change",
  "approve_pending_changes",
  "edit_store_content",
  "manage_business_asset",
  "answer_supplier_economics",
];

export function serverActionCanHandle(toolName: string): boolean {
  return SERVER_ACTION_TOOLS.includes(toolName);
}

/**
 * What to say when the turn reached the path that cannot do this.
 *
 * HONEST ABOUT WHAT HAPPENED, which is: nothing. The alternative this replaces
 * was falling through to a different capability entirely and presenting its
 * result — the exact thing the standing rule against reporting a change that
 * did not happen exists to prevent. Says nothing about streams, fallbacks or
 * routes: the owner has no idea there are two paths and should not learn it
 * from an error.
 */
export const UNAVAILABLE_ON_THIS_PATH =
  "Something got in the way of that one and I haven't done it — ask me again and I'll pick it straight up.";
