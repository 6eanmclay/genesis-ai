import { execFile } from "child_process";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// A FAILING SUITE MUST NOT EXIT 0 (gap 25):
//
//   npx tsx scripts/verify-exit-code-integrity.ts
//
// ============ WHAT WENT WRONG ======================================
//
// A runner has exactly one thing to go on: the code its child exited with.
// For every suite that reached a real database or a test server, that number
// was a lie, and had been since those harnesses were written.
//
// The chain is four links long and entirely mechanical. embedded-postgres
// registers async-exit-hook AT MODULE SCOPE (dist/index.js:397), so the import
// alone is enough. async-exit-hook's first registration adds
// `hookEvent("beforeExit", 0)` (index.js:90). That listener ends in
// `process.nextTick(process.exit.bind(null, 0))`. So the moment the event loop
// drains, the process exits ZERO — whatever `process.exitCode` was set to.
//
// Set against a deliberately broken normalizeEmail, the suite printed
// "4 failed, 9 passed" and the lane recorded PASS. Both the shared-lane run
// and the single-suite run, identically: the isolation story was wrong, there
// was never a stale server, and this was never about HTTP at all.
//
// ============ WHY THE PROOF IS A CHILD PROCESS =====================
//
// The thing under test IS an exit code, and a process has exactly one, at the
// end. It cannot be asserted from inside the process that has to produce it,
// and a stub of the hook would test the stub. So each case below is a real
// process, ended a real way, and the only reading taken is the number the
// operating system reports.
//
// scripts/lib/exitCodeFixture.ts is the child. It is in lib/ so that suite
// discovery does not mistake it for a suite of its own.

const ROOT = join(__dirname, "..");

let failures = 0;
let passes = 0;
const failed: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passes++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    failed.push(label);
    console.log(`  FAIL  ${label}  — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function runFixture(mode: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      `npx --yes tsx scripts/lib/exitCodeFixture.ts ${mode}`,
      { cwd: ROOT, shell: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env } },
      (error) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve(typeof code === "number" ? code : 1);
      },
    );
  });
}

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFilesUnder(full, acc);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

async function main(): Promise<void> {
  console.log("=== 1. a suite that set process.exitCode actually exits with it ===");
  // The two harness entry points, because they are what the failing lanes
  // imported. testServer pulls the other one in, and inherited the bug that way.
  check("a failing suite importing the real-database harness exits 1", await runFixture("realpg-fail"), 1);
  check("a failing suite importing the test-server harness exits 1", await runFixture("testserver-fail"), 1);

  console.log("=== 2. and the guard invents nothing ===");
  // A guard that forced a non-zero code would turn every lane red and would
  // still be "passing" section 1. These are the controls that separate the two.
  check("a passing suite still exits 0", await runFixture("realpg-pass"), 0);
  check("an explicit process.exit(3) is not rewritten", await runFixture("realpg-explicit"), 3);
  check("an unhandled throw still fails", await runFixture("realpg-throw"), 1);
  check("a suite importing neither harness is unaffected", await runFixture("bare-fail"), 1);

  console.log("=== 3. nothing else may import the hook without the guard ===");
  //
  // Sections 1 and 2 prove today's two entry points. This is what stops the
  // bug coming back through a third: the guard lives beside the import that
  // needs it, and a new importer that skips it is a new false green nobody
  // would notice, because the symptom is a suite going quietly green.
  //
  // Derived by reading the tree, never a maintained list — the two lines above
  // are only true because this one is.
  const IMPORTS_HOOK = /^\s*import\b[^\n]*"embedded-postgres"/m;
  const GUARD = /^\s*import\s+"\.\/trueExitCode"/m;
  const importers = tsFilesUnder(ROOT)
    .filter((file) => IMPORTS_HOOK.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(ROOT.length + 1).replace(/\\/g, "/"));

  check("the exit hook is reached from exactly one place", importers, ["scripts/lib/realPostgres.ts"]);
  const unguarded = importers.filter((file) => !GUARD.test(readFileSync(join(ROOT, file), "utf8")));
  check("and that place installs the guard", unguarded, []);

  console.log("");
  console.log(`${failures} failed, ${passes} passed`);
  for (const label of failed) console.log(`  - ${label}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
