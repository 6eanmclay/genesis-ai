import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { startRealPostgres } from "@/scripts/lib/realPostgres";

// CAN WE ACTUALLY COME BACK FROM A BAD MIGRATION?
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-restore.ts" -OutFile out.txt
//
// ============ THE SENTENCE THIS EXISTS TO STOP REPEATING ===============
//
// EXTERNAL_BLOCKERS.md E6: "the only rollback for a destructive migration is a
// restore whose viability nobody has tested." That sentence has been true since
// it was written, and it is the load-bearing half of every reassurance about
// the missing migration gate — the gate is gone, and the answer to "what if a
// migration is wrong" is a recovery path nobody has ever exercised.
//
// ============ WHAT THIS CAN AND CANNOT PROVE ==========================
//
// A restore has two halves. Neon's half — take a branch at a point in time and
// get a database back — needs a Neon API key and is genuinely external; it is
// recorded as blocked rather than faked, because a mocked restore proves
// nothing about a real one.
//
// THIS half is the one that has always been testable and never tested: given a
// restored database, does replaying this repository's migrations from nothing
// actually produce the schema the running code expects? If a migration was ever
// edited after being applied, or production was hand-patched, or two branches
// wrote conflicting migrations, the recovery path is broken — and the moment
// you find out is the moment you need it.
//
// So this starts an EMPTY Postgres, replays every migration in order, and then
// asks Prisma itself whether the result differs from schema.prisma. Zero drift
// is the pass condition, and it is checked by `migrate diff` rather than by
// comparing anything by hand.

let failures = 0;
let passes = 0;
const failed: string[] = [];
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${name}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}

/** The marker requireTestDatabase writes so a suite can refuse to run against anything real. */
const HARNESS_ONLY = "_genesis_test_database";

/**
 * What `migrate diff` reported, minus the one difference that is legitimate.
 *
 * ============ A FILTER IS A PLACE DRIFT CAN HIDE =====================
 *
 * Subtracting the harness's own marker table is correct — it exists only in a
 * test database and is rightly absent from schema.prisma. But a filter that
 * quietly widened would hide real drift and the suite would go green, which is
 * the worst possible failure for a check whose whole job is noticing.
 *
 * So it is a named function rather than three chained calls inside an
 * assertion, and the suite feeds it a synthetic diff carrying both a harness
 * block and a real one to prove it keeps the real one.
 */
export function driftExcludingHarness(diffOutput: string): string {
  return diffOutput
    .split(/\n\s*\n/)
    .filter((block) => block.trim() && !block.includes(HARNESS_ONLY))
    // Prisma prefixes every real change with [-], [+] or [*]; the rest of the
    // output is headers and the "Loaded Prisma config" preamble.
    .filter((block) => /^\s*\[[-*+]\]/m.test(block))
    .join("\n\n")
    .trim();
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      args,
      { env: { ...process.env, ...env }, shell: true, maxBuffer: 1024 * 1024 * 32 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: `${stdout}\n${stderr}`,
        });
      },
    );
  });
}

async function main(): Promise<void> {
  console.log("Starting an EMPTY Postgres and replaying every migration from nothing.\n");

  // startRealPostgres migrates as part of starting up, which is exactly the
  // replay this needs — it is `prisma migrate deploy` against a database that
  // did not exist a moment ago, which is what a restored branch looks like.
  const pg = await startRealPostgres();

  try {
    const onDisk = readdirSync("prisma/migrations").filter((d) => /^\d/.test(d)).sort();

    console.log("\n--- every migration in the repository replayed onto nothing ---\n");
    {
      const applied = await pg.prisma.$queryRawUnsafe<{ migration_name: string; rolled_back_at: Date | null }[]>(
        `SELECT migration_name, rolled_back_at FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
      );
      const names = new Set(applied.map((a) => a.migration_name));

      assert("the repository has a migration history at all", onDisk.length > 100, String(onDisk.length));
      const missing = onDisk.filter((m) => !names.has(m));
      assert("every migration on disk applied cleanly", missing.length === 0,
        missing.length ? `did not apply: ${missing.join(", ")}` : "");

      const rolledBack = applied.filter((a) => a.rolled_back_at !== null).map((a) => a.migration_name);
      assert("and none of them had to be rolled back", rolledBack.length === 0, rolledBack.join(", "));
    }

    console.log("\n--- and the result is the schema the code expects ---\n");
    {
      // ============ ASKED OF PRISMA, NOT ASSERTED BY HAND ==========
      //
      // `migrate diff --exit-code` exits 2 when there IS a difference between
      // the replayed database and schema.prisma. That is the whole question —
      // a restored database that does not match the running code is a restore
      // that has not worked — and Prisma answers it better than any hand-rolled
      // column comparison could.
      const diff = await run(
        [
          "prisma", "migrate", "diff",
          // ============ PRISMA 7 FLAGS, LEARNED BY RUNNING ==========
          //
          // Both flags this started with were removed in Prisma 7:
          // `--to-schema-datamodel` is now `--to-schema`, and `--from-url` is
          // gone entirely in favour of taking the datasource from the config
          // file. prisma.config.ts reads process.env.DATABASE_URL, and
          // dotenv does not overwrite a variable already set, so pointing it
          // at the replayed database is a matter of setting that one variable
          // for this one command.
          //
          // Worth recording rather than just fixing: the first version failed
          // with exit 1 and an empty message, which read exactly like drift.
          // The API had moved, which is what AGENTS.md warns about.
          "--from-config-datasource",
          "--to-schema", "prisma/schema.prisma",
          "--exit-code",
        ],
        { DATABASE_URL: pg.url },
      );
      // ============ THE FILTER IS PROVED BEFORE IT IS TRUSTED =====
      //
      // A synthetic diff carrying both kinds of block. If the harness filter
      // ever widens enough to swallow a real change, this fails here rather
      // than by silently reporting a drifted database as clean.
      const synthetic = [
        "[-] Removed tables\n  - _genesis_test_database",
        "[*] Changed the `Order` table\n  [-] Removed index on columns (storeId)",
      ].join("\n\n");
      const kept = driftExcludingHarness(synthetic);
      assert("the harness filter drops only the harness table",
        !kept.includes(HARNESS_ONLY) && kept.includes("Removed index on columns (storeId)"), kept);

      // Everything else counts. The first run found three differences and two
      // were real: an index the migrations created and this schema never
      // declared, and a unique constraint whose truncated name Prisma no
      // longer computed the same way. Both are fixed in schema.prisma — see
      // the comments there — and neither needed a migration.
      const realDrift = driftExcludingHarness(diff.out)
        .trim();

      // The exit code alone cannot answer this: it is 2 whenever ANYTHING
      // differs, the harness table included. It is still reported, because a
      // command that failed to run and a database that drifted look identical
      // in a bare assertion and need completely different fixes — the first
      // version of this file printed only the diff text and an removed flag
      // read exactly like drift.
      assert("a replayed database matches schema.prisma exactly",
        (diff.code === 0 || diff.code === 2) && realDrift === "",
        realDrift
          ? `drift:\n${realDrift.slice(0, 1200)}`
          : `exit ${diff.code}: ${diff.out.trim().slice(0, 400) || "(no output)"}`);
    }

    console.log("\n--- the restored database is usable, not merely shaped right ---\n");
    {
      // A schema that matches and cannot take a write is not a recovery. The
      // cheapest honest proof is the chain the business actually depends on:
      // an account, a business, and an order with a line item on it.
      const stamp = Date.now();
      const user = await pg.prisma.user.create({ data: { email: `restore-${stamp}@example.test` } });
      const store = await pg.prisma.store.create({
        data: { userId: user.id, name: "Restored", slug: `restore-${stamp}`, tagline: "t", description: "d" },
      });
      const order = await pg.prisma.order.create({
        data: {
          storeId: store.id, productName: "Cuff", quantity: 1, amountInCents: 3232,
          buyerEmail: `buyer-${stamp}@example.test`, paymentProvider: "STRIPE",
          externalOrderId: `cs_restore_${stamp}`,
          items: {
            create: [{
              productName: "Cuff", quantity: 1, unitPriceInCents: 3232,
              listInCents: 3232, subtotalInCents: 3232,
            }],
          },
        },
        include: { items: true },
      });
      assert("an account can be written", !!user.id);
      assert("a business can be written", !!store.id);
      assert("an order can be written", order.amountInCents === 3232);
      assert("and its line items with it", order.items.length === 1);

      // The constraint that protects the money path — proving indexes and
      // uniqueness came back too, not just columns.
      const duplicate = await pg.prisma.order
        .create({
          data: {
            storeId: store.id, productName: "Cuff", quantity: 1, amountInCents: 3232,
            buyerEmail: `buyer2-${stamp}@example.test`, paymentProvider: "STRIPE",
            externalOrderId: `cs_restore_${stamp}`,
          },
        })
        .then(() => "allowed")
        .catch(() => "refused");
      assert("and a duplicate provider order id is still refused", duplicate === "refused",
        "the unique constraint on (paymentProvider, externalOrderId) did not survive the replay");
    }

    console.log("\n--- what this run does NOT prove ---\n");
    console.log("  Neon's own restore. Taking a branch at a point in time needs a Neon");
    console.log("  API key and is recorded in EXTERNAL_BLOCKERS.md rather than faked —");
    console.log("  a mocked restore would prove nothing about a real one.");
    console.log("  What is proven: given a restored database, replaying this");
    console.log("  repository's migrations produces exactly the schema the code");
    console.log("  expects, and that schema takes real writes.\n");
  } finally {
    await pg.close();
  }

  for (const name of failed) console.log(`FAILED: ${name}`);
  console.log(`\n${failures} failed, ${passes} passed\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
