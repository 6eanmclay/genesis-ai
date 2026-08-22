import { buildArrivalBeats, type ArrivalMode } from "@/lib/dashboard/genesisArrivalCopy";

// THE FIRST FOUR SENTENCES OF THE DAY:
//
//   npx tsx scripts/verify-arrival-copy.ts
//
// buildArrivalBeats is what Genesis says while the owner arrives, and it had no
// coverage. Every line in it is spoken in Genesis's own voice before the owner
// has done anything, which makes it the earliest possible place to say
// something untrue.
//
// THE ASSERTION THAT MATTERS is the closing beat. hasRealBriefing exists so it
// stays honest "instead of a generic 'priorities' line when there's genuinely
// nothing pending" — "Reviewing what changed while you were away…" is a claim
// that something changed, and saying it to somebody whose business had a quiet
// night is the grounding rule breaking at the very first sentence of the
// session. It is the same distinction OwnerBriefingChangeSet.hasPriorAnchor
// exists for elsewhere: two silences are not the same silence.
//
// The pacing is asserted too, and it is not decoration. Sean, after seeing it
// live: "the pacing is still too fast… allow each message to remain on screen
// long enough to actually be read… think calm confidence, not fast loading."
// Nothing here is ever really loading — the dashboard's data is already
// server-rendered by the time this mounts — so this is an honest, deliberate
// pause rather than a progress indicator, and a version of it that ran fast
// would be a lie about what is happening as well as a worse experience.
//
// `useBeatSequence` is a React hook and is not reachable from here; this covers
// the pure half, which is the half that speaks.

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

const beats = (over: Partial<Parameters<typeof buildArrivalBeats>[0]> = {}) =>
  buildArrivalBeats({
    mode: "opening",
    userName: "Sean",
    storeName: "Copper & Coil",
    hasRealBriefing: true,
    ...over,
  });

const totalMs = (list: { pauseBeforeMs?: number; holdMs?: number }[]) =>
  list.reduce((sum, b) => sum + (b.pauseBeforeMs ?? 0) + (b.holdMs ?? 0), 0);

// ============================================================================
console.log("\n=== 1. The closing line is true, or it is a different line ===\n");
// ============================================================================
const withNews = beats({ hasRealBriefing: true });
const quiet = beats({ hasRealBriefing: false });

const closingOf = (list: { text: string }[]) => list[list.length - 1].text;

assert("with something to report, Genesis says it will review it",
  closingOf(withNews).includes("what changed while you were away"), closingOf(withNews));
assert("with nothing to report, it says everything is running smoothly",
  closingOf(quiet).includes("running smoothly"), closingOf(quiet));
assert(
  "so a quiet night is never described as a night with news in it",
  !closingOf(quiet).includes("what changed"),
  "the grounding rule breaking at the first sentence of the session would be the earliest possible place to break it"
);

// Only that one beat differs. If the honesty signal changed anything else, the
// owner would learn to read the whole arrival as a status report.
check("and nothing else about the arrival changes",
  withNews.slice(0, -1).map((b) => b.text),
  quiet.slice(0, -1).map((b) => b.text));

// ============================================================================
console.log("\n=== 2. It greets a person by name, and a stranger without one ===\n");
// ============================================================================
check("a known owner is greeted by name", beats({ userName: "Sean" })[0].text, "Welcome back, Sean.");
check("an unknown one is still welcomed", beats({ userName: null })[0].text, "Welcome back.");
assert("never with an empty name or a dangling comma",
  !beats({ userName: null })[0].text.includes(","),
  "'Welcome back, .' is the shape this avoids");

// The business is named, because the owner may have more than one.
assert("the business is named in its own beat",
  beats().some((b) => b.text.includes("Copper & Coil")),
  JSON.stringify(beats().map((b) => b.text)));

// ============================================================================
console.log("\n=== 3. Switching says what it is doing ===\n");
// ============================================================================
// "switching" is real code with nothing triggering it yet — architect for,
// don't build. Asserted anyway, because the moment a business switcher exists
// this is what an owner reads, and an untested path is exactly where a wrong
// business name would appear.
const switching = beats({ mode: "switching" as ArrivalMode });
assert("switching names the business being switched to",
  switching[0].text.includes("Copper & Coil"), switching[0].text);
assert("and does not greet somebody who never left",
  !switching.some((b) => b.text.includes("Welcome back")),
  "a switch is not an arrival");
check("switching never claims to review changes",
  switching.filter((b) => b.text.includes("what changed")), []);

// ============================================================================
console.log("\n=== 4. Calm confidence, not fast loading ===\n");
// ============================================================================
for (const mode of ["opening", "switching"] as ArrivalMode[]) {
  const list = beats({ mode });
  assert(`${mode} has real beats`, list.length >= 3, `${list.length}`);
  const blank = list.filter((b) => !b.text.trim());
  check(`${mode} says something in every beat`, blank, []);

  // Roughly 5-8 seconds total, per the design record. Asserted as an envelope
  // rather than an exact figure: "the exact numbers here are the one thing
  // expected to change repeatedly."
  const total = totalMs(list);
  assert(`${mode} lasts long enough to be read (${total}ms)`, total >= 4000,
    "Sean: allow each message to remain on screen long enough to actually be read");
  assert(`${mode} does not outstay its welcome (${total}ms)`, total <= 9000,
    "an honest pause, not an indefinite one");

  // Every beat is legible on its own.
  const rushed = list.filter((b) => (b.holdMs ?? 0) < 900).map((b) => b.text);
  check(`no ${mode} beat flashes past`, rushed, []);
}

// The opening pause is sized to land with the orb's own wake ramp (~1.7s), so
// the greeting arrives as it finishes waking rather than mid-ramp.
check("the greeting waits for the orb to wake", beats()[0].pauseBeforeMs, 1700);
assert("and no later beat re-introduces a pause",
  beats().slice(1).every((b) => (b.pauseBeforeMs ?? 0) === 0),
  "one deliberate stillness, at the start, not a stutter through the sequence");

console.log(`\n${failures === 0 ? "All arrival-copy assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
