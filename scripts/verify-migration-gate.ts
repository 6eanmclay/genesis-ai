import { readFileSync } from "fs";
import { join } from "path";
// A plain .mjs module, imported so the suite tests the REAL decision the build
// makes rather than a TypeScript copy of it. Its JSDoc carries the types, so
// tsc checks these call sites like any other.
import { migrationDecision, refusalMessage, ALLOW_VARIABLE } from "@/scripts/lib/migrationGate.mjs";

// NO SCHEMA MIGRATION REACHES PRODUCTION WITHOUT A REVIEW CHECKPOINT:
//
//   npx tsx scripts/run-code-suites.ts migration-gate
//
// ============ U7, DECIDED BY SEAN 2026-09-17 ==========================
//
// "Reinstate the review gate before production migrations. I do not want schema
// migrations reaching production automatically without a review checkpoint."
//
// ============ WHY BOTH PREVIOUS POSITIONS FAILED ======================
//
// 5002093 removed migrations from the build. Correct about the risk, and it
// left a second one: a push whose code needs a new column builds fine and fails
// at RUNTIME, because nothing notices the migration was never applied.
//
// a2a05bf put automatic migrations back, which fixed that and removed the
// review step. Neither commit updated DEPLOYMENT.md, so the docs described a
// gate that was not there for a week — COMPLIANCE.md §46, found only because
// somebody went to apply a migration deliberately and discovered the push had
// already done it.
//
// So "refuse" alone recreates the first hole. The gate refuses AND FAILS THE
// BUILD: production keeps serving the previous deployment, unchanged, until a
// person applies the migration deliberately.
//
// ============ THE AUTHORISATION IS NOT A BOOLEAN ======================
//
// The assertions that matter most are in section 3. ALLOW_PRODUCTION_MIGRATION
// must name the exact set pending, so a flag left switched on cannot wave
// through whatever arrives next week — which is how every "set a flag" gate
// eventually stops being a gate.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${label}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  — ${detail}` : ""}`);
}

type Decision = { action: "migrate" | "skip" | "refuse"; why: string };
const decide = (input: {
  vercelEnv?: string | undefined;
  allow?: string | undefined;
  pending: string[];
}): Decision =>
  migrationDecision({
    vercelEnv: input.vercelEnv,
    allow: input.allow,
    pending: input.pending,
  }) as Decision;

const A = "20260914180000_approval_task_identity";
const B = "20260914120000_store_created_from_draft";

// ====================================================================
console.log("\n1. A production build does NOT migrate on its own\n");
// ====================================================================
{
  // THE WHOLE POINT. This is the state every push to master is in today.
  const d = decide({ vercelEnv: "production", pending: [A] });
  assert("a pending migration on a production deploy is refused", d.action === "refuse", d.why);
  assert("  and the reason says nothing was authorised", /no authorisation/i.test(d.why), d.why);

  const many = decide({ vercelEnv: "production", pending: [A, B] });
  assert("two pending migrations are refused too", many.action === "refuse", many.why);
}

// ====================================================================
console.log("\n2. It does not fire when there is nothing to review\n");
// ====================================================================
{
  // A GATE THAT BLOCKS ORDINARY DEPLOYS GETS REMOVED. The overwhelming
  // majority of pushes carry no migration at all, and those must build exactly
  // as they always have.
  const d = decide({ vercelEnv: "production", pending: [] });
  assert("a production deploy with nothing pending proceeds", d.action === "skip", d.why);
  assert("  and says why, rather than silently doing nothing",
    /no migration is pending/i.test(d.why), d.why);
}

// ====================================================================
console.log("\n3. The authorisation names what it authorises\n");
// ====================================================================
{
  const exact = decide({ vercelEnv: "production", allow: A, pending: [A] });
  assert("naming the pending migration authorises it", exact.action === "migrate", exact.why);
  assert("  and the log says which", exact.why.includes(A), exact.why);

  // THE ASSERTION THIS DESIGN EXISTS FOR. A flag left set from last month must
  // not authorise a migration written yesterday.
  const stale = decide({ vercelEnv: "production", allow: B, pending: [A] });
  assert("a stale authorisation naming a DIFFERENT migration is refused",
    stale.action === "refuse", stale.why);
  assert("  and the refusal shows both sides",
    stale.why.includes(A) && stale.why.includes(B), stale.why);

  // AUTHORISING ONE OF TWO IS NOT AUTHORISING BOTH.
  const partial = decide({ vercelEnv: "production", allow: A, pending: [A, B] });
  assert("authorising one while two are pending is refused", partial.action === "refuse", partial.why);

  // AND NAMING ONE THAT IS NOT PENDING IS ALSO STALE.
  const extra = decide({ vercelEnv: "production", allow: `${A},${B}`, pending: [A] });
  assert("naming more than is pending is refused", extra.action === "refuse", extra.why);

  // BOTH, EXACTLY — and order must not matter, because a person types these.
  const both = decide({ vercelEnv: "production", allow: `${B}, ${A}`, pending: [A, B] });
  assert("naming exactly both, in either order, authorises them", both.action === "migrate", both.why);

  // A BOOLEAN IS NOT AN AUTHORISATION. The old shape of this mistake.
  for (const value of ["1", "true", "yes", "TRUE", " ", ""]) {
    const d = decide({ vercelEnv: "production", allow: value, pending: [A] });
    assert(`${JSON.stringify(value)} does not authorise anything`, d.action === "refuse", d.why);
  }
}

// ====================================================================
console.log("\n4. Only production is gated\n");
// ====================================================================
{
  // Preview and local have no customer data, and gating them would teach
  // people to work around the gate rather than use it.
  for (const vercelEnv of ["preview", "development", undefined]) {
    const d = decide({ vercelEnv, pending: [A, B] });
    assert(`VERCEL_ENV=${vercelEnv ?? "(unset)"} still migrates`, d.action === "migrate", d.why);
  }
}

// ====================================================================
console.log("\n5. The refusal is something a person can act on\n");
// ====================================================================
{
  // A refusal nobody can act on just gets the gate deleted again — which is
  // the actual history here, twice.
  const message = refusalMessage({ pending: [A, B], why: "no authorisation given" }) as string;
  assert("it names every pending migration",
    message.includes(A) && message.includes(B), message.slice(0, 120));
  assert("  it says production was not changed",
    /has NOT been changed/i.test(message));
  assert("  it gives the deliberate command",
    message.includes("npm run migrate:deploy"));
  assert("  it shows the exact authorisation value, ready to paste",
    message.includes(`${ALLOW_VARIABLE}=`) && message.includes(`${B},${A}`.split(",").sort().join(",")),
    message.slice(0, 200));
  assert("  and it says the authorisation covers only these",
    /no others/i.test(message));
}

// ====================================================================
console.log("\n6. The build really consults the gate\n");
// ====================================================================
{
  // A DECISION NOTHING CALLS IS NOT A GATE. Sections 1-5 prove the judgement;
  // this proves the build asks it before running prisma.
  const source = readFileSync(join(process.cwd(), "scripts/migrate-deploy.mjs"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  assert("migrate-deploy imports the gate", /migrationDecision/.test(source));
  assert("  and refuses by exiting non-zero, so the build fails",
    /action === "refuse"[\s\S]{0,200}process\.exit\(1\)/.test(source), "a refusal must fail the build");
  assert("  it reads the ledger rather than parsing CLI prose",
    /_prisma_migrations/.test(source) && !/have not yet been applied/.test(source));
  assert("  an unreachable database fails rather than passing",
    /could not read the migration ledger[\s\S]{0,200}process\.exit\(1\)/.test(source));
  assert("  and the unpooled-connection fix is still there",
    /DATABASE_URL_UNPOOLED/.test(source), "db27a05's advisory-lock fix must survive this change");

  // AND THE BUILD STILL RUNS IT. A gate is worthless if package.json stopped
  // calling the script at all.
  const pkg = readFileSync(join(process.cwd(), "package.json"), "utf8");
  assert("the build still invokes migrate-deploy", /migrate-deploy\.mjs[^"]*&&[^"]*next build/.test(pkg));
  assert("  and migrate:deploy is still available for the deliberate path",
    /"migrate:deploy":\s*"node scripts\/migrate-deploy\.mjs"/.test(pkg));
}

console.log(`\n${failures} failed, ${passes} passed`);
if (failures > 0) {
  console.log("\nFAILED:");
  for (const line of failed) console.log(`  ${line}`);
  process.exit(1);
}
process.exit(0);
