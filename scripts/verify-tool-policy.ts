import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";
import { buildStoreChatUnifiedTools, allToolUses, firstToolUse } from "@/lib/execution/genesisTools";
import { MIGRATED_TOOLS } from "@/lib/execution/toolHandlers";
import {
  firstRefusedTool,
  TOOL_POLICY,
  policyFor,
  mayInvokeTool,
  refusalMessage,
  planToolRun,
  describeDroppedTools,
  UNAVAILABLE_ON_THIS_PATH,
  MAX_TOOLS_PER_TURN,
} from "@/lib/execution/toolPolicy";
import { PERMISSIONS, ROLE_PERMISSIONS, hasPermission } from "@/lib/permissions";

// WHO MAY ASK J4 FOR WHAT:
//
//   npx tsx scripts/verify-tool-policy.ts
//
// The store:manage gate used to sit ahead of the whole unified call, so it
// refused the CONVERSATION rather than the CAPABILITY. A member with
// genesis:chat and without store:manage was declined for everything — including
// "what was my revenue last week", which look_up_business_data is read-only and
// would have answered — with copy telling them their question was a change
// attempt.
//
// Moving a permission check is the kind of change that is easy to get subtly,
// silently wrong in the dangerous direction. So this file's real job is not
// proving the employee can now ask a question. It is proving that NOTHING ELSE
// moved with it:
//
//   - every tool in the catalog has a policy, and no policy exists for a tool
//     that does not
//   - every mutating tool still requires exactly what it required before
//   - a prototype key is not a policy
//   - an unregistered tool is refused rather than defaulted
//
// No database needed: this is a pure-policy suite, and keeping it that way
// means it runs anywhere, in under a second, on every change to either registry.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

// ============================================================================
console.log("\n=== 1. The policy table mirrors the tool catalog, both ways ===\n");
// ============================================================================
// ARCHITECTURE.md's standing invariant. The compiler cannot check membership
// here — TOOL_POLICY is a Record<string, …> precisely because the tool names
// come from a builder that returns Anthropic.Tool[], and a name present in one
// and absent from the other is not a type error.
//
// The failure is specific and silent: a tool with no policy has no rules, and a
// lookup that fell back to a default would either refuse a legitimate read or,
// far worse, wave a mutation through.
const catalog = buildStoreChatUnifiedTools().map((t) => t.name);
const policied = Object.keys(TOOL_POLICY);

assert("the catalog is not empty", catalog.length > 0, `${catalog.length} tools`);
check("every tool in the catalog has a policy",
  catalog.filter((name) => !policyFor(name)), []);
check("and no policy exists for a tool that does not",
  policied.filter((name) => !catalog.includes(name)), []);
check("the two are the same size", policied.length, catalog.length);

// ============================================================================
console.log("\n=== 2. Nothing was loosened except what genuinely reads ===\n");
// ============================================================================
// THE ASSERTION THAT MAKES THIS CHANGE SAFE. Before today every tool required
// store:manage, because the gate ahead of the call did. This pins exactly which
// two moved and refuses the rest — so a later edit that "tidies" a proposal
// tool down to products:manage because an employee happens to hold it has to
// argue with a failing test rather than slip through a diff.
const READ_ONLY = ["look_up_business_data", "take_me_there", "show_upload_options"];
check("exactly the read-only tools are readable by anyone who can chat",
  catalog.filter((n) => policyFor(n)?.permission === PERMISSIONS.GENESIS_CHAT).sort(),
  [...READ_ONLY].sort());
check("and neither of them changes anything",
  READ_ONLY.filter((n) => policyFor(n)?.mutates), []);
check("every other tool still requires store:manage",
  catalog.filter((n) => !READ_ONLY.includes(n) && policyFor(n)?.permission !== PERMISSIONS.STORE_MANAGE),
  []);
check("and every one of those is marked as mutating",
  catalog.filter((n) => !READ_ONLY.includes(n) && !policyFor(n)?.mutates), []);

// A read tool that was quietly marked mutating would be excluded from a
// multi-tool turn for no reason; a mutating tool marked read would be the
// opposite and much worse.
check("no tool is both chat-permissioned and mutating",
  catalog.filter((n) => policyFor(n)?.permission === PERMISSIONS.GENESIS_CHAT && policyFor(n)?.mutates),
  []);

// ============================================================================
console.log("\n=== 3. An employee can ask, and cannot change ===\n");
// ============================================================================
// The defect this milestone item exists for, stated as the two outcomes it has
// to produce from one code path.
assert("an employee holds genesis:chat at all",
  hasPermission("EMPLOYEE", PERMISSIONS.GENESIS_CHAT),
  ROLE_PERMISSIONS.EMPLOYEE.join(", "));
assert("and does not hold store:manage",
  !hasPermission("EMPLOYEE", PERMISSIONS.STORE_MANAGE));

const employeeAsks = mayInvokeTool("EMPLOYEE", "look_up_business_data");
assert("so an employee may ask a question", employeeAsks.allowed, JSON.stringify(employeeAsks));
const employeeNavigates = mayInvokeTool("EMPLOYEE", "take_me_there");
assert("and may be shown where something is", employeeNavigates.allowed);

const employeeEdits = mayInvokeTool("EMPLOYEE", "edit_store_content");
assert("but may not edit the store", !employeeEdits.allowed);
check("and is told why in terms of the change, not the question",
  employeeEdits.allowed ? "allowed" : employeeEdits.reason, "insufficient_permission");

// EVERY mutating tool, not a sample. A single one left open is the whole hole.
const openToEmployee = catalog.filter(
  (n) => policyFor(n)?.mutates && mayInvokeTool("EMPLOYEE", n).allowed
);
check("no mutating tool is open to an employee", openToEmployee, []);

// And the owner still reaches everything.
const closedToOwner = catalog.filter((n) => !mayInvokeTool("OWNER", n).allowed);
check("the owner can still reach every tool", closedToOwner, []);

// ============================================================================
console.log("\n=== 4. An unregistered name is refused, never defaulted ===\n");
// ============================================================================
// The registry-lookup sibling rule: the key comes from OUTSIDE — a model chose
// it — and `TOOL_POLICY["constructor"]` is a truthy object that is not a policy.
// This codebase has shipped that exact defect before.
check("a prototype key has no policy", policyFor("constructor"), null);
check("nor does toString", policyFor("toString"), null);
check("nor an invented tool", policyFor("delete_everything"), null);

const madeUp = mayInvokeTool("OWNER", "delete_everything");
assert("an unregistered tool is refused even for the owner", !madeUp.allowed);
check("as an unknown tool rather than a permission problem",
  madeUp.allowed ? "allowed" : madeUp.reason, "unknown_tool");
const prototypeKey = mayInvokeTool("OWNER", "constructor");
assert("and a prototype key is refused the same way",
  !prototypeKey.allowed && prototypeKey.reason === "unknown_tool");

// ============================================================================
console.log("\n=== 5. The refusal is something a person can read ===\n");
// ============================================================================
// The message being replaced said "That's something only the store owner can
// change" — returned for every message, including questions. It told a member
// their question was a change attempt.
const changeRefusal = refusalMessage(mayInvokeTool("EMPLOYEE", "edit_store_content"));
assert("a refused change says it is a change", changeRefusal.includes("change"), changeRefusal);
assert("and names who can make it", changeRefusal.includes("store owner"), changeRefusal);

const unknownRefusal = refusalMessage(madeUp);
// Naming a tool at an owner is naming an internal — they have no idea tools
// exist.
assert("an unknown tool does not name the tool",
  !unknownRefusal.includes("delete_everything"), unknownRefusal);
assert("and does not say the word tool at all",
  !/\btool\b/i.test(unknownRefusal), unknownRefusal);

for (const name of catalog) {
  const refused = mayInvokeTool("EMPLOYEE", name);
  if (refused.allowed) continue;
  const message = refusalMessage(refused);
  assert(`the refusal for ${name} is a real sentence`,
    message.length > 20 && !message.includes("_") && message.trim().endsWith("."),
    message);
}

// ============================================================================
console.log("\n=== 6. A turn may read freely and change once ===\n");
// ============================================================================
// Not wired into a turn yet — the multi-tool surface is later in this milestone.
// The policy lives here, beside the permission it has to be checked alongside,
// so the two decisions are made in one place rather than invented twice.
const twoReads = planToolRun(["look_up_business_data", "take_me_there"]);
check("two reads both run", twoReads.run, ["look_up_business_data", "take_me_there"]);
check("and nothing is dropped", twoReads.dropped, []);

const readThenWrite = planToolRun(["look_up_business_data", "edit_store_content"]);
check("a read followed by a change is exactly what this is for",
  readThenWrite.run, ["look_up_business_data", "edit_store_content"]);

// TWO UNREVIEWED MUTATIONS IN ONE TURN IS A TURN NOBODY WATCHED.
const twoWrites = planToolRun(["edit_store_content", "request_product_removal"]);
check("the first change runs", twoWrites.run, ["edit_store_content"]);
check("the second is dropped, and says why",
  twoWrites.dropped, [{ name: "request_product_removal", why: "second_mutation" }]);

const many = planToolRun([
  "look_up_business_data", "take_me_there", "look_up_business_data",
  "take_me_there", "edit_store_content",
]);
check("the cap holds", many.run.length, MAX_TOOLS_PER_TURN);
assert("and everything past it is reported rather than discarded",
  many.dropped.length === 2 && many.dropped.every((d) => d.why === "cap"),
  JSON.stringify(many.dropped));

// An unregistered name is NOT silently dropped by planning — mayInvokeTool
// refuses it with a message, and that refusal is what the owner should hear.
const withUnknown = planToolRun(["not_a_tool"]);
check("an unknown name reaches the refusal rather than vanishing in planning",
  withUnknown.run, ["not_a_tool"]);

// ============================================================================
console.log("\n=== 6b. Nothing the model asks for vanishes silently ===\n");
// ============================================================================
// firstToolUse returned the first block and discarded the rest, with no error
// and no log line. A turn where the merchant asked for two things did one of
// them and said nothing about the other — the same class of failure as reporting
// a change that did not happen, arriving from the other direction.
// Shaped as the SDK's own ContentBlock, so this exercises the real signature
// rather than a convenient stand-in.
const blocks: Anthropic.ContentBlock[] = [
  { type: "text", text: "sure", citations: null },
  { type: "tool_use", id: "1", name: "request_product_content_change", input: {}, caller: { type: "direct" } },
  { type: "tool_use", id: "2", name: "request_image_change", input: {}, caller: { type: "direct" } },
];
check("every tool the model asked for is read",
  allToolUses(blocks).map((t) => t.name),
  ["request_product_content_change", "request_image_change"]);
check("and the first is still the first", firstToolUse(blocks)?.name, "request_product_content_change");
check("text blocks are not mistaken for tools", allToolUses([{ type: "text", text: "hi", citations: null }]), []);

// THE OWNER IS TOLD. Two changes in one turn is still refused — deliberately,
// so each is seen before the next — but it is no longer invisible.
const twoChangeNotice = describeDroppedTools([{ name: "request_image_change", why: "second_mutation" }]);
assert("a dropped second change produces a real sentence",
  twoChangeNotice.length > 20 && twoChangeNotice.trim().endsWith("."), twoChangeNotice);
assert("that says why, rather than implying J4 ran out of room",
  twoChangeNotice.includes("one of these at a time"), twoChangeNotice);
assert("and names it as something still to come",
  twoChangeNotice.includes("pick up"), twoChangeNotice);
// Never an internal name at an owner.
assert("without naming the tool", !twoChangeNotice.includes("request_image_change"), twoChangeNotice);

const capNotice = describeDroppedTools([
  { name: "take_me_there", why: "cap" },
  { name: "look_up_business_data", why: "cap" },
]);
assert("hitting the cap reads differently from refusing a second change",
  capNotice !== twoChangeNotice, capNotice);
assert("and counts them", capNotice.includes("2 other things"), capNotice);
check("nothing dropped says nothing at all", describeDroppedTools([]), "");

// ============================================================================
console.log("\n=== 7. Both turn implementations use the same decision ===\n");
// ============================================================================
// A permission question with two implementations is a permission question that
// will eventually have two answers — which is exactly how the two chat paths
// drifted before.
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const route = read(join("app", "api", "chat", "route.ts"));
const action = read(join("app", "dashboard", "ai-actions.ts"));

// THE EXACT STATEMENT, per path. A first attempt asserted only that
// `firstRefusedTool(role,` appeared, and a negative control that narrowed the
// argument to `[chosenTool.name]` sailed straight through it — the hole this
// section exists for, reintroduced, with the assertion still green. What
// matters here is not that the function is called but WHAT IT IS ASKED ABOUT.
const AUTHORIZES_THE_WHOLE_TURN = {
  "the streaming route": "firstRefusedTool(role, plannedTools.map((t) => t.name))",
  "the Server Action": "firstRefusedTool(role, toolsToAuthorize)",
} as const;

for (const [name, source] of [["the streaming route", route], ["the Server Action", action]] as const) {
  // Through firstRefusedTool, which is mayInvokeTool over the whole planned
  // list rather than its head — see section 9.
  assert(`${name} asks the shared permission question about every planned tool`,
    source.includes(AUTHORIZES_THE_WHOLE_TURN[name]),
    `expected exactly: ${AUTHORIZES_THE_WHOLE_TURN[name]}`);
  assert(`${name} uses the shared refusal copy`, source.includes("refusalMessage("));
  // THE OLD GATE IS GONE, not merely bypassed. A blanket store:manage check
  // left standing would refuse the employee before the tool check ever ran.
  assert(`${name} no longer gates the whole conversation on store:manage`,
    !source.includes("hasPermission(role, PERMISSIONS.STORE_MANAGE)"));
  // READS EVERY TOOL, not just the first, and decides what runs from policy
  // rather than from emission order.
  assert(`${name} reads every tool the model asked for`, source.includes("allToolUses("));
  assert(`${name} plans what may run`, source.includes("planToolRun("));
  assert(`${name} tells the owner what it is not doing`, source.includes("describeDroppedTools("));
  // AND RUNS ALL OF THEM. The Server Action read every tool, planned every
  // tool, and then ran plan.run[0] — discarding the rest, which are NOT in
  // plan.dropped precisely because policy allowed them. Nothing said they had
  // gone. Its own comment claimed it applied "the same plan the streaming route
  // applies"; it planned the same and acted differently.
  // AND AUTHORIZES EVERY ONE OF THEM. Two features that were each correct
  // alone: authorization moved onto the capability, and a turn stopped
  // discarding everything after the first tool. Together, the check ran on the
  // head of the planned list and the whole list ran.
  assert(`${name} authorizes every planned tool, not just the decided one`,
    source.includes("firstRefusedTool(role,"),
    "a read that passes must not carry an unauthorized mutation behind it");
  assert(`${name} does not check only the decided tool`,
    !source.includes("mayInvokeTool(role, chosenTool.name)") &&
      !source.includes("mayInvokeTool(role, decidedTool)"),
    "the decided tool is the first of several, and the rest run too");
  assert(`${name} runs every tool the plan allowed, not just the first`,
    source.includes("plannedTools = plan.run") || source.includes("const plannedTools = plan.run"),
    "a path that silently drops an allowed second request is the drift this plan exists to end");
  assert(`${name} passes that same list to the runner`,
    source.includes("plannedTools,"),
    "authorizing one list and running another is two answers to one question");
  assert(`${name} does not fall back to the first emitted tool`,
    !source.includes("firstToolUse("),
    "planning what runs and then running what was emitted first is two different answers");
}

// ============================================================================
console.log("\n=== 8. Every tool the model can emit is actually handled ===\n");
// ============================================================================
// A tool present in the catalog with no branch in a dispatch ladder is
// ARCHITECTURE.md's standing invariant in its most dangerous form: it does not
// error, it falls through to whatever comes next. That is not hypothetical here
// — it was the live state until this suite was written. Eight of the nineteen
// tools had no branch in the Server Action, so a message answered with
// generate_brand_logo fell through to the legacy content pipeline and ran a
// full store-content regeneration instead, reporting that as the answer.
//
// That is now structurally impossible rather than merely listed: both paths
// dispatch through lib/execution/toolHandlers.ts, so a tool is handled or it is
// handled nowhere. What this section still has to hold is that the SHAPE stays
// that way — one registry, both callers, and no quiet route back to the
// content pipeline for a turn that resolved to nothing.
//
// Read from each file's real source, because "does this dispatch" is not a
// question a type can answer.

// edit_store_content is the single tool with no handler, because the legacy
// content pipeline IS its implementation. Named here rather than skipped.
const CONTENT_PIPELINE_TOOL = "edit_store_content";
check("every tool but the content pipeline's own has a handler",
  catalog.filter((n) => !MIGRATED_TOOLS.includes(n) && n !== CONTENT_PIPELINE_TOOL), []);
check("and every handler is for a real tool",
  MIGRATED_TOOLS.filter((n) => !catalog.includes(n)), []);

for (const [name, source] of [["the streaming route", route], ["the Server Action", action]] as const) {
  assert(`${name} dispatches through the shared runner`,
    source.includes("await runPlannedTools({"),
    "a second implementation of a turn is how these two paths drifted apart before");
  // AND IN EXACTLY ONE PLACE. Both would run the tool twice: the runner first,
  // then the ladder again.
  check(`${name} has no inline branch left`,
    catalog.filter((n) => source.includes(`if (chosenTool?.name === "${n}")`)), []);
}

// THE LAST FALL-THROUGH. When a handler resolves to no work, the Server Action
// used to continue into the content pipeline below it — which is the original
// defect with a different trigger: the owner is shown another capability's
// result as though it were the answer. The exact statement, not the name
// appearing somewhere in the file: a negative control once disabled a guard
// with `if (false && ...)` and a looser check still passed because the text it
// looked for sat inside the disabled condition.
assert("an unresolved turn does not run the content pipeline instead",
  action.includes('if (decidedTool !== "edit_store_content") {'),
  "without this, a tool that resolved to nothing regenerates the whole storefront");

// The refusal says nothing happened, and nothing about internals.
assert("the refusal says nothing was done",
  /haven't done it|not done/i.test(UNAVAILABLE_ON_THIS_PATH), UNAVAILABLE_ON_THIS_PATH);
assert("and does not mention streams, routes or fallbacks",
  !/stream|route|fallback|server action/i.test(UNAVAILABLE_ON_THIS_PATH),
  "the owner has no idea there are two paths and should not learn it from an error");

// The Server Action learns its tool two ways — its own unified call, and the
// preClassifiedTool the route hands over. Missing the second would leave
// editing the live store reachable with no check at all on that path.
assert("the Server Action's authorized list is the planned list",
  action.includes("const toolsToAuthorize = plannedTools.length > 0") &&
    action.includes("? plannedTools.map((t) => t.name)"),
  "a named list that stopped following the plan would authorize the wrong turn");
assert("the Server Action checks the pre-classified tool too",
  action.includes("chosenTool?.name ?? preClassifiedTool"),
  "otherwise edit_store_content bypasses the check entirely");

// ============================================================================
console.log("\n=== 9b. An explicit removal is not an upload ===\n");
// ============================================================================
// THE ONLY RULE HERE THAT READS THE MERCHANT'S WORDS, and it exists because a
// real model was measured failing without it. "Remove the old products and
// let's upload the first ring" resolved to show_upload_options on one screen
// and to a plain conversational answer on another — both silently dropping a
// destructive instruction the owner gave (LIVE_ROUTING_RESULTS.md).
//
// Description text was tried first and did not hold. show_upload_options's own
// description already forbids that exact phrase, and adding the mirror warning
// to request_product_removal left the live result unchanged at 48/50 and moved
// one variant INTO the forbidden tool. That attempt was reverted rather than
// kept for sounding right.
const COMPOUND = "Remove the old products and let's upload the first ring.";

const swallowed = planToolRun(["show_upload_options"], COMPOUND);
check("the upload prompt is refused for a removal instruction", swallowed.run, []);
check("and says why", swallowed.dropped, [{ name: "show_upload_options", why: "removal_not_upload" }]);

// THE OWNER IS ASKED THE RIGHT QUESTION, not told something was postponed. The
// other dropped reasons are about pacing; this one is J4 having nearly answered
// the wrong question.
const askedProperly = describeDroppedTools(swallowed.dropped);
assert("the owner is asked which products they meant",
  /which ones did you mean/i.test(askedProperly), askedProperly);
assert("and it leads with the removal, not the upload",
  askedProperly.indexOf("remove") < askedProperly.indexOf("upload"), askedProperly);
assert("never reading as a postponement",
  !/pick up|next|one at a time|more than I'll take on/i.test(askedProperly), askedProperly);

// NARROW, AND THESE ASSERTIONS ARE WHAT KEEP IT NARROW. It is one tool and one
// condition — not a general parser, and not a claim about what SHOULD have been
// called instead, which would mean inventing the scope and product names the
// removal tool needs.
check("an ordinary upload message is untouched",
  planToolRun(["show_upload_options"], "I have some photos I want to give you.").run,
  ["show_upload_options"]);
check("and so is one that merely mentions a photo",
  planToolRun(["show_upload_options"], "The photo on my homepage looks bad.").run,
  ["show_upload_options"]);
// The rule is about the upload prompt only. A removal instruction paired with
// any other tool is left entirely alone.
check("the rule touches no other tool",
  planToolRun(["request_product_removal"], COMPOUND).run, ["request_product_removal"]);
check("nor a data question that happens to say 'delete'",
  planToolRun(["look_up_business_data"], "How many products did I delete last month?").run,
  ["look_up_business_data"]);
// And with no message at all — every existing caller and test — nothing changes.
check("no message means the rule cannot fire",
  planToolRun(["show_upload_options"]).run, ["show_upload_options"]);

// Each removal verb the live case established, and only those.
for (const verb of ["remove", "delete", "discontinue", "get rid of"]) {
  check(`"${verb}" is an explicit removal`,
    planToolRun(["show_upload_options"], `Please ${verb} the old products for me.`).run, []);
}
assert("but a vague tidy-up is not",
  planToolRun(["show_upload_options"], "Can you tidy up my catalogue?").run.length === 1,
  "widening this into a synonym hunt is how it becomes the parser it must not be");

// ============================================================================
console.log("\n=== 10. A turn ends in one place ===\n");
// ============================================================================
// Two navigations in one plan is not a bigger request, it is a contradiction.
// Both are reads, so neither the cap nor the one-mutation rule stopped them:
// the route emitted two navigate events, the client pushed both, the last won
// — and the FIRST reply had already told the owner, in their own conversation,
// that J4 was taking them somewhere they never arrived at. "J4 must never say
// one place and navigate to another" was asserted for a single tool and quietly
// untrue for two.
const twoPlaces = planToolRun(["take_me_there", "take_me_there"]);
check("only one navigation survives planning", twoPlaces.run, ["take_me_there"]);
check("and the second is dropped for the right reason",
  twoPlaces.dropped, [{ name: "take_me_there", why: "second_navigation" }]);

// NOT the cap, and not the mutation rule. Both would produce copy that says
// something untrue about why.
const navCopy = describeDroppedTools(twoPlaces.dropped);
assert("the owner is told it is one place at a time",
  /one place at a time/i.test(navCopy), navCopy);
assert("not that J4 is pacing its changes",
  !/one of these at a time/i.test(navCopy), navCopy);
assert("nor that they asked for too much",
  !/more than I'll take on/i.test(navCopy), navCopy);

// A DROPPED NAVIGATION DOES NOT SWALLOW THE OTHERS. The first version of this
// returned early on a second navigation and said nothing about anything else
// dropped in the same turn — the silence the notice exists to end, put back by
// the fix for it.
const navAndCap = describeDroppedTools([
  { name: "take_me_there", why: "second_navigation" },
  { name: "plan_campaign", why: "cap" },
]);
assert("a dropped navigation is still named", /one place at a time/i.test(navAndCap), navAndCap);
assert("and so is everything else dropped with it",
  /one other thing/i.test(navAndCap), navAndCap);

const navAndMutation = describeDroppedTools([
  { name: "take_me_there", why: "second_navigation" },
  { name: "plan_campaign", why: "second_mutation" },
  { name: "create_design", why: "second_mutation" },
]);
assert("two other things are counted as two", /2 other things/i.test(navAndMutation), navAndMutation);
assert("with the pacing reason, not the cap's", /one of these at a time/i.test(navAndMutation), navAndMutation);
// The count is of the OTHERS. Including the navigation would tell the owner
// there were three other things when they can see they asked to go one place.
assert("the navigation is not counted among them",
  !/3 other things/i.test(navAndMutation), navAndMutation);

// A navigation alongside other work is still fine — this is one rule about one
// tool, not a general "nothing may accompany a navigation".
const navPlusRead = planToolRun(["take_me_there", "look_up_business_data"]);
check("a navigation may still travel with a read",
  navPlusRead.run, ["take_me_there", "look_up_business_data"]);
check("with nothing dropped", navPlusRead.dropped, []);
const navPlusWrite = planToolRun(["take_me_there", "plan_campaign"]);
check("and with a change", navPlusWrite.run, ["take_me_there", "plan_campaign"]);

// Order does not matter: whichever navigation is second is the one dropped.
const readThenTwoNavs = planToolRun(["look_up_business_data", "take_me_there", "take_me_there"]);
check("the surviving navigation is the first one asked for",
  readThenTwoNavs.run, ["look_up_business_data", "take_me_there"]);

// The cap still applies on top, and reports itself as the cap.
const four = planToolRun([
  "look_up_business_data", "show_upload_options", "look_up_business_data", "show_upload_options",
]);
check("the cap is unchanged", four.run.length, MAX_TOOLS_PER_TURN);
check("and still says so", four.dropped.map((d) => d.why), ["cap"]);

// ============================================================================
console.log("\n=== 9. A turn is several tools, and the check is not one ===\n");
// ============================================================================
// The ordinary shape of the hole: "what sold worst last month? get rid of it"
// plans a read and then a mutation. The read is allowed for an employee with
// genesis:chat, and until 2026-08-23 that was the only thing asked.
const readThenMutate = ["look_up_business_data", "request_product_removal"];
check("policy allows both of those to be planned",
  planToolRun(readThenMutate).run, readThenMutate);

const memberRefusal = firstRefusedTool("EMPLOYEE", readThenMutate);
assert("an employee is refused the mutation behind the read",
  memberRefusal?.name === "request_product_removal", JSON.stringify(memberRefusal));
// NOT the first tool. Naming the read would tell an employee their QUESTION was
// declined, which is both wrong and the exact confusion refusalMessage exists
// to stop.
assert("and the refusal names what was actually refused",
  refusalMessage(memberRefusal!.refusal).length > 0 && memberRefusal?.name !== "look_up_business_data",
  "naming the read tells an employee their question was a change attempt");

check("the owner is refused neither", firstRefusedTool("OWNER", readThenMutate), null);
// Order does not matter: the mutation is found whichever end it sits at.
assert("the mutation is caught first as well",
  firstRefusedTool("EMPLOYEE", [...readThenMutate].reverse())?.name === "request_product_removal");
check("a turn of reads only is not refused",
  firstRefusedTool("EMPLOYEE", ["look_up_business_data", "show_upload_options"]), null);
// An unknown name is refused rather than skipped — it came from a model.
assert("an unknown tool is refused, not passed over",
  firstRefusedTool("OWNER", ["look_up_business_data", "constructor"])?.name === "constructor");
check("and nothing to check is nothing to refuse", firstRefusedTool("EMPLOYEE", []), null);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
