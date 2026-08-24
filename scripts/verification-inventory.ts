import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { needsDatabase } from "./lib/suiteLanes";

// THE VERIFICATION INVENTORY — one authoritative answer to "what do we actually run?"
//
//   npx tsx scripts/verification-inventory.ts            human-readable report
//   npx tsx scripts/verification-inventory.ts --json     machine-readable
//   npx tsx scripts/verification-inventory.ts --plan     just the execution lanes
//
// WHY THIS EXISTS. `run-db-suites.ts` prints a confident "41/41 database-backed
// suites pass", and that number has been the green signal for this repository.
// It covers 41 of 184 verification suites. The rest are not failing — they are
// not being asked. A suite nobody runs is not coverage, and an aggregate number
// that implies otherwise is the same class of problem as a test that passes
// without entering the behaviour it names.
//
// THIS FILE DOES NOT RUN ANYTHING. It reports. Forcing 184 suites into one
// process would be worse than the problem: 59 of them start their own Postgres
// or their own Next server, and PGlite serves a single connection, so a suite
// that fans out parallel reads has previously killed an unrelated suite three
// positions later. The goal is one authoritative inventory and a small number of
// INTENTIONAL execution lanes — not one process that magically runs everything.
//
// Classification is read from the source, never from a hand-maintained list.
// A list is how verify-mobile-reliability.ts ended up running in the wrong lane
// for a day; the detector that replaced it is the pattern this file extends.

const SCRIPTS = join(process.cwd(), "scripts");

export type Lane =
  | "shared-runner"       // run-db-suites.ts runs it
  | "own-infrastructure"  // brings its own Postgres or Next server
  | "standalone"          // no database; runs anywhere, cheaply
  | "excluded-named";     // deliberately excluded, by name, with a reason

export interface SuiteFacts {
  file: string;
  lane: Lane;
  /** Why it is not in the shared runner. Empty when it is. */
  excludedBecause: string;
  ownInfrastructure: boolean;
  databaseBacked: boolean;
  /** Needs a real model or a real third-party provider to do its job. */
  liveDependencies: string[];
  /**
   * Whether it calls production code, or only reads production SOURCE and
   * asserts on the text. Source-only suites protect against a line being
   * deleted; they cannot protect against it being wrong.
   */
  exercises: "production-behaviour" | "source-assertions-only" | "unknown";
  /** Source-text assertions, and whether comments are stripped first. */
  sourceAssertions: number;
  stripsComments: boolean;
}

const LIVE_MARKERS: [RegExp, string][] = [
  [/ANTHROPIC_API_KEY/, "anthropic"],
  [/CLASSIFY_FIXTURE_URL/, "classify-fixture"],
  [/STRIPE_SECRET_KEY|STRIPE_[A-Z_]*KEY/, "stripe"],
  [/PAYPAL_CLIENT_(ID|SECRET)/, "paypal"],
  [/EASYPOST_API_KEY/, "easypost"],
  [/PRINTFUL_API_KEY/, "printful"],
  [/RESEND_API_KEY/, "resend"],
  [/ELEVENLABS_API_KEY/, "elevenlabs"],
  [/UNSPLASH_ACCESS_KEY/, "unsplash"],
];

function classify(file: string, source: string): SuiteFacts {
  const ownInfrastructure = /startTestServer|startRealPostgres/.test(source);
  const databaseBacked = /\bprisma\b/.test(source);

  const liveDependencies = LIVE_MARKERS.filter(([re]) => re.test(source)).map(([, name]) => name);

  // Does it import production code, or only read it as text?
  const importsProduction = /from\s+"@\/(lib|app)\//.test(source);
  const readsSource = /readFileSync/.test(source);
  const exercises: SuiteFacts["exercises"] =
    importsProduction || databaseBacked
      ? "production-behaviour"
      : readsSource
        ? "source-assertions-only"
        : "unknown";

  // Source-text assertions: a variable bound to readFileSync, asserted with
  // .includes(). The receiver has to be bound, or every runtime string check
  // gets miscounted as a source assertion.
  const bound = new Set<string>();
  for (const m of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:codeOnly\()?\s*readFileSync\(/g)) {
    bound.add(m[1]);
  }
  let sourceAssertions = 0;
  for (const m of source.matchAll(/\b(\w+)\.includes\(/g)) {
    if (bound.has(m[1])) sourceAssertions++;
  }

  // THE RUNNER'S OWN DECISION, not a second opinion about it. needsDatabase is
  // the function run-db-suites.ts uses to choose what it runs, shared from
  // scripts/lib/suiteLanes.ts precisely so this report cannot disagree with what
  // actually happens. An inventory that re-derived the answer would be wrong the
  // first time somebody changed one file and not the other.
  const inSharedRunner = needsDatabase(file);

  let lane: Lane;
  let excludedBecause = "";
  if (inSharedRunner) {
    lane = "shared-runner";
  } else if (ownInfrastructure) {
    lane = "own-infrastructure";
    excludedBecause = "starts its own Postgres or Next server; the shared runner must not own it";
  } else if (databaseBacked) {
    lane = "excluded-named";
    excludedBecause = "database-backed, but named as an exclusion in run-db-suites.ts";
  } else {
    lane = "standalone";
    excludedBecause = "no database; the shared runner only claims database-backed suites";
  }

  return {
    file, lane, excludedBecause, ownInfrastructure, databaseBacked,
    liveDependencies, exercises, sourceAssertions,
    stripsComments: /codeOnly/.test(source),
  };
}

export function inventory(): SuiteFacts[] {
  return readdirSync(SCRIPTS)
    .filter((f) => f.startsWith("verify-") && f.endsWith(".ts"))
    .sort()
    .map((f) => classify(f, readFileSync(join(SCRIPTS, f), "utf8")));
}

function report(all: SuiteFacts[]): void {
  const by = (l: Lane) => all.filter((s) => s.lane === l);
  const live = all.filter((s) => s.liveDependencies.length > 0);
  const sourceOnly = all.filter((s) => s.exercises === "source-assertions-only");

  console.log("\n=== VERIFICATION INVENTORY ===\n");
  console.log(`  total verification suites                 ${all.length}`);
  console.log(`    in the shared runner                    ${by("shared-runner").length}`);
  console.log(`    bring their own infrastructure          ${by("own-infrastructure").length}`);
  console.log(`    standalone, no database                 ${by("standalone").length}`);
  console.log(`    excluded by name                        ${by("excluded-named").length}`);
  console.log();
  console.log(`  need a live model or provider             ${live.length}`);
  console.log(`  exercise production behaviour             ${all.filter((s) => s.exercises === "production-behaviour").length}`);
  console.log(`  assert on source text only                ${sourceOnly.length}`);
  console.log(`  carry source assertions                   ${all.filter((s) => s.sourceAssertions > 0).length}`);
  console.log(`    of those, strip comments first          ${all.filter((s) => s.sourceAssertions > 0 && s.stripsComments).length}`);

  console.log("\n--- THE EXECUTION LANES ---\n");
  console.log("  1. npx tsx scripts/run-db-suites.ts");
  console.log(`       ${by("shared-runner").length} database-backed suites, one shared harness.`);
  console.log("  2. npx tsx scripts/verification-inventory.ts --plan");
  console.log(`       lists the ${by("standalone").length} standalone suites; each runs alone, cheaply, no database.`);
  console.log("  3. by hand, deliberately");
  console.log(`       ${by("own-infrastructure").length} suites that start their own Postgres or Next server.`);
  console.log(`       ${by("excluded-named").length} excluded by name — see the reasons below.`);
  console.log(`  4. gated on credentials`);
  console.log(`       ${live.length} suites need a live model or provider and must never run unasked.`);

  console.log("\n--- DATABASE-BACKED BUT DELIBERATELY EXCLUDED ---");
  console.log("  These reach for Prisma and are still not in the shared run. Each is");
  console.log("  named in run-db-suites.ts with its own reason.\n");
  for (const s of by("excluded-named")) console.log(`  ${s.file}`);

  console.log("\n--- LIVE DEPENDENCIES ---\n");
  for (const s of live) console.log(`  ${s.file.padEnd(44)} ${s.liveDependencies.join(", ")}`);

  console.log("\n--- SOURCE-ASSERTION-ONLY SUITES ---");
  console.log("  These protect against a line being deleted. They cannot protect");
  console.log("  against it being wrong.\n");
  for (const s of sourceOnly) {
    console.log(`  ${s.file.padEnd(44)} ${s.sourceAssertions} assertion(s)${s.stripsComments ? "" : "   [comments NOT stripped]"}`);
  }

  console.log("\n--- WHAT NO LANE RUNS AUTOMATICALLY ---\n");
  const unrun = all.filter((s) => s.lane !== "shared-runner");
  console.log(`  ${unrun.length} of ${all.length} suites run only when somebody chooses to run them.`);
  console.log("  That is not a defect to fix by forcing them together — it is a fact");
  console.log("  this report exists to keep visible.\n");
}

const args = process.argv.slice(2);
const all = inventory();
if (args.includes("--json")) {
  console.log(JSON.stringify(all, null, 2));
} else if (args.includes("--plan")) {
  for (const s of all.filter((x) => x.lane === "standalone")) console.log(`npx tsx scripts/${s.file}`);
} else {
  report(all);
}
