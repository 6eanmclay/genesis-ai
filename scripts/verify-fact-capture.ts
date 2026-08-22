import {
  GoalCaptureSchema,
  ChallengeCaptureSchema,
  EmployeeCaptureSchema,
  LocationCaptureSchema,
  BusinessFactSchema,
  toGoalRecordData,
  toChallengeRecordData,
} from "@/lib/businessModel/factCapture";
import { ENTITY_REGISTRY } from "@/lib/businessModel/entities";

// FACT CAPTURE — what a model may state, and what only code may decide:
//
//   npx tsx scripts/verify-fact-capture.ts
//
// When an owner says "I want to hit $10k a month", a model reads that sentence
// and Genesis writes a real goal into Business Understanding. This module is the
// contract for that hand-off, and it draws one line: a Capture schema covers
// "only what Claude can plausibly infer from real, given text", while
// status/identifiedAt and the reference arrays "are derived in code at each
// write site, never asked of the model".
//
// THE ADVERSARIAL PROPERTY. That line is enforced by ORDERING — the derived
// fields are assigned AFTER the capture is spread — and nothing pinned it. A
// reasonable-looking refactor to `{ status: "active", ...capture }` would let a
// model set the status of a goal it just invented, or backdate identifiedAt so a
// brand-new goal appears to have been tracked for months. Neither would throw,
// neither would fail a type check, and both would quietly become business facts.
//
// No database and no AI: this is a pure contract, and it is asserted as one.

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

const TODAY = "2026-08-21";

const goal = {
  description: "Reach $10k in monthly revenue",
  category: "revenue" as const,
  priority: "high" as const,
  targetDate: "2026-12-31",
  targetValueInCents: 1_000_000,
};

const challenge = {
  description: "Cash is tight between wholesale orders",
  category: "cash_flow" as const,
  severity: "high" as const,
};

// ============================================================================
console.log("\n=== 1. The derived fields are added, not asked for ===\n");
// ============================================================================
const goalRecord = toGoalRecordData(goal, TODAY);
check("a captured goal starts active", goalRecord.status, "active");
check("identified today", goalRecord.identifiedAt, TODAY);
check("with no challenge links yet", goalRecord.relatedChallengeIds, []);
check("and the owner's own words survive", goalRecord.description, goal.description);
check("along with the figure they actually stated", goalRecord.targetValueInCents, 1_000_000);

const challengeRecord = toChallengeRecordData(challenge, TODAY);
check("a captured challenge starts active", challengeRecord.status, "active");
check("identified today", challengeRecord.identifiedAt, TODAY);
check("unresolved", challengeRecord.resolvedAt, null);
check("with no goal links yet", challengeRecord.relatedGoalIds, []);

// ============================================================================
console.log("\n=== 2. A model cannot smuggle a derived field ===\n");
// ============================================================================
// The adversarial case. A model returning extra keys is not exotic — it is the
// ordinary failure mode of a generative system asked for structured output.
const smuggledGoal = {
  ...goal,
  status: "achieved",
  identifiedAt: "2020-01-01",
  relatedChallengeIds: ["injected-id"],
} as never;

const fromSmuggled = toGoalRecordData(smuggledGoal, TODAY);
check("a claimed status is overwritten, not honoured", fromSmuggled.status, "active");
assert(
  "so a model cannot mark a goal achieved the moment it invents it",
  fromSmuggled.status === "active",
  "a goal that arrives already achieved is a fact nobody stated"
);
check("a backdated identifiedAt is overwritten", fromSmuggled.identifiedAt, TODAY);
assert(
  "so a brand-new goal cannot appear to have been tracked for years",
  fromSmuggled.identifiedAt === TODAY,
  "age is what makes a goal look neglected or long-standing"
);
check("injected relationships are discarded", fromSmuggled.relatedChallengeIds, []);

const smuggledChallenge = {
  ...challenge,
  status: "resolved",
  resolvedAt: "2020-01-01",
  identifiedAt: "2019-01-01",
  relatedGoalIds: ["injected-id"],
} as never;
const fromSmuggledChallenge = toChallengeRecordData(smuggledChallenge, TODAY);
check("a challenge cannot arrive pre-resolved", fromSmuggledChallenge.status, "active");
check("nor carry a resolution date", fromSmuggledChallenge.resolvedAt, null);
check("nor a backdated identification", fromSmuggledChallenge.identifiedAt, TODAY);
check("nor injected links", fromSmuggledChallenge.relatedGoalIds, []);

// ============================================================================
console.log("\n=== 3. The parse strips what the schema never asked for ===\n");
// ============================================================================
// The other half of the defence: where a capture IS parsed rather than cast,
// unknown keys are dropped before they can reach the spread at all.
const parsedGoal = GoalCaptureSchema.parse(smuggledGoal);
assert("status is not part of a goal capture", !("status" in parsedGoal));
assert("nor identifiedAt", !("identifiedAt" in parsedGoal));
assert("nor the reference array", !("relatedChallengeIds" in parsedGoal));
check("while the real fields survive", parsedGoal.description, goal.description);

const parsedChallenge = ChallengeCaptureSchema.parse(smuggledChallenge);
assert("a challenge capture carries no status either", !("status" in parsedChallenge));
assert("nor a resolvedAt", !("resolvedAt" in parsedChallenge));

// ============================================================================
console.log("\n=== 4. What a capture refuses outright ===\n");
// ============================================================================
// A description is the one thing that cannot be inferred or defaulted — without
// it there is no fact.
assert("a goal with no description is refused",
  !GoalCaptureSchema.safeParse({ ...goal, description: undefined }).success);
assert("a challenge with no description is refused",
  !ChallengeCaptureSchema.safeParse({ ...challenge, description: undefined }).success);

// A category outside the vocabulary is refused rather than silently stored, so
// the enum stays a real vocabulary rather than a suggestion.
assert("an invented goal category is refused",
  !GoalCaptureSchema.safeParse({ ...goal, category: "world_domination" }).success);
assert("an invented challenge severity is refused",
  !ChallengeCaptureSchema.safeParse({ ...challenge, severity: "catastrophic" }).success);

// Null is a real answer for everything the owner may simply not have said.
const vague = GoalCaptureSchema.parse({
  description: "Grow the business",
  category: null, priority: null, targetDate: null, targetValueInCents: null,
});
check("a goal with no stated number keeps a null, never a guess", vague.targetValueInCents, null);
check("and no stated date", vague.targetDate, null);
assert("a target figure must be a whole number of cents",
  !GoalCaptureSchema.safeParse({ ...goal, targetValueInCents: 100.5 }).success,
  "a fraction of a cent is not a figure anybody stated");

// ============================================================================
console.log("\n=== 5. 'Nothing was said' is a real outcome ===\n");
// ============================================================================
// The union's own escape hatch: a turn that states no business fact is not an
// error and must not become an empty record.
const nothing = BusinessFactSchema.parse({ entityType: "none", data: null, confirmationReply: null });
check("a turn with no fact in it parses", nothing.entityType, "none");
check("carrying no data", nothing.data, null);
assert("and a 'none' that smuggles data is refused",
  !BusinessFactSchema.safeParse({ entityType: "none", data: goal, confirmationReply: "x" }).success,
  "otherwise 'nothing was said' could still write something");

assert("a real fact needs a confirmation the owner will see",
  !BusinessFactSchema.safeParse({ entityType: "goal", data: goal, confirmationReply: null }).success,
  "a fact recorded silently is a fact the owner never agreed to");
assert("an unknown entity type is refused",
  !BusinessFactSchema.safeParse({ entityType: "invoice", data: goal, confirmationReply: "x" }).success);

// ============================================================================
console.log("\n=== 6. What comes out is what the registry accepts ===\n");
// ============================================================================
// The integration property that makes the rest matter: the derived record is
// not merely well-shaped, it satisfies the same schema every write goes
// through. If these ever drifted apart, capture would fail at the database.
const goalParse = ENTITY_REGISTRY.goal.schema.safeParse(goalRecord);
assert("a derived goal satisfies the registry's own goal schema", goalParse.success,
  goalParse.success ? "" : JSON.stringify(goalParse.error.issues.slice(0, 2)));

const challengeParse = ENTITY_REGISTRY.challenge.schema.safeParse(challengeRecord);
assert("a derived challenge satisfies the registry's own challenge schema", challengeParse.success,
  challengeParse.success ? "" : JSON.stringify(challengeParse.error.issues.slice(0, 2)));

// The two capture shapes the asset classifier reuses, so a document-extracted
// employee or location writes the same records chat does.
const employee = EmployeeCaptureSchema.parse({
  name: "Priya", title: "Workshop lead", roles: ["operations"], email: null, startedAt: null,
});
const employeeParse = ENTITY_REGISTRY.employee.schema.safeParse({
  ...employee, status: "active", locationId: null,
});
assert("an employee capture plus its derived fields satisfies the registry", employeeParse.success);

const location = LocationCaptureSchema.parse({
  name: "Hartlepool workshop", type: "warehouse",
  address: null, city: null, state: null, postalCode: null, country: null,
});
check("a location capture keeps what was actually said", location.name, "Hartlepool workshop");
check("within the real vocabulary", location.type, "warehouse");
assert("an invented location type is refused",
  !LocationCaptureSchema.safeParse({ name: "x", type: "spaceship", address: null, city: null, state: null, postalCode: null, country: null }).success);
// ============================================================================
console.log("\n=== An entityType the registry does not know is a miss, not a crash ===\n");
// ============================================================================
// Both capture call sites (app/api/chat/route.ts and ai-actions.ts) read
// entityType off a CAST rather than a parse — `chosenTool.input as
// BusinessFactCaptureInput` — so it is whatever the model emitted. A bare
// ENTITY_REGISTRY[entityType].schema then throws TypeError on anything outside
// the enum, taking the whole chat turn down rather than dropping one bad
// extraction.
//
// persistSyncedRecords already treats an unknown entityType as a skippable
// error ("Unknown entity type"), and this asserts the shape both call sites now
// use to reach the same outcome at the earlier boundary.
const lookup = (entityType: string) =>
  Object.prototype.hasOwnProperty.call(ENTITY_REGISTRY, entityType)
    ? ENTITY_REGISTRY[entityType as keyof typeof ENTITY_REGISTRY]
    : null;

for (const known of Object.keys(ENTITY_REGISTRY)) {
  assert(`"${known}" resolves to a real schema`, lookup(known)?.schema !== undefined);
}
check("an invented entity type resolves to nothing", lookup("spaceship"), null);
check("and so does an empty one", lookup(""), null);
// The inherited-property case, which is the one that would actually throw: a
// bare lookup returns a FUNCTION here, and reading .schema off it is undefined,
// so .safeParse is a TypeError rather than a refusal.
for (const key of ["constructor", "toString", "__proto__", "valueOf"]) {
  check(`"${key}" is not an entity type`, lookup(key), null);
}
assert(
  "so a model naming something outside the vocabulary loses one capture, never the turn",
  ["constructor", "spaceship", ""].every((k) => lookup(k) === null),
  "the bare form threw TypeError; persistSyncedRecords had always handled this correctly one layer down"
);


console.log(`\n${failures === 0 ? "All fact-capture assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
