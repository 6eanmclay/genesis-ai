import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prismaSystem } from "@/lib/prisma";
import { CONFIG, configEntry, NOT_CONFIGURATION } from "@/lib/config/registry";
import { configReport, logConfigReport } from "@/lib/config/report";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// WHAT THIS DEPLOYMENT IS MISSING:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts config-db
//
// ============ THE ASSERTION THAT KEEPS THIS HONEST (2026-08-30) ========
//
// A registry of environment variables maintained by hand is stale the first
// time somebody adds one in a hurry — and a startup report that quietly omits
// the variable somebody forgot is worse than no report, because it says
// everything is fine.
//
// So this sweeps the source for every `process.env` read and asserts each one
// is declared. Not a list checked against a list: a list checked against the
// code. The same rule ARCHITECTURE.md states for any mirrored registry, applied
// to the thing that decides what a deployment is missing.
//
// ============ AND THE ONE ABOUT SECRETS ==============================
//
// A configuration report is what somebody pastes into a chat window at
// midnight. If it ever carries a fragment of a live key it has made the
// incident worse than the one it was helping with. So a value is planted and
// the whole report is searched for it — the same shape as the boundary suite's
// password assertion, for the same reason.

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);

  console.log("\n--- the registry describes every variable the code reads ---\n");
  {
    // ============ SWEPT, NOT LISTED ==========================
    // ============ FILTERED IN JS, NOT BY A GIT GLOB ============
    //
    // `git ls-files "lib/**/*.ts"` matches nothing at the TOP level of lib, so
    // lib/prisma.ts and lib/platformAdmin.ts were invisible to this sweep and
    // their variables came back as described-but-never-read. A sweep that
    // silently misses files is worse than no sweep: it reports confidently
    // about the part it happened to see.
    const files = execSync("git ls-files", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      // ============ THE APPLICATION AND ITS BUILD (2026-08-30) ====
      //
      // Not just lib and app: DATABASE_URL_UNPOOLED is read by the migration
      // script and NEXT_PUBLIC_SENTRY_DSN by the root Sentry configs, and both
      // are real deployment configuration that a lib-only sweep reported as
      // describing nothing.
      //
      // And not the harness either. Widening to all of scripts/ pulled in
      // PLAYWRIGHT_BASE_URL, SUITE_PROBE and friends — variables a verification
      // suite sets for itself, which nobody deploys and no startup report
      // should mention. This registry describes a DEPLOYMENT.
      .filter((f) =>
        /^(lib|app)\//.test(f) ||
        /^[^/]+\.(ts|tsx|mjs)$/.test(f) ||
        f === "scripts/migrate-deploy.mjs")
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".mjs"))
      // The registry names every variable; counting it would make the sweep
      // trivially agree with itself.
      .filter((f) => f !== "lib/config/registry.ts");

    const read = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/process\.env\.([A-Z_0-9]+)/g)) {
        read.add(match[1]);
      }
    }

    const undeclared = [...read]
      .filter((name) => !NOT_CONFIGURATION.has(name))
      .filter((name) => !configEntry(name))
      .sort();
    eq("every variable the code reads is described", undeclared, []);
    assert("and the sweep actually found some", read.size > 20, `${read.size}`);

    // The other direction: a registry entry nobody reads is a promise about a
    // variable that does nothing, which is its own kind of lie.
    // ============ SOME ARE READ BY A LIBRARY, NOT BY US ========
    //
    // ANTHROPIC_API_KEY, BLOB_READ_WRITE_TOKEN and EASYPOST_API_KEY never
    // appear in this codebase: their SDKs read them from the environment
    // directly. They are as required as anything here — without the first one
    // J4 cannot think — and a registry that omitted them because grep could not
    // see them would be describing the code rather than the deployment.
    const unread = CONFIG.filter((e) => !e.readBySdk)
      .map((e) => e.name)
      .filter((name) => !read.has(name))
      .sort();
    eq("and nothing is described that nothing reads", unread, []);

    // The SDK ones are asserted the other way: they must NOT appear, or the
    // flag is wrong and somebody has moved to reading it directly.
    const wronglyFlagged = CONFIG.filter((e) => e.readBySdk && read.has(e.name)).map((e) => e.name);
    eq("and an SDK-read variable is genuinely not read here", wronglyFlagged, []);
  }

  console.log("\n--- every entry says what its absence costs ---\n");
  {
    for (const entry of CONFIG) {
      assert(`${entry.name} says what it is for`, entry.purpose.length > 10, entry.purpose);
      // The field that makes the report worth reading. "Missing" is a fact;
      // "missing, and that is why nobody can connect Mailchimp" is an answer.
      assert(`${entry.name} says what stops working`, entry.absence.length > 15, entry.absence);
    }
    const names = CONFIG.map((e) => e.name);
    eq("no variable is described twice", names.length, new Set(names).size);

    // The two that genuinely cannot be worked around, named explicitly so
    // widening "essential" is a deliberate act.
    eq("exactly two things are essential",
      CONFIG.filter((e) => e.requirement === "essential").map((e) => e.name).sort(),
      ["AUTH_SECRET", "DATABASE_URL"]);
  }

  console.log("\n--- the report reflects the environment it is given ---\n");
  {
    const before = process.env.PLATFORM_ADMIN_EMAILS;
    delete process.env.PLATFORM_ADMIN_EMAILS;
    const missing = configReport();
    assert("an absent variable is reported missing",
      missing.statuses.find((s) => s.name === "PLATFORM_ADMIN_EMAILS")?.present === false);
    assert("with its consequence, not just its name",
      (missing.statuses.find((s) => s.name === "PLATFORM_ADMIN_EMAILS")?.consequence ?? "").includes("nobody is a platform administrator"));

    process.env.PLATFORM_ADMIN_EMAILS = "someone@example.test";
    const present = configReport();
    assert("a set variable is reported present",
      present.statuses.find((s) => s.name === "PLATFORM_ADMIN_EMAILS")?.present === true);
    eq("and carries no consequence when it is set",
      present.statuses.find((s) => s.name === "PLATFORM_ADMIN_EMAILS")?.consequence, null);

    // ============ WHITESPACE IS NOT A VALUE ================
    //
    // An empty string in a dashboard is the most common way a variable is
    // "set" and useless.
    process.env.PLATFORM_ADMIN_EMAILS = "   ";
    assert("whitespace does not count as set",
      configReport().statuses.find((s) => s.name === "PLATFORM_ADMIN_EMAILS")?.present === false);

    if (before === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = before;
  }

  console.log("\n--- no value ever leaves, whatever it is ---\n");
  {
    // ============ THE ASSERTION THAT MATTERS IN AN INCIDENT ====
    const planted = "sk_live_PLANTED_SECRET_VALUE_0123456789";
    const restore: Record<string, string | undefined> = {};
    for (const entry of CONFIG.filter((e) => e.secret)) {
      restore[entry.name] = process.env[entry.name];
      process.env[entry.name] = planted;
    }

    const report = configReport();
    const dumped = JSON.stringify(report);
    assert("the report contains no secret value", !dumped.includes(planted), dumped.slice(0, 200));
    assert("nor any fragment of one", !dumped.includes("PLANTED"), dumped.slice(0, 200));

    // And the log line, which is the thing that ends up pasted somewhere.
    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try {
      logConfigReport(report);
    } finally {
      console.log = realLog;
    }
    assert("and neither does the startup log", !logged.join("\n").includes(planted));
    assert("but it does say something", logged.join("").length > 0);

    // ============ INCLUDING THE BRANCH THAT RARELY RUNS ========
    //
    // Sabotage made the essential-missing line dump the whole environment and
    // the suite stayed green — because nothing essential is missing here, so
    // that branch never executed. A leak in a line that only runs during an
    // incident is exactly the leak nobody would find.
    const savedDb = process.env.DATABASE_URL;
    const savedAuth = process.env.AUTH_SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.AUTH_SECRET;
    const brokenLog: string[] = [];
    console.log = (...args: unknown[]) => { brokenLog.push(args.map(String).join(" ")); };
    try {
      logConfigReport(configReport());
    } finally {
      console.log = realLog;
      if (savedDb !== undefined) process.env.DATABASE_URL = savedDb;
      if (savedAuth !== undefined) process.env.AUTH_SECRET = savedAuth;
    }
    const brokenText = brokenLog.join("\n");
    assert("a missing essential is named", brokenText.includes("DATABASE_URL"), brokenText.slice(0, 200));
    assert("with its consequence", brokenText.includes("Nothing works at all"));
    assert("and even then no value is printed", !brokenText.includes(planted), brokenText.slice(0, 300));

    for (const [name, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  console.log("\n--- it reports rather than refusing to start ---\n");
  {
    // A platform that will not boot because nobody registered a TikTok app is
    // worse than one that boots and says TikTok is unavailable.
    // Comments stripped: this file's own prose explains why it does NOT throw,
    // and matching that reports the explanation as the offence — the same
    // mistake already made three times in this session.
    const registry = readFileSync("lib/config/report.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    assert("nothing in the report throws", !/\bthrow\b/.test(registry), "the report refuses to start");

    const hook = readFileSync("instrumentation.ts", "utf8");
    assert("it runs at boot", hook.includes("logConfigReport()"));
    assert("on the Node runtime only", /NEXT_RUNTIME === "nodejs"[\s\S]{0,900}logConfigReport/.test(hook));
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
