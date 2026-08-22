import { ACTION_SECTIONS, GENESIS_ACTIONS } from "@/lib/execution/genesisActions";
import {
  NAV_SECTIONS,
  COMMERCE_SECTIONS,
  STOREFRONT_SECTIONS,
  ROOM_SECTIONS,
  isSentinelHref,
  businessBasePath,
  sectionHref,
} from "@/lib/dashboard/navConfig";
import { resolveWorkspaceContext } from "@/lib/j4/workspaceContext";

// WHERE J4 SAYS A CHANGE LANDED, AND WHETHER THE OWNER CAN GO THERE:
//
//   npx tsx scripts/verify-action-sections.ts
//
// ACTION_SECTIONS answers one question — which dashboard section owns the
// Approve/Reject/Regenerate controls for an action — and three different things
// depend on the answer:
//
//   key    a nav section's badge count (BusinessWorkspace), so a pending
//          decision shows up on the nav item where it can actually be decided.
//   href   the deep link an owner follows from an attention card, from the
//          Office's Decisions view, and from a focused approval.
//   label  the one owner-facing sentence in lib/execution/engine.ts:
//          "J4 prepared your {label} update, but publishing it needs N more
//          Growth Points than you currently have."
//
// IT IS A HAND-MAINTAINED MIRROR OF navConfig.ts, and it had drifted. Four
// entries said "Website", a word that left the room bar on 2026-08-15 when the
// section became Storefront — so J4 named a place the owner could not see, in
// the one sentence of its own that ever reaches them. Nothing caught it,
// because nothing here was ever checked against navConfig at all.
//
// Decision 5 of the locked room architecture, in Sean's words: "Every action
// section must resolve to a real room, and J4 must never describe a change in
// terms of a place the owner cannot actually see." That is what section 2 below
// asserts, and it is the point of the file. See ARCHITECTURE.md, "Standing
// invariant: the mirrored registry" — this is the fourth instance of that
// pattern and the first one to be caught having actually drifted.

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

/** Every destination the shell can render, rooms and sections alike. */
const DESTINATIONS = [
  ...NAV_SECTIONS,
  ...STOREFRONT_SECTIONS,
  ...COMMERCE_SECTIONS,
  ...ROOM_SECTIONS.flat(),
];
const labelByKey = new Map(DESTINATIONS.map((s) => [s.key, s.label]));
const hrefByKey = new Map(DESTINATIONS.map((s) => [s.key, s.href]));

// The arrival screen. It is a real place with real controls on it
// (RecommendationsPanel), and it is deliberately NOT in the room bar — "the
// owner arrives there, they do not navigate back to it". So it has no nav entry
// to mirror, and the three actions that land there are named here rather than
// silently skipped: an exception nobody wrote down is indistinguishable from
// drift, which is the exact failure this file exists to catch.
const ARRIVAL_KEY = "home";
const ARRIVAL_ACTIONS = ["update_goal_status", "resolve_challenge", "communicate_finding"];

const entries = Object.entries(ACTION_SECTIONS);

// ============================================================================
console.log("\n=== 1. Every action Genesis can execute has somewhere to be decided ===\n");
// ============================================================================
const missing = Object.keys(GENESIS_ACTIONS).filter((a) => !(a in ACTION_SECTIONS));
check("no registered action is missing a section", missing, []);

const orphaned = entries.map(([a]) => a).filter((a) => !(a in GENESIS_ACTIONS));
check("and no section points at an action that no longer exists", orphaned, []);
assert("so the two registries are the same set",
  missing.length === 0 && orphaned.length === 0,
  "a hand-maintained mirror, checked rather than trusted");

// ============================================================================
console.log("\n=== 2. J4 never names a place the owner cannot see ===\n");
// ============================================================================
// THE DECISION 5 ASSERTION. A label is only allowed to be a word that appears
// on the owner's own screen — which means the nav's word for that same key,
// character for character.
const wrongLabel = entries
  .filter(([, s]) => s.key !== ARRIVAL_KEY)
  .filter(([, s]) => labelByKey.get(s.key) !== s.label)
  .map(([action, s]) => `${action}: says "${s.label}", nav says "${labelByKey.get(s.key) ?? "(no such section)"}"`);
check("every label is the nav's own word for that section", wrongLabel, []);

// The specific drift this file was written for, pinned so it cannot come back.
check("the storefront is called Storefront", ACTION_SECTIONS.update_hero.label, "Storefront");
check("and so is a theme change", ACTION_SECTIONS.update_theme.label, "Storefront");
assert("nothing still says Website",
  entries.every(([, s]) => s.label !== "Website"),
  "the room bar stopped saying it on 2026-08-15");

// The label is lowercased into a sentence, so it has to survive that.
for (const [action, s] of entries) {
  const sentence = `J4 prepared your ${s.label.toLowerCase()} update`;
  assert(`"${sentence}" reads as English (${action})`,
    s.label.length > 0 && !s.label.endsWith(".") && s.label === s.label.trim(),
    JSON.stringify(s.label));
}

// ============================================================================
console.log("\n=== 3. Every section is a real place, and the right one ===\n");
// ============================================================================
const unknownKey = entries
  .filter(([, s]) => s.key !== ARRIVAL_KEY)
  .filter(([, s]) => !labelByKey.has(s.key))
  .map(([action, s]) => `${action} -> ${s.key}`);
check("every key is a real nav section", unknownKey, []);
assert("which is what makes the badge land on a nav item that exists",
  unknownKey.length === 0,
  "an unknown key counts a pending decision into nothing");

const wrongHref = entries
  .filter(([, s]) => s.key !== ARRIVAL_KEY)
  .filter(([, s]) => hrefByKey.get(s.key) !== s.href)
  .map(([action, s]) => `${action}: ${s.href}, nav says ${hrefByKey.get(s.key) ?? "(none)"}`);
check("and every href is that section's own route", wrongHref, []);

// A sentinel is a button that opens a sheet, not a route. Deep-linking one
// would send an owner to a dead URL.
const sentinels = entries.filter(([, s]) => isSentinelHref(s.href)).map(([a]) => a);
check("no action deep-links to a sentinel", sentinels, []);

// ============================================================================
console.log("\n=== 4. The arrival screen, named rather than skipped ===\n");
// ============================================================================
const arrivalEntries = entries.filter(([, s]) => s.key === ARRIVAL_KEY).map(([a]) => a).sort();
check("exactly the three actions with no page of their own land on arrival",
  arrivalEntries, [...ARRIVAL_ACTIONS].sort());
assert("and they point at the business root, which is what arrival is",
  entries.filter(([, s]) => s.key === ARRIVAL_KEY).every(([, s]) => s.href === "/dashboard"),
  "no dedicated Goals/Challenges page exists; inventing an href would invent a page");
assert(
  "the Office is NOT used as their section, because it has no route",
  entries.every(([, s]) => s.href !== "/office" && s.key !== "office"),
  "the Office is an overlay over a room — deep-linking it would produce a dead link"
);

// ============================================================================
console.log("\n=== 5. J4 knows the place it is sending the owner to ===\n");
// ============================================================================
// Closes the loop with decision 4: an href J4 can name but not recognise on
// arrival would mean the owner lands somewhere J4 has nothing to say about.
const unrecognised = entries
  .filter(([, s]) => resolveWorkspaceContext(s.href) === null)
  .map(([action, s]) => `${action} -> ${s.href}`);
check("every destination resolves to a workspace J4 understands", [...new Set(unrecognised)], []);

const unrecognisedInBusiness = entries
  .filter(([, s]) => resolveWorkspaceContext(sectionHref(s.href, businessBasePath("iron-gym"))) === null)
  .map(([action, s]) => `${action} -> ${s.href}`);
check("including when the business is in the URL", [...new Set(unrecognisedInBusiness)], []);

console.log(`\n${failures === 0 ? "All action-section assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
