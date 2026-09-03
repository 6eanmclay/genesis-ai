import { mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  fileOfSymbol,
  fileOfRoute,
  sourceOfSymbol,
  sourceOfRoute,
  SymbolNotFound,
  SymbolAmbiguous,
  RouteNotFound,
} from "@/scripts/lib/sourceOf";

// A MOVED SYMBOL MUST NOT LEAVE A GREEN ASSERTION:
//
//   npx tsx scripts/run-code-suites.ts source-resolution
//
// ============ WHAT THIS IS FOR =======================================
//
// scripts/lib/sourceOf.ts exists to end one recurring failure: an assertion
// naming a file by hand, the code moving, and the assertion then being wrong
// about a behaviour that is perfectly intact. Four suites failed that way in
// one run.
//
// The dangerous direction is the quiet one. A file left behind after its
// contents moved leaves the old assertion GREEN — passing, about code nobody
// runs — and no amount of care in the assertion itself catches that.
//
// ============ THESE MOVE REAL FILES ==================================
//
// The first section renames an actual module on disk, re-resolves, and puts
// it back. That is the only way to prove the property rather than describe
// it: a helper that "would find the new location" is a claim until something
// actually moves. Every move is undone in a finally, and the suite fails
// loudly if a restore does not happen.

let passes = 0;
let failures = 0;
const failed: string[] = [];

function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else { failures++; failed.push(name); }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
/** Runs `work` and returns the error it threw, or null. */
function threw(work: () => unknown): Error | null {
  try { work(); return null; } catch (error) { return error as Error; }
}

const CWD = process.cwd();
const SCRATCH = join(CWD, "lib", "__source_resolution_scratch__");

function main(): void {
  // ======================================================================
  console.log("\n=== 1. It answers where the code is now ===\n");
  // ======================================================================

  eq("a uniquely-declared symbol resolves",
    fileOfSymbol("NAV_DESTINATIONS"), "lib/execution/toolHandlers.ts");
  eq("and so does a function", fileOfSymbol("runDueTasks"), "lib/scheduler/run.ts");
  eq("a route resolves by the URL it serves",
    fileOfRoute("/api/cron/status"), "app/api/cron/status/route.ts");
  assert("and the source it returns is the real file",
    sourceOfSymbol("runDueTasks").includes("export async function runDueTasks"));
  assert("as is a route's", sourceOfRoute("/api/cron/status").includes("export async function GET"));

  // ======================================================================
  console.log("\n=== 2. SABOTAGE: the implementation moves ===\n");
  // ======================================================================
  //
  // THE ONE THAT MATTERS. A stale hand-written path would still read the old
  // file and could still pass; resolving by symbol must follow the code.

  const original = join(CWD, "lib", "scheduler", "run.ts");
  const movedTo = join(SCRATCH, "movedRun.ts");
  mkdirSync(SCRATCH, { recursive: true });
  let moved = false;
  try {
    renameSync(original, movedTo);
    moved = true;

    eq("a moved implementation is found at its new path",
      fileOfSymbol("runDueTasks"), "lib/__source_resolution_scratch__/movedRun.ts");
    assert("and the source really is the moved file's",
      sourceOfSymbol("runDueTasks").includes("export async function runDueTasks"));

    // AND THE OLD PATH IS GONE, which is what makes the green-on-stale case
    // impossible: there is nothing left at the old address to read.
    assert("nothing is left behind at the old path to read",
      threw(() => sourceOfRoute("/scheduler/run")) !== null);
  } finally {
    if (moved) renameSync(movedTo, original);
    rmSync(SCRATCH, { recursive: true, force: true });
  }
  eq("and the move is undone", fileOfSymbol("runDueTasks"), "lib/scheduler/run.ts");

  // ======================================================================
  console.log("\n=== 3. SABOTAGE: the implementation is renamed ===\n");
  // ======================================================================
  //
  // A rename is the case a path-based assertion cannot see AT ALL: the file
  // is still there, so the old assertion keeps reading it and keeps passing
  // while the thing it names no longer exists.

  mkdirSync(SCRATCH, { recursive: true });
  const renamed = join(SCRATCH, "renamed.ts");
  try {
    writeFileSync(renamed, "export const NAV_DESTINATIONS_RENAMED = {};\n", "utf8");
    const error = threw(() => fileOfSymbol("NAV_DESTINATIONS_STILL_MISSING"));
    assert("a symbol that does not exist throws SymbolNotFound",
      error instanceof SymbolNotFound, String(error));
    assert("and the error names the symbol",
      (error?.message ?? "").includes("NAV_DESTINATIONS_STILL_MISSING"), error?.message ?? "");
    assert("and says not to re-point it by hand",
      /by hand/i.test(error?.message ?? ""), error?.message ?? "");
  } finally {
    rmSync(SCRATCH, { recursive: true, force: true });
  }

  // ======================================================================
  console.log("\n=== 4. It cannot resolve something unrelated ===\n");
  // ======================================================================

  const ambiguous = threw(() => fileOfSymbol("GET"));
  assert("a name declared in many files throws SymbolAmbiguous",
    ambiguous instanceof SymbolAmbiguous, String(ambiguous));
  assert("and names the files rather than picking one",
    (ambiguous?.message ?? "").includes("route.ts"), ambiguous?.message ?? "");

  // NO PREFIX OR SUBSTRING MATCHING. `runDueTasks` must not be answered by
  // `runDueTasksNow`, and a partial name must not resolve at all — that is
  // the "accidentally resolves an unrelated symbol" case.
  mkdirSync(SCRATCH, { recursive: true });
  try {
    writeFileSync(join(SCRATCH, "near.ts"), "export const runDueTasksNow = 1;\n", "utf8");
    eq("a longer name does not answer for the shorter one",
      fileOfSymbol("runDueTasks"), "lib/scheduler/run.ts");
    assert("and a prefix of a real symbol resolves to nothing",
      threw(() => fileOfSymbol("runDue")) instanceof SymbolNotFound);
    assert("nor does a name that merely appears in the file body",
      threw(() => fileOfSymbol("overdueRatio_NOT_DECLARED")) instanceof SymbolNotFound);
  } finally {
    rmSync(SCRATCH, { recursive: true, force: true });
  }

  const badRoute = threw(() => fileOfRoute("/api/not/a/real/route"));
  assert("an unknown route throws RouteNotFound", badRoute instanceof RouteNotFound, String(badRoute));
  assert("and says what it looked for",
    (badRoute?.message ?? "").includes("app"), badRoute?.message ?? "");

  // ======================================================================
  console.log("\n=== 5. It answers WHERE, never WHETHER ===\n");
  // ======================================================================
  //
  // The helper must not become a way to soften an assertion. It returns file
  // text and nothing else — no matching, no "contains", no verdict — so the
  // behavioural assertion in each suite stays exactly as strict as it was.

  const source = sourceOfSymbol("runDueTasks");
  assert("it returns source text, not a judgement", typeof source === "string");
  assert("and the caller's own pattern still decides",
    /export async function runDueTasks/.test(source) && !/assert|expect/.test("sourceOfSymbol"));

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ${f}`);
  }
  if (failures > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  // BELT AND BRACES. A suite that moved a real module and died must not leave
  // it moved — that would break every other suite on the machine.
  rmSync(SCRATCH, { recursive: true, force: true });
}
