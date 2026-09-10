import { readFileSync } from "node:fs";
import { createFirstTokenClock, isUsableLatency, averageLatency } from "@/lib/telemetry/firstToken";

// THE INSTRUMENT ITSELF, BEFORE ANYTHING IS OPTIMISED AGAINST IT (2026-09-09).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-first-token.ts" -OutFile out.txt
//
// Sean, after this session produced three measurement bugs in a row - two
// different zeroes for one comparison, a stale edit that measured the wrong
// surface, and a readiness check that reported the FAST page as broken and the
// SLOW page as fine:
//
//   "don't optimize against an untrusted number."
//
// And five things to prove about this one. Each has its own section below.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---- 1. a known, controlled delay ---------------------------------------
//
// Not a sleep. A fake clock, so the expected answer is exact and the suite is
// neither slow nor flaky — a real delay would have to be generous enough to
// survive a loaded machine, which makes it useless for asserting a value.
console.log("\n=== 1. it measures a known delay exactly ===\n");
for (const delay of [0, 1, 250, 4000, 31_000]) {
  let fakeNow = 1_000_000;
  const clock = createFirstTokenClock(fakeNow, () => fakeNow);
  fakeNow += delay;
  clock.markDelta();
  check(`a ${delay}ms delay measures ${delay}ms`, clock.value() === delay, `${clock.value()}`);
}

// Only the FIRST delta counts. A later one must not move the number, or the
// metric silently becomes "time to last token".
{
  let fakeNow = 1_000_000;
  const clock = createFirstTokenClock(fakeNow, () => fakeNow);
  fakeNow += 300;
  clock.markDelta();
  fakeNow += 9_000;
  clock.markDelta();
  clock.markDelta();
  check("later deltas do not move the measurement", clock.value() === 300, `${clock.value()}`);
  check("but they are counted", clock.deltaCount() === 3, `${clock.deltaCount()} deltas`);
}

// ---- 2. it fails when the event never happens ---------------------------
console.log("\n=== 2. no first token means no measurement ===\n");
{
  const clock = createFirstTokenClock(1_000_000, () => 1_099_999);
  check("a turn with no text has no latency", clock.value() === null, String(clock.value()));
  check("and no deltas", clock.deltaCount() === 0, String(clock.deltaCount()));
}

// ---- 3. missing can never masquerade as fast ----------------------------
//
// The dangerous failure: a turn that measured nothing entering an average as
// 0ms, which looks like the best possible result while meaning the opposite.
console.log("\n=== 3. missing is never reported as zero ===\n");
check("null is not a usable latency", !isUsableLatency(null));
check("undefined is not a usable latency", !isUsableLatency(undefined));
check("a negative is not a usable latency", !isUsableLatency(-5), "a clock that ran backwards");
check("NaN is not a usable latency", !isUsableLatency(Number.NaN));
check("zero IS usable", isUsableLatency(0), "a genuine same-millisecond delta is real");

check("an average of nothing is null, not zero", averageLatency([null, undefined]) === null, String(averageLatency([null, undefined])));
check("missing turns do not drag an average down",
  averageLatency([1000, null, 2000]) === 1500, String(averageLatency([1000, null, 2000])));
check("an average of real values is the average", averageLatency([100, 200, 300]) === 200, String(averageLatency([100, 200, 300])));

// ---- 4. the number comes from the production streaming path -------------
//
// SCANNED WITH COMMENTS STRIPPED. Two suites earlier today matched their own
// explanatory prose and reported the opposite of the truth, so only code is
// read here. What is asserted is structural: the route that writes
// `streamed: true` is the one that measures, every one of its turn-logging
// exits carries the value, and the OTHER rail does not claim this field.
console.log("\n=== 4. it belongs to the rail production actually uses ===\n");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const route = strip(readFileSync("app/api/chat/route.ts", "utf8"));
const actions = strip(readFileSync("app/dashboard/ai-actions.ts", "utf8"));

check("the streaming route uses the clock", /createFirstTokenClock\(/.test(route));
check("the clock starts from the turn, not the model call",
  /createFirstTokenClock\(turnStartedAt\)/.test(route), "started at turnStartedAt");
check("it is marked on the real text-delta callback",
  /onTextDelta[\s\S]{0,200}firstTokenClock\.markDelta\(\)/.test(route));
check("the same writer records streamed: true",
  /streamed:\s*true[\s\S]{0,300}firstTokenAtMs/.test(route) || /firstTokenAtMs[\s\S]{0,300}streamed:\s*true/.test(route));

// COUNTED INSIDE EACH CALL, not across the file. The first version compared
// every occurrence of the value against the number of call sites and reported
// "4 of 3" — because the diagnostic log line also reads the clock. Two
// different populations, so the comparison was meaningless in both directions:
// it would equally have passed with one exit uninstrumented and two diagnostic
// reads.
// The declaration matches the same split, so it is excluded by what follows
// it — `params:` — rather than by counting and subtracting one, which would
// silently stop being right the day a second helper is added.
const callSites = route
  .split("logStreamedChatTurn(")
  .slice(1)
  .filter((tail) => !tail.trimStart().startsWith("params:"));
const instrumented = callSites.filter((tail) => /firstTokenAtMs:\s*firstTokenClock\.value\(\)/.test(tail.slice(0, 400)));
check(
  "every turn-logging exit carries the value",
  callSites.length > 0 && instrumented.length === callSites.length,
  `${instrumented.length} of ${callSites.length} call sites`,
);

check("the other rail does not claim this field",
  !/firstTokenAtMs/.test(actions),
  "ai-actions.ts writes stage timings, not a first-token number");

// ---- 5. and what this cannot prove -------------------------------------
//
// Stated rather than implied. The five checks above are about the instrument;
// none of them shows the number arriving from a real turn, because that needs
// a live model and there is no ANTHROPIC_API_KEY locally. The production
// verification is a separate, deliberate step against a real spoken turn.
console.log("\n=== 5. what this suite does NOT prove ===\n");
console.log("      that a real turn writes a real number — needs a live model");
console.log("      and is verified against production, not here.");

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
process.exit(failed.length === 0 ? 0 : 1);
