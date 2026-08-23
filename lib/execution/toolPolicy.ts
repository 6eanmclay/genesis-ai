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
 * The first tool in a turn the viewer may not invoke, if there is one.
 *
 * A TURN IS NOW SEVERAL TOOLS, AND THE CHECK WAS ONE (found 2026-08-23). Both
 * chat paths asked `mayInvokeTool` about the DECIDED tool — the first of the
 * planned list — and then ran the whole list. Two features that were each
 * correct alone: authorization moved onto the capability, and a turn stopped
 * discarding everything after the first tool.
 *
 * Together they were an authorization hole with an ordinary shape. "What sold
 * worst last month? Get rid of it" plans a read and then a mutation; the read
 * is checked, allowed, and the removal proposal runs behind it for a member who
 * has `genesis:chat` and not `store:manage`.
 *
 * The whole turn is refused rather than the offending tool skipped. Running
 * half of what somebody asked for and declining the rest is a design decision
 * nobody has made, and the existing answer to "you may not invoke this" is
 * already that the turn ends.
 */
export function firstRefusedTool(
  role: StoreRole,
  toolNames: string[]
): { name: string; refusal: Extract<ToolRefusal, { allowed: false }> } | null {
  for (const name of toolNames) {
    const refusal = mayInvokeTool(role, name);
    if (!refusal.allowed) return { name, refusal };
  }
  return null;
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

/**
 * The tool that ends the turn somewhere.
 *
 * A TURN CAN ONLY END IN ONE PLACE, and two of these in one plan is not a
 * bigger request, it is a contradiction. Both are reads, so neither the cap nor
 * the one-mutation rule stopped them: the route emitted two navigations, the
 * client pushed both, the last won — and the first reply had already said, in
 * the owner's own conversation, that J4 was taking them somewhere they never
 * arrived. "J4 must never say one place and navigate to another" was asserted
 * for a single tool and quietly untrue for two.
 */
const NAVIGATION_TOOL = "take_me_there";

export type DroppedTool = {
  name: string;
  why: "cap" | "second_mutation" | "second_navigation" | "removal_not_upload";
};

/**
 * An explicit instruction to remove products.
 *
 * DELIBERATELY NOT A PARSER. It is a short list of verbs that only mean one
 * thing when aimed at products, and it exists to protect exactly one invariant
 * that a real model was measured failing: a removal instruction must not be
 * answered as an upload.
 *
 * Live evidence (LIVE_ROUTING_RESULTS.md, 2026-08-23): "Remove the old products
 * and let's upload the first ring" resolved to `show_upload_options` on one
 * screen and to a plain conversational answer on another. Both silently drop a
 * destructive instruction the owner gave.
 *
 * Description text was tried first and did not hold. `show_upload_options`'s
 * own description already forbids this exact phrase, and adding the mirror
 * warning to `request_product_removal` left the result unchanged at 48/50 and
 * moved one variant INTO the forbidden tool. Two descriptions discussing one
 * phrase did not settle it; a rule does.
 */
const EXPLICIT_REMOVAL = /\b(remove|delete|discontinue|get rid of)\b/i;

/**
 * Whether the upload prompt is an acceptable answer to this message.
 *
 * The one thing this rule says, and nothing more: it does not decide that a
 * removal SHOULD have been called, because that would mean inventing the scope
 * and product names the tool needs. It only refuses to let the upload prompt be
 * the answer, so the turn cannot end by silently offering a file picker to
 * somebody who asked for products to be deleted.
 */
export function uploadWouldSwallowRemoval(toolName: string, userMessage: string): boolean {
  return toolName === "show_upload_options" && EXPLICIT_REMOVAL.test(userMessage);
}

export interface ToolPlan {
  run: string[];
  dropped: DroppedTool[];
}

/**
 * What the owner is told about this plan, or null when there is nothing to say.
 *
 * THIS EXISTS BECAUSE THE GATE WAS WRONG IN BOTH CALLERS, IDENTICALLY. Each one
 * wrote `dropped.length > 0 && chosenTool ? describeDroppedTools(...) : null` —
 * suppressing the notice whenever policy left NOTHING to run. Every reason but
 * one drops a surplus tool and leaves a first one standing, so the bug was
 * invisible: `cap`, `second_mutation` and `second_navigation` all keep a
 * chosenTool. `removal_not_upload` does not. It empties the run by design.
 *
 * So the single sentence written for that rule — "You asked me to remove some
 * products, and I want to get that right before anything about uploading. Which
 * ones did you mean?" — could not reach an owner from either path, while
 * verify-tool-policy.ts stayed green calling describeDroppedTools directly. A
 * unit test on a function the product cannot reach in that state is not
 * evidence that the owner hears it.
 *
 * A plan knows whether anything is running. The caller does not have to.
 */
export function droppedNoticeFor(plan: ToolPlan): string | null {
  return plan.dropped.length > 0 ? describeDroppedTools(plan.dropped) : null;
}

/**
 * Whether policy refused everything the model asked for.
 *
 * Distinct from "the model chose no tool", which is an ordinary conversational
 * turn. Callers that fall back to another capability when no tool runs must not
 * take that fallback here: the owner asked for something specific and policy
 * declined it, and regenerating store content instead would answer a question
 * nobody asked.
 */
export function policyRefusedEverything(plan: ToolPlan): boolean {
  return plan.run.length === 0 && plan.dropped.length > 0;
}

export function planToolRun(
  toolNames: string[],
  // The merchant's own words, when the caller has them. Optional so every
  // existing caller and every test that only cares about ordering is unchanged
  // — and because the rules above it are all about tools rather than language.
  userMessage = ""
): ToolPlan {
  const run: string[] = [];
  const dropped: DroppedTool[] = [];
  let mutated = false;
  let navigated = false;

  for (const name of toolNames) {
    if (run.length >= MAX_TOOLS_PER_TURN) {
      dropped.push({ name, why: "cap" });
      continue;
    }
    // AN EXPLICIT REMOVAL IS NOT AN UPLOAD (2026-08-23). Checked before the
    // other rules because it is about what this tool would MEAN here, not about
    // how many tools a turn may hold.
    if (uploadWouldSwallowRemoval(name, userMessage)) {
      dropped.push({ name, why: "removal_not_upload" });
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
    if (name === NAVIGATION_TOOL && navigated) {
      dropped.push({ name, why: "second_navigation" });
      continue;
    }
    if (policy?.mutates) mutated = true;
    if (name === NAVIGATION_TOOL) navigated = true;
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
export function describeDroppedTools(dropped: DroppedTool[]): string {
  if (dropped.length === 0) return "";

  // A DROPPED NAVIGATION IS ITS OWN SENTENCE, and it does not replace the
  // others. The first version of this returned early on a second navigation and
  // said nothing about anything else dropped in the same turn — which is the
  // silence this whole notice exists to end, reintroduced by the fix for it.
  //
  // Separate sentence rather than a merged count because the two are not the
  // same kind of thing: one is "you asked to be in two places", the other is
  // "that was more than I'll do at once". Rolling them into one number would
  // make both vaguer.
  // A REFUSED UPLOAD PROMPT NEEDS ITS OWN SENTENCE. The others are about pacing
  // or arithmetic; this one is about J4 having nearly answered the wrong
  // question, and the owner needs to be asked the right one rather than told
  // something was postponed.
  if (dropped.some((d) => d.why === "removal_not_upload")) {
    // Leads with the removal, deliberately. An earlier draft opened with "Before
    // I show you anything about uploading" and the suite's own ordering check
    // caught it: the destructive request is the subject here, and putting the
    // upload first makes the sentence about the thing J4 is NOT doing.
    return "You asked me to remove some products, and I want to get that right before anything about uploading. Which ones did you mean?";
  }

  const navigations = dropped.filter((d) => d.why === "second_navigation");
  const rest = dropped.filter((d) => d.why !== "second_navigation");

  const navSentence =
    navigations.length > 0 ? "I can only take you to one place at a time — say which." : "";

  if (rest.length === 0) {
    // Nothing else was dropped, so the invitation is about the place.
    return "I can only take you to one place at a time — say which and I'll head there next.";
  }

  const count = rest.length;
  const thing = count === 1 ? "one other thing" : `${count} other things`;
  const restSentence = rest.some((d) => d.why === "second_mutation")
    ? `I'm doing one of these at a time so you can see each change before the next — tell me when you want me to pick up ${thing} you asked for.`
    : `That was more than I'll take on in one go — say the word and I'll pick up ${thing} you asked for next.`;

  return navSentence ? `${navSentence} ${restSentence}` : restSentence;
}

/**
 * What to say when the turn resolved to no work at all.
 *
 * THE GAP THIS WAS BUILT FOR IS CLOSED (2026-08-23). It replaced a declared
 * list of the eleven tools the non-streaming Server Action had a branch for;
 * the other eight — generate_brand_logo among them — matched nothing there and
 * fell through to the legacy content pipeline, so asking for a logo ran a full
 * store-content regeneration and reported that as the answer. Both paths now
 * dispatch through the same handlers, so there is no longer a set of tools one
 * path cannot do, and the list has gone.
 *
 * The MESSAGE stays, because the failure it describes did not go away — it just
 * got rarer. A handler can still resolve to nothing when it cannot use what the
 * model gave it, and falling through from there would run the wrong capability
 * exactly as before. So: honest about what happened, which is nothing. Says
 * nothing about streams, fallbacks or routes — the owner has no idea there are
 * two paths and should not learn it from an error.
 */
export const UNAVAILABLE_ON_THIS_PATH =
  "Something got in the way of that one and I haven't done it — ask me again and I'll pick it straight up.";
