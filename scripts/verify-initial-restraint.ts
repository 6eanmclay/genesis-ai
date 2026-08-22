import {
  applyInitialDesignRestraint,
  INITIAL_DESIGN_BUDGET,
} from "@/lib/onboarding/initialDesignRestraint";
import { DEFAULT_THEME, type Presentation, type Composition } from "@/lib/theme";
import { REFINABLE_DIMENSIONS, type RefinableDimensionKey } from "@/lib/storefront/dimensions";

// HOW MUCH OF ITSELF A FIRST STOREFRONT IS ALLOWED TO SPEND:
//
//   npx tsx scripts/verify-initial-restraint.ts
//
// Sean's framing: "Don't make the first storefront boring or ugly. Make it
// competent, clean, professional, and appropriate to the business — but
// deliberately conservative. Don't spend every available design decision
// immediately." The owner should look at their first site and think "yeah,
// that's a legitimate website," not "J4 redesigned the entire internet."
//
// THE REASON THIS IS CODE AND NOT PROMPT TEXT is stated in the file, and it is
// the reason it deserves a suite rather than a reading: "a model asked for
// restraint is restrained ON AVERAGE. A budget that is actually enforced is
// restrained EVERY TIME." A budget nothing checks is prompt text with extra
// steps.
//
// SECTION 4 IS THE DRIFT ONE, and it is the failure that would be invisible.
// DEPARTURE_PRIORITY is a hand-maintained list of the ten dials, and the
// comparison it drives is `proposed[key] !== baseline[key]`. A dial that exists
// in Presentation or Composition but is MISSING from that list is never counted
// as a departure at all — so it is never reverted, never charged against the
// budget, and a first storefront can move it freely no matter how many other
// choices it has already spent. The budget would still report four while five
// dials moved. See ARCHITECTURE.md, "Standing invariant: the mirrored registry".

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

const BASE_PRESENTATION = DEFAULT_THEME.presentation!;
const BASE_COMPOSITION = DEFAULT_THEME.composition!;

/** A value for this dial that is NOT the baseline, taken from the real vocabulary. */
function otherValue(key: string, baseline: unknown): string | null {
  const dimension = REFINABLE_DIMENSIONS[key as RefinableDimensionKey];
  if (!dimension) return null;
  return (dimension.values as readonly string[]).find((v) => v !== baseline) ?? null;
}

/** Everything the model could possibly have moved, all at once. */
function maximallyAdventurous(): { presentation: Presentation; composition: Composition; moved: string[] } {
  const presentation = { ...BASE_PRESENTATION } as Record<string, unknown>;
  const composition = { ...BASE_COMPOSITION } as Record<string, unknown>;
  const moved: string[] = [];
  for (const [key, baseline] of Object.entries(BASE_PRESENTATION)) {
    const other = otherValue(key, baseline);
    if (other) {
      presentation[key] = other;
      moved.push(key);
    }
  }
  for (const [key, baseline] of Object.entries(BASE_COMPOSITION)) {
    const other = otherValue(key, baseline);
    if (other) {
      composition[key] = other;
      moved.push(key);
    }
  }
  return {
    presentation: presentation as Presentation,
    composition: composition as Composition,
    moved,
  };
}

// ============================================================================
console.log("\n=== 1. The budget is spent, not exceeded ===\n");
// ============================================================================
check("four choices, not ten", INITIAL_DESIGN_BUDGET, 4);

const everything = maximallyAdventurous();
assert("the fixture really did move more than the budget allows",
  everything.moved.length > INITIAL_DESIGN_BUDGET,
  `${everything.moved.length} dials moved`);

const restrained = applyInitialDesignRestraint(everything);
check("only the budget survives", restrained.kept.length, INITIAL_DESIGN_BUDGET);
assert("and the rest are pulled back",
  restrained.reverted.length === everything.moved.length - INITIAL_DESIGN_BUDGET,
  `kept ${restrained.kept.length}, reverted ${restrained.reverted.length}, moved ${everything.moved.length}`);

// The count the function REPORTS must match what it actually did. A budget that
// says four while five dials sit off baseline is worse than no budget.
const stillOffBaseline = [
  ...Object.keys(BASE_PRESENTATION).filter(
    (k) => (restrained.presentation as Record<string, unknown>)[k] !== (BASE_PRESENTATION as Record<string, unknown>)[k]
  ),
  ...Object.keys(BASE_COMPOSITION).filter(
    (k) => (restrained.composition as Record<string, unknown>)[k] !== (BASE_COMPOSITION as Record<string, unknown>)[k]
  ),
];
check("and the finished theme really is only that far from baseline",
  stillOffBaseline.length, INITIAL_DESIGN_BUDGET);
assert("so what it reports is what it did",
  stillOffBaseline.length === restrained.kept.length,
  `${JSON.stringify(stillOffBaseline)} vs ${JSON.stringify(restrained.kept)}`);

// ============================================================================
console.log("\n=== 2. It gives back the loud dials first ===\n");
// ============================================================================
// "Ordered by identity carried per unit of loudness." A first storefront that
// differs from baseline only in its hero and its typography still looks
// deliberate; one that differs only in bold shadows looks like a theme demo.
assert("the hero layout survives a maximal proposal",
  restrained.kept.includes("heroLayout" as never), JSON.stringify(restrained.kept));
assert("and the type scale", restrained.kept.includes("typeScale" as never), JSON.stringify(restrained.kept));
assert("while the shadow style is given back",
  restrained.reverted.includes("shadowStyle" as never), JSON.stringify(restrained.reverted));
assert("and so is CTA emphasis",
  restrained.reverted.includes("ctaEmphasis" as never), JSON.stringify(restrained.reverted));
assert(
  "so the storefront reads as deliberate rather than as a theme demo",
  !restrained.kept.includes("shadowStyle" as never),
  "shadows and CTA emphasis are the dials that make a page feel like it is trying too hard"
);

// ============================================================================
console.log("\n=== 3. A restrained value is the baseline, never an invention ===\n");
// ============================================================================
// "Every value the model chose is already schema-valid, so this never invents a
// variant — it only decides which of its choices to keep."
for (const key of restrained.reverted) {
  const inPresentation = key in BASE_PRESENTATION;
  const actual = inPresentation
    ? (restrained.presentation as Record<string, unknown>)[key]
    : (restrained.composition as Record<string, unknown>)[key];
  const baseline = inPresentation
    ? (BASE_PRESENTATION as Record<string, unknown>)[key]
    : (BASE_COMPOSITION as Record<string, unknown>)[key];
  check(`${key} is pulled back to exactly the baseline`, actual, baseline);
}

// A proposal already within budget is left completely alone.
const modest = {
  presentation: { ...BASE_PRESENTATION, heroLayout: undefined } as unknown as Presentation,
  composition: { ...BASE_COMPOSITION },
};
const untouched = applyInitialDesignRestraint({
  presentation: { ...BASE_PRESENTATION },
  composition: { ...BASE_COMPOSITION },
});
void modest;
check("a proposal that changed nothing keeps nothing", untouched.kept, []);
check("and reverts nothing", untouched.reverted, []);
check("leaving the baseline exactly as it was", untouched.presentation, BASE_PRESENTATION);
check("on both halves", untouched.composition, BASE_COMPOSITION);

// One departure is one departure — the budget is a ceiling, not a quota.
const oneDial = Object.keys(BASE_COMPOSITION).find((k) => otherValue(k, (BASE_COMPOSITION as Record<string, unknown>)[k]));
assert("there is a composition dial to move", Boolean(oneDial), String(oneDial));
const single = applyInitialDesignRestraint({
  presentation: { ...BASE_PRESENTATION },
  composition: {
    ...BASE_COMPOSITION,
    [oneDial!]: otherValue(oneDial!, (BASE_COMPOSITION as Record<string, unknown>)[oneDial!]),
  } as Composition,
});
check("one change stays one change", single.kept.length, 1);
check("with nothing reverted", single.reverted, []);

// ============================================================================
console.log("\n=== 4. Every dial is inside the budget ===\n");
// ============================================================================
// THE DRIFT CHECK. A dial missing from DEPARTURE_PRIORITY is never counted as a
// departure, never reverted, and never charged — so it moves freely however
// much has already been spent, while the budget still reports four.
//
// Proved by behaviour rather than by reading the list: move every dial, then
// ask which ones the function actually accounted for.
const accountedFor = new Set<string>([...restrained.kept, ...restrained.reverted]);
const unbudgeted = everything.moved.filter((key) => !accountedFor.has(key));
check("no dial escapes the budget", unbudgeted, []);
assert(
  "so a new Theme dial cannot be spent for free",
  unbudgeted.length === 0,
  "a dial absent from DEPARTURE_PRIORITY compares undefined to undefined and is silently never a departure"
);

// And nothing in the priority list is a dial that no longer exists — the other
// direction of the same mirror.
const phantom = [...accountedFor].filter(
  (key) => !(key in BASE_PRESENTATION) && !(key in BASE_COMPOSITION)
);
check("and no budgeted dial has been removed from the theme", phantom, []);

console.log(`\n${failures === 0 ? "All initial-restraint assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
