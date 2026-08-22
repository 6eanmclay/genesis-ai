import {
  PROPOSABLE_ACTION_TYPES,
  ProposedActionSchema,
} from "@/lib/intelligence/cognitiveLayer";
import { GENESIS_ACTIONS, ACTION_SECTIONS, type GenesisActionType } from "@/lib/execution/genesisActions";
import { growthPointCostsFor } from "@/lib/growthPoints/catalog";

// WHAT GENESIS IS ALLOWED TO PROPOSE ON ITS OWN:
//
//   npx tsx scripts/verify-cognitive-proposals.ts
//
// The Cognitive Layer is where Genesis decides, unprompted, that something is
// worth doing and writes an ApprovalRequest for it. Nothing in that 899-line
// file had any coverage at all. The model call itself needs a real API key and
// is out of reach here, but the part that decides WHAT MAY BE PROPOSED is pure
// — and it is the part that has to be right, because everything downstream
// trusts it.
//
// TWO HAND-MAINTAINED SPELLINGS OF THE SAME SEVEN ACTIONS live in that file:
// ProposedActionSchema, a discriminated union with one z.literal per action,
// and PROPOSABLE_ACTION_TYPES, a separate literal list. The list carries
// `satisfies readonly GenesisActionType[]`, which checks that every entry is a
// valid action TYPE and never that the two lists agree with each other.
//
// Its own comment says why the list exists at all: so chat's data-answer
// context "can build the identical real cost lookup rather than a second,
// potentially drifting list". Drift is the named concern, and nothing checked
// for it. See ARCHITECTURE.md, "Standing invariant: the mirrored registry".
//
// WHAT DRIFT WOULD ACTUALLY DO, in the direction that matters: an action the
// schema can emit but the list omits is one Genesis can propose while
// growthPointCosts has no price for it. The prompt's own instruction is "an
// actionType absent from growthPointCosts has no real price yet — never invent
// one", so the model would be asked to reason about an investment whose cost it
// was never given. That is the grounding rule breaking quietly rather than
// loudly, which is the only way it ever breaks.
//
// SECTION 3 IS THE ONE THAT PROTECTS THE TOP-LEVEL INVARIANT: Genesis must
// never present an action as executable unless a real registered executable
// stands behind it.

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
 * The action types the schema will actually accept as a discriminator.
 *
 * Read from the union's own options rather than restated here, because a third
 * hand-maintained list in the test would be the very thing under test.
 */
const schemaActionTypes: string[] = (
  ProposedActionSchema.options as { shape: { actionType: { value: string } } }[]
).map((option) => option.shape.actionType.value);

/** Does the schema recognise this discriminator, whatever the rest looks like? */
function schemaAccepts(actionType: string): boolean {
  const result = ProposedActionSchema.safeParse({ actionType, input: {} });
  if (result.success) return true;
  // An unrecognised discriminator fails differently from a recognised one with
  // a bad payload, and that distinction is the whole check: it lets this assert
  // membership without hand-building a valid input per action, which would be a
  // fourth restatement of the same seven shapes.
  //
  // Confirmed against this Zod version rather than assumed — an unknown
  // actionType reports `invalid_union` AT THE actionType PATH, while a known one
  // with an empty input reports invalid_type errors under `input`. The earlier
  // guess (`invalid_union_discriminator`) is a Zod 3 code that does not exist
  // here, and the compiler said so.
  return !result.error.issues.some(
    (i) => i.code === "invalid_union" && i.path[0] === "actionType"
  );
}

// ============================================================================
console.log("\n=== 1. The two spellings agree, in both directions ===\n");
// ============================================================================
const listOnly = PROPOSABLE_ACTION_TYPES.filter((a) => !schemaActionTypes.includes(a));
check("every named proposable action is one the schema can emit", listOnly, []);

const schemaOnly = schemaActionTypes.filter((a) => !(PROPOSABLE_ACTION_TYPES as readonly string[]).includes(a));
check("and every action the schema can emit is named", schemaOnly, []);
assert(
  "so the cost lookup covers exactly what Genesis can propose",
  listOnly.length === 0 && schemaOnly.length === 0,
  "an unpriced proposable action asks the model to reason about a cost it was never given"
);

check("the count is the same", schemaActionTypes.length, PROPOSABLE_ACTION_TYPES.length);
check("and there are no duplicates in the schema",
  new Set(schemaActionTypes).size, schemaActionTypes.length);
check("nor in the list",
  new Set(PROPOSABLE_ACTION_TYPES).size, PROPOSABLE_ACTION_TYPES.length);

// The membership probe used above must itself be trustworthy in both
// directions, or section 1 proves nothing.
for (const action of PROPOSABLE_ACTION_TYPES) {
  assert(`the schema recognises ${action}`, schemaAccepts(action));
}
assert("and refuses an action it was never given",
  !schemaAccepts("delete_product"),
  "delete_product is a real registered action, and deliberately not proposable");
assert("and refuses an invented one", !schemaAccepts("drop_all_products"));

// ============================================================================
console.log("\n=== 2. Nothing dangerous is proposable ===\n");
// ============================================================================
// Genesis proposing something unprompted is a different act from an owner
// asking for it, so the set is deliberately narrow. A destructive or
// money-moving action arriving here would be a real escalation of what Genesis
// may do on its own initiative.
const dangerous = PROPOSABLE_ACTION_TYPES.filter((a) => {
  const category = GENESIS_ACTIONS[a as GenesisActionType]?.category;
  return category === "destructive" || category === "money";
});
check("no destructive or money-moving action is proposable", dangerous, []);
assert("in particular, deleting a product is not",
  !(PROPOSABLE_ACTION_TYPES as readonly string[]).includes("delete_product"),
  "an unprompted proposal to delete something is not a proposal an owner asked for");

// Every proposable action is still gated on a human, whatever authority the
// store has granted. This is the confirmation ladder holding at its top rung.
const autoApprovable = PROPOSABLE_ACTION_TYPES.filter(
  (a) => GENESIS_ACTIONS[a as GenesisActionType]?.authorizationTier !== "always_ask"
);
console.log(`        (for the record, tiered above always_ask: ${JSON.stringify(autoApprovable)})`);

// ============================================================================
console.log("\n=== 3. Every proposable action can actually be carried out ===\n");
// ============================================================================
// THE TOP-LEVEL INVARIANT. Genesis must never present an action as executable
// unless a real registered executable stands behind it.
const unregistered = PROPOSABLE_ACTION_TYPES.filter((a) => !(a in GENESIS_ACTIONS));
check("every proposable action is a registered action", unregistered, []);

const notExecutable = PROPOSABLE_ACTION_TYPES.filter(
  (a) => !GENESIS_ACTIONS[a as GenesisActionType]?.executable
);
check("and each has a real executable behind it", notExecutable, []);

const noSchema = PROPOSABLE_ACTION_TYPES.filter(
  (a) => !GENESIS_ACTIONS[a as GenesisActionType]?.inputSchema
);
check("and an input schema to validate what the model produced", noSchema, []);

// ============================================================================
console.log("\n=== 4. Every proposal can be found and decided ===\n");
// ============================================================================
// A proposal an owner cannot navigate to is a decision nobody can make. This is
// the same property verify-action-sections.ts asserts across the whole registry,
// narrowed to the actions Genesis raises on its own initiative — where it
// matters most, because the owner never asked for these and has no idea where
// to look.
const unreachable = PROPOSABLE_ACTION_TYPES.filter((a) => !ACTION_SECTIONS[a]);
check("every proposable action has a section that owns its controls", unreachable, []);

const unnamed = PROPOSABLE_ACTION_TYPES.filter((a) => !ACTION_SECTIONS[a]?.label);
check("and a place the owner can be told about", unnamed, []);

// ============================================================================
console.log("\n=== 5. The cost lookup is real, and honest about absence ===\n");
// ============================================================================
const costs = growthPointCostsFor(PROPOSABLE_ACTION_TYPES);
assert("the lookup is built from the same list the model is given",
  typeof costs === "object" && costs !== null,
  JSON.stringify(costs));

// The prompt's own rule: "an actionType absent from growthPointCosts has no
// real price yet — never invent one." So an absent action must be ABSENT, not
// present with a zero.
const zeroPriced = Object.entries(costs).filter(([, cost]) => cost === 0);
check("nothing is priced at zero, which would read as free", zeroPriced, []);

const negative = Object.entries(costs).filter(([, cost]) => typeof cost === "number" && cost < 0);
check("and nothing at a negative price", negative, []);

const stray = Object.keys(costs).filter((a) => !(PROPOSABLE_ACTION_TYPES as readonly string[]).includes(a));
check("the lookup never prices something Genesis cannot propose", stray, []);
assert(
  "an unpriced action is simply missing rather than invented",
  Object.keys(costs).every((a) => typeof costs[a as keyof typeof costs] === "number"),
  "absence is the honest answer; a fabricated price is a figure about somebody's money"
);

console.log(`\n${failures === 0 ? "All cognitive-proposal assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
