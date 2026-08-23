import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";
import { buildStoreChatUnifiedTools, allToolUses, firstToolUse } from "@/lib/execution/genesisTools";
import { MIGRATED_TOOLS } from "@/lib/execution/toolHandlers";
import {
  TOOL_POLICY,
  policyFor,
  mayInvokeTool,
  refusalMessage,
  planToolRun,
  describeDroppedTools,
  SERVER_ACTION_TOOLS,
  serverActionCanHandle,
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

for (const [name, source] of [["the streaming route", route], ["the Server Action", action]] as const) {
  assert(`${name} asks mayInvokeTool`, source.includes("mayInvokeTool("));
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
// Read from each file's real source, because "does this branch exist" is not a
// question a type can answer.
const handledIn = (source: string) => catalog.filter((n) => source.includes(`"${n}"`));

// THE STREAMING ROUTE HANDLES EVERY TOOL — in one of two places now. Three have
// moved into lib/execution/toolHandlers.ts (which is what finally gave them
// tests); the rest still run inline. A tool in NEITHER place falls through to
// whatever comes next, silently, which is the failure this whole section exists
// for.
const routeHandles = handledIn(route);
const reachable = (n: string) => routeHandles.includes(n) || MIGRATED_TOOLS.includes(n);
check("every registered tool is handled somewhere on the streaming path",
  catalog.filter((n) => !reachable(n)), []);
// AND IN EXACTLY ONE PLACE. Both would run it twice: the dispatcher first, then
// the ladder again.
check("and none is handled in both places at once",
  MIGRATED_TOOLS.filter((n) => route.includes(`if (chosenTool?.name === "${n}")`)), []);

// The Server Action genuinely handles fewer, and that is allowed — what is NOT
// allowed is the gap being undeclared, because an undeclared gap is a silent
// fall-through.
const actionHandles = handledIn(action);
check("the declared Server Action set matches what that file really handles",
  actionHandles.filter((n) => !SERVER_ACTION_TOOLS.includes(n)).sort(),
  []);
check("and nothing is declared that it cannot actually do",
  SERVER_ACTION_TOOLS.filter((n) => !actionHandles.includes(n)).sort(), []);
check("every declared name is a real tool",
  SERVER_ACTION_TOOLS.filter((n) => !catalog.includes(n)), []);

// THE GAP IS REAL, and pinning it means implementing one of the eight has to
// come here and say so rather than being forgotten.
const unhandled = catalog.filter((n) => !serverActionCanHandle(n));
assert("the Server Action's gap is a known, non-empty set",
  unhandled.length > 0, unhandled.join(", "));
// THE EXACT STATEMENT, not the name appearing somewhere in the file. A negative
// control disabled the guard with `if (false && ...)` and the looser check still
// passed, because the text it looked for sat inside the disabled condition. A
// source assertion can always be defeated by somebody determined; what it must
// not do is miss the ordinary way a guard gets switched off.
assert("and the file refuses those rather than falling through",
  action.includes("if (decidedTool && !serverActionCanHandle(decidedTool)) {"),
  "without this, an unhandled tool runs the legacy content pipeline instead");

// The refusal says nothing happened, and nothing about internals.
assert("the refusal says nothing was done",
  /haven't done it|not done/i.test(UNAVAILABLE_ON_THIS_PATH), UNAVAILABLE_ON_THIS_PATH);
assert("and does not mention streams, routes or fallbacks",
  !/stream|route|fallback|server action/i.test(UNAVAILABLE_ON_THIS_PATH),
  "the owner has no idea there are two paths and should not learn it from an error");

// The Server Action learns its tool two ways — its own unified call, and the
// preClassifiedTool the route hands over. Missing the second would leave
// editing the live store reachable with no check at all on that path.
assert("the Server Action checks the pre-classified tool too",
  action.includes("chosenTool?.name ?? preClassifiedTool"),
  "otherwise edit_store_content bypasses the check entirely");

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
