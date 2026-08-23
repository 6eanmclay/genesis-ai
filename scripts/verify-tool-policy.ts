import { readFileSync } from "fs";
import { join } from "path";
import { buildStoreChatUnifiedTools } from "@/lib/execution/genesisTools";
import {
  TOOL_POLICY,
  policyFor,
  mayInvokeTool,
  refusalMessage,
  planToolRun,
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
  catalog.filter((n) => TOOL_POLICY[n].permission === PERMISSIONS.GENESIS_CHAT).sort(),
  [...READ_ONLY].sort());
check("and neither of them changes anything",
  READ_ONLY.filter((n) => TOOL_POLICY[n].mutates), []);
check("every other tool still requires store:manage",
  catalog.filter((n) => !READ_ONLY.includes(n) && TOOL_POLICY[n].permission !== PERMISSIONS.STORE_MANAGE),
  []);
check("and every one of those is marked as mutating",
  catalog.filter((n) => !READ_ONLY.includes(n) && !TOOL_POLICY[n].mutates), []);

// A read tool that was quietly marked mutating would be excluded from a
// multi-tool turn for no reason; a mutating tool marked read would be the
// opposite and much worse.
check("no tool is both chat-permissioned and mutating",
  catalog.filter((n) => TOOL_POLICY[n].permission === PERMISSIONS.GENESIS_CHAT && TOOL_POLICY[n].mutates),
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
  (n) => TOOL_POLICY[n].mutates && mayInvokeTool("EMPLOYEE", n).allowed
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
}

// The Server Action learns its tool two ways — its own unified call, and the
// preClassifiedTool the route hands over. Missing the second would leave
// editing the live store reachable with no check at all on that path.
assert("the Server Action checks the pre-classified tool too",
  action.includes("chosenTool?.name ?? preClassifiedTool"),
  "otherwise edit_store_content bypasses the check entirely");

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
