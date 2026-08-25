import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

// THE PRODUCTION CHECK ACTUALLY EXECUTES:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-bi-production-check.ts" -OutFile out.txt
//
// check-bi-production-readiness.ts is meant to be pointed at PRODUCTION, so the
// one thing that must never happen is discovering it is broken at the moment
// somebody runs it there. Typechecking proves its Prisma calls compile; it does
// not prove `groupBy` on those columns is a query Postgres will accept, or that
// the env-file path works.
//
// So this runs the real script, unmodified, against a real empty database — and
// an empty database is the honest test here: every number it reports must come
// back as a counted zero rather than a crash or an omitted section.
//
// It also asserts, from source, that the script cannot write. That is not
// belt-and-braces: this is the one script in the repository whose whole promise
// is "safe to run against production repeatedly".

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

async function main() {
  const src = codeOnly(readFileSync(join(process.cwd(), "scripts", "check-bi-production-readiness.ts"), "utf8"));

  // ====================================================================
  console.log("\n=== It cannot write, by construction ===\n");
  // ====================================================================
  const writes = [...src.matchAll(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw|executeRawUnsafe)\b/g)]
    .map((m) => m[1]);
  assert("no write call of any kind", writes.length === 0,
    writes.length ? `found: ${[...new Set(writes)].join(", ")}` : "");
  assert("and it says so where somebody will read it",
    /READ-ONLY/.test(readFileSync(join(process.cwd(), "scripts", "check-bi-production-readiness.ts"), "utf8")));
  assert("CONTROL: the detector sees a write when there is one",
    /\.(create|update)\b/.test("prisma.order.create({})"));

  // It must not quietly assume the ambient environment is production.
  assert("running it with no env file warns rather than proceeding silently",
    src.includes("almost certainly your DEV database"),
    "pointing it at the wrong database produces a confident, wrong report");

  // ====================================================================
  console.log("\n=== It runs, against a real database ===\n");
  // ====================================================================
  const db = await startRealPostgres();
  const envPath = join(tmpdir(), `bi-check-${Date.now()}.env`);
  writeFileSync(envPath, `DATABASE_URL=${db.url}\n`, "utf8");

  let output = "";
  let threw = false;
  try {
    output = execFileSync("npx", ["tsx", "scripts/check-bi-production-readiness.ts", envPath], {
      encoding: "utf8",
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    threw = true;
    output = String((error as { stdout?: string; stderr?: string }).stdout ?? "") +
             String((error as { stderr?: string }).stderr ?? "");
  } finally {
    unlinkSync(envPath);
    await db.close();
  }

  assert("it completes rather than throwing", !threw, threw ? output.slice(-600) : "");
  assert("it loaded the named env file rather than the ambient one",
    output.includes("Loaded environment from:"));

  // EVERY SECTION REPORTS. A section that silently disappears on an empty
  // database is the failure mode that would matter in production, where "no
  // section" and "nothing to report" look identical to the reader.
  for (const section of [
    "1. IS THE ENGINE RUNNING?",
    "2. WHAT DID IT CONCLUDE, AND WHEN?",
    "3. THE TWO OPEN QUESTIONS",
  ]) {
    assert(`section present: ${section}`, output.includes(section));
  }

  // The two questions BI_ENGINE.md §15 left open must be ANSWERED, as counted
  // zeroes, not omitted for lack of rows.
  assert("order statuses are reported", output.includes("Order.status values that actually occur"));
  assert("and the shipping-cost coverage is a number",
    /orders carrying shippingCostInCents: \d+/.test(output),
    "a missing cost is an exclusion, never a zero — this is the size of what is excluded");
  assert("zero orders reads as zero, not as an absent section",
    /orders: 0/.test(output));

  assert("and it confirms it wrote nothing", output.includes("Nothing was written."));

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
