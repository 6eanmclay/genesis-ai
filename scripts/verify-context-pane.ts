import { readFileSync } from "fs";
import { join } from "path";
import {
  CONTEXT_TYPES,
  CONTEXT_TYPE_KEYS,
  buildContextEntries,
  isContextType,
} from "@/lib/j4/contextTypes";
import type { BusinessUnderstanding } from "@/lib/businessModel/understanding";

// THE CONTEXT PANE (UI6 piece 1):
//
//   npx tsx scripts/verify-context-pane.ts
//
// NO DATABASE AND NO MODEL, deliberately — and that is itself the first
// assertion. The registry's readers are pure functions of an understanding the
// surface already fetched, so there is nowhere in the pane for a query, a
// mutation or an approval to live. A suite that needed a database to test this
// would be testing something else.
//
//   Context pane = understand. Action surface = change.
//
// This is NOT in the shared runner (it needs nothing to run), so a green 41/41
// does not include it — the lesson verify-insights-live taught the hard way.

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

/**
 * A file's CODE, with its comments removed.
 *
 * THE FIFTH ASSERTION IN THIS REPOSITORY TO FAIL ON ITS OWN PROSE. A check that
 * the pane creates no approval matched the comment saying it never does; a check
 * that nothing reconstructs a historical understanding matched the comment
 * explaining why. Each time the code was right and the assertion was reading the
 * wrong thing.
 *
 * Fixing it case by case was clearly not working, so this fixes the class:
 * source assertions run against code, and a comment can no longer satisfy or
 * break one. The comments stay — they are the record of why any of this is
 * shaped as it is — they simply stop being evidence.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // block comments, including JSX {/* … */}
    .replace(/(^|[^:])\/\/.*$/gm, "$1");  // line comments, sparing the // in a URL
}

const read = (p: string[]) => codeOnly(readFileSync(join(process.cwd(), ...p), "utf8"));
const pane = read(["app", "j4", "ContextPane.tsx"]);
const workspace = read(["app", "j4", "J4Workspace.tsx"]);
const registry = read(["lib", "j4", "contextTypes.ts"]);

/** An understanding with something in every registered field. */
const full = {
  profile: {
    goals: [{ data: { description: "Double ring revenue" } }, { data: { description: "Open a second workshop" } }],
    challenges: [{ data: { description: "Lead times from the caster" } }],
  },
  currentAssets: { "brand.logo": {}, "storefront.hero": {} },
} as unknown as BusinessUnderstanding;

const empty = {
  profile: { goals: [], challenges: [] },
  currentAssets: {},
} as unknown as BusinessUnderstanding;

// ==========================================================================
console.log("\n=== 1. The registry is closed, and it is a real mirror ===\n");
// ==========================================================================
// MIRRORED-REGISTRY INVARIANT. Every entry must name a real reader over a real
// field — an entry that resolves to nothing is the failure this class of check
// exists to catch, and it is silent without one.
for (const key of CONTEXT_TYPE_KEYS) {
  const type = CONTEXT_TYPES[key];
  assert(`"${key}" has a real label`, typeof type.label === "string" && type.label.length > 0, key);
  assert(`"${key}" has a reader`, typeof type.read === "function", key);
  assert(`"${key}" resolves against a real understanding`,
    Array.isArray(type.read(full)), "an entry that reads nothing is a dangling registry reference");
  assert(`"${key}" survives an empty one`,
    Array.isArray(type.read(empty)), "a business J4 knows nothing about must not throw");
}

// CLOSED. Anything not registered is not eligible, and a prototype key is not a
// context type — the discipline that exists because one registry here once let
// "constructor" reach a live model call.
check("an unregistered type is not eligible", isContextType("orders"), false);
check("nor is a prototype key", isContextType("constructor"), false);
check("nor toString", isContextType("toString"), false);
for (const key of CONTEXT_TYPE_KEYS) {
  check(`"${key}" is eligible`, isContextType(key), true);
}
// The set is small on purpose. If this grows, it should be because somebody
// decided to add one, which is a decision and not a refactor.
assert("the registry is deliberately small", CONTEXT_TYPE_KEYS.length <= 5,
  `${CONTEXT_TYPE_KEYS.length} types — growth here is a product decision, not a tidy-up`);

// ==========================================================================
console.log("\n=== 2. What it shows, and what it shows when there is nothing ===\n");
// ==========================================================================
const entries = buildContextEntries(full);
check("every registered type with content appears", entries.map((e) => e.key), ["goals", "challenges", "assets"]);
assert("with the owner's own words", entries[0].lines.includes("Double ring revenue"), JSON.stringify(entries[0]));
// An empty group is dropped rather than rendered as a heading over nothing.
check("a business J4 knows nothing about shows nothing", buildContextEntries(empty), []);
assert("and the pane says so honestly rather than showing filler",
  pane.includes("Nothing recorded yet"), "an empty state is a real answer");

// ==========================================================================
console.log("\n=== 3. READ-ONLY — no write path from the pane ===\n");
// ==========================================================================
// The property, tested where it lives. A reader takes a value and returns
// strings, so there is nowhere in the registry for a query or a mutation.
assert("the registry reaches no database",
  !/prisma\.|\$transaction|findMany|create\(|update\(/.test(registry),
  "a reader is a pure function of an already-fetched understanding");
// AND DOES NOT EVEN IMPORT ONE. A negative control that added a bare `import
// { prisma }` slipped past the usage check above — harmless in itself, and
// exactly one line from not being. A pure reader module has no business holding
// a database client, so the boundary is drawn at the import.
assert("and does not import a database client",
  !/from "@\/lib\/prisma"/.test(registry),
  "the line between reading a value and reading a database is the import");
assert("and no model", !/callGenesisModel|anthropic/i.test(registry), "the pane is not a J4 capability");

// The component. No server action, no form, no mutation, no approval.
assert("the pane declares no server action",
  !pane.includes('"use server"') && !/from "\.\/.*-actions"/.test(pane),
  "a server action reachable from here is a write path");
assert("and contains no form", !/<form/.test(pane), "the pane collects nothing");
assert("nor creates an approval",
  !/approval|proposal|execute\(/i.test(pane),
  "anything that changes state goes through proposal → authorization → execution");
// Its only control closes it.
const buttons = pane.match(/data-role="[^"]*"/g) ?? [];
check("the pane's only control is the one that closes it",
  buttons.filter((b) => b.includes("close")).length, 1);
assert("and it has no other button",
  (pane.match(/<button/g) ?? []).length === 1,
  "a second control in a read-only pane is the beginning of an editor");

// ==========================================================================
console.log("\n=== 4. OWNER-INITIATED — nothing else can open it ===\n");
// ==========================================================================
// The invariant, asserted where it could be violated. The pane holds no state
// of its own, so the only writer is the control the owner presses.
assert("the pane has no state and no effects",
  !/useState|useEffect/.test(pane),
  "state or an effect in here is a way for it to open itself");
assert("and takes no prop that would open it",
  !/\bopen\s*[?:]/.test(pane) && !/isOpen/.test(pane),
  "a prop like that is how 'show me my context' becomes 'J4 decided to interrupt me'");

// In the workspace, the open state has exactly one writer.
const setters = workspace.match(/setContextOpen\(/g) ?? [];
check("the open state is written from exactly two places — the toggle and the close",
  setters.length, 2);
assert("neither is an effect or a timer",
  !/useEffect\([^)]*setContextOpen|setTimeout\([^)]*setContextOpen/.test(workspace),
  "an effect that opened the pane would be J4 opening it");
assert("and no server response opens it",
  !/setContextOpen[\s\S]{0,80}(await|fetch|response)/.test(workspace),
  "the server must not be able to open the pane");
assert("the owner has a control that does",
  workspace.includes('data-role="open-context-pane"'), "owner-initiated needs an owner control");

// ==========================================================================
console.log("\n=== 5. Scoped to the conversation, and to the business ===\n");
// ==========================================================================
assert("the pane is told which conversation it is for",
  pane.includes("conversationLabel"), "scoped to the selected conversation");
assert("and names that conversation's anchored work when there is some",
  pane.includes("anchoredWork") && pane.includes("This conversation is about"),
  "the anchor is metadata the pane names");
// THE ANCHOR IS NOT A LINK. Naming work is understanding; offering to act on it
// is the boundary this piece must not cross.
assert("but the anchor is not actionable",
  !/<a\b|href=|onClick=\{[^}]*anchor/i.test(pane),
  "naming the work is understanding; acting on it is the other surface");

// BUSINESS SCOPING IS UNTOUCHED. The entries are built from the understanding
// the surface fetched for one business, so the pane has no business boundary of
// its own to get wrong — and no query through which to widen one.
const surface = read(["app", "j4", "J4Surface.tsx"]);
assert("the entries are built from this render's understanding",
  surface.includes("buildContextEntries(understanding)"),
  "a second fetch here would be a second answer to what J4 knows");
assert("which is the business-scoped one the surface already resolved",
  surface.includes("getBusinessUnderstanding(store.id"),
  "the pane inherits the business boundary rather than re-deriving it");
// CURRENT, NOT A SNAPSHOT. Nothing reconstructs what was known earlier.
assert("nothing reconstructs a historical understanding",
  !/asOf|snapshot|atTime|historical/i.test(registry + pane),
  "the pane shows what J4 knows now — the same rule conversations follow");

console.log(`\n${failures === 0 ? "All context-pane assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
