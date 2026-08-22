import { FIELD_LABELS } from "@/lib/execution/fieldLabels";
import { STATUS_DOT } from "@/lib/execution/statusDisplay";
import { GENESIS_ACTIONS } from "@/lib/execution/genesisActions";
import { HIDDEN_DIFF_KEYS } from "@/lib/execution/ActionDiff";

// WHAT AN OWNER READS ON AN APPROVAL CARD:
//
//   npx tsx scripts/verify-field-labels.ts
//
// Every proposal an owner decides on is rendered by one generic Current ->
// Proposed diff (lib/execution/ActionDiff.tsx), driven by field key rather than
// per-action JSX. The label for each row comes from FIELD_LABELS, and the
// lookup is:
//
//     FIELD_LABELS[key] ?? key
//
// So a field with no label does not fail, does not warn, and does not look
// broken to anyone reading the code. It shows the owner `seoMetaDescription`
// where it should say "Meta Description", on the screen where they are being
// asked to approve a change to their own business. ActionDiff's own comment
// promises the opposite — a new action "renders correctly the moment it's added
// to GENESIS_ACTIONS/FIELD_LABELS" — and nothing checked the second half.
//
// SECTION 1 IS THAT CHECK, derived from the input schemas rather than from a
// list: every field any registered action can actually propose must have a
// human name. See ARCHITECTURE.md, "Standing invariant: the mirrored registry".
//
// STATUS_DOT is the other half of the same card. It is Record<ExecutionStatus,
// string>, so the compiler already guarantees every status has A colour; what it
// cannot check is that the colours are distinct, that they mean what a person
// expects, or that none of them is J4's blue.

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
 * Every field key an action's input can carry, read from its own zod schema.
 *
 * Walks one level into a discriminated union's members, because that is exactly
 * how the real schemas are shaped — and a union's branches are still fields the
 * diff renderer will be handed.
 */
function fieldKeysOf(schema: unknown): string[] {
  const s = schema as { shape?: Record<string, unknown>; options?: unknown[]; def?: { shape?: Record<string, unknown> } };
  if (s?.shape) return Object.keys(s.shape);
  if (s?.def?.shape) return Object.keys(s.def.shape);
  if (Array.isArray(s?.options)) return s.options.flatMap((o) => fieldKeysOf(o));
  return [];
}

// ============================================================================
console.log("\n=== 1. Every field an owner can be asked about has a human name ===\n");
// ============================================================================
const byAction = Object.entries(GENESIS_ACTIONS).map(([action, def]) => ({
  action,
  fields: fieldKeysOf((def as { inputSchema: unknown }).inputSchema),
}));

const withFields = byAction.filter((a) => a.fields.length > 0);
assert("the input schemas yield real field keys", withFields.length > 0,
  `${withFields.length} of ${byAction.length} actions`);

// What the renderer itself hides, imported rather than restated — a second
// opinion about which fields are plumbing is how the two drift apart.
//
// The union discriminators are added on top: they are not fields the owner is
// shown but which KIND of answer this is, and the card renders that itself.
const NOT_SHOWN = new Set([...HIDDEN_DIFF_KEYS, "actionType", "kind", "outcome"]);

// communicate_finding is excluded on its own registry's stated grounds: "never
// actually surfaced through this map in practice (no ApprovalRequest is created
// for a communicated finding), present only for completeness/type-safety
// alongside every other entry." Its fields therefore never reach a diff row.
// Named here rather than skipped silently — an exception nobody wrote down is
// indistinguishable from drift.
const NEVER_A_PROPOSAL = new Set(["communicate_finding"]);

const unlabelled = withFields
  .filter(({ action }) => !NEVER_A_PROPOSAL.has(action))
  .flatMap(({ action, fields }) =>
    fields
      .filter((f) => !NOT_SHOWN.has(f))
      .filter((f) => !FIELD_LABELS[f])
      .map((f) => `${action}.${f}`)
  );
check("no field renders as its own raw key", [...new Set(unlabelled)], []);
assert(
  "so an approval card never shows an owner the machine's word for their own business",
  unlabelled.length === 0,
  "the lookup is FIELD_LABELS[key] ?? key — an unlabelled field fails silently and visibly at once"
);

// ============================================================================
console.log("\n=== 2. The labels are names, not identifiers ===\n");
// ============================================================================
const entries = Object.entries(FIELD_LABELS);
assert("there are real labels", entries.length > 0);
check("none is empty", entries.filter(([, l]) => !l.trim()), []);
check("none is just its own key", entries.filter(([k, l]) => l === k), []);
check("none is camelCase left over",
  entries.filter(([, l]) => /^[a-z]+[A-Z]/.test(l)), []);
check("none is snake_case", entries.filter(([, l]) => l.includes("_")), []);
check("every label starts as a name does",
  entries.filter(([, l]) => l[0] !== l[0].toUpperCase()), []);

// Two fields sharing a label would put two different rows under one name on the
// same card, which is worse than a raw key: the owner cannot tell them apart.
const duplicates = Object.entries(
  entries.reduce<Record<string, string[]>>((acc, [key, label]) => {
    (acc[label] ??= []).push(key);
    return acc;
  }, {})
).filter(([, keys]) => keys.length > 1);
check("no two fields share a label", duplicates, []);

// ============================================================================
console.log("\n=== 3. A status colour means what a person expects ===\n");
// ============================================================================
const statuses = Object.entries(STATUS_DOT);
check("every status has a distinct colour",
  new Set(statuses.map(([, c]) => c)).size, statuses.length);

assert("success is green", STATUS_DOT.SUCCESS.includes("green"), STATUS_DOT.SUCCESS);
assert("failure is red", STATUS_DOT.FAILED.includes("red"), STATUS_DOT.FAILED);
assert("a warning is neither",
  !STATUS_DOT.WARNING.includes("green") && !STATUS_DOT.WARNING.includes("red"),
  STATUS_DOT.WARNING);
assert("and pending is quiet rather than coloured",
  STATUS_DOT.PENDING.includes("zinc") || STATUS_DOT.PENDING.includes("gray") || STATUS_DOT.PENDING.includes("neutral"),
  "nothing has happened yet, so nothing should be shouting");

// THE STANDING CONSTRAINT, and the one most likely to be broken by somebody
// making a status feel more important. Blue marks J4 and nothing else — a
// status dot that borrowed it would steal the one signal the owner has learned
// to read, on the very card where J4 is asking for a decision.
const blue = statuses.filter(
  ([, c]) => /\b(blue|indigo|violet|purple)\b/.test(c) || c.includes("8b7cf6") || c.includes("2563eb")
);
check("no status wears J4's blue", blue, []);

console.log(`\n${failures === 0 ? "All field-label assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
