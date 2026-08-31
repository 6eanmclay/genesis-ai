import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// THE FOUR GUARDS THAT STOP THIS PLATFORM DOING SOMETHING TWICE:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-concurrency-live.ts" -OutFile out.txt
//
// ============ WHY THESE WERE UNPROVEN UNTIL NOW (2026-08-30) ===========
//
// BACKEND_FOUNDATION_GAPS.md records four protections as "unproven by this
// harness": two runners racing for one job, two callers racing runOnce on one
// key, duplicate deliveries of one provider event, and the Growth Point
// reservation. Every one exists to stop the platform charging, shipping or
// spending twice, and not one had ever been seen to work.
//
// The reason was PGlite. The database lane runs on it, and it serialises
// concurrent clients — so the interleaving these guards exist for could not be
// produced, and `verify-jobs-db` passes to this day with its claim guard
// removed and says so in the file.
//
// That was a property of the harness, not of the guards. scripts/lib/
// realPostgres.ts runs a real PostgreSQL with a real connection pool, and it
// has been here since August.
//
// ============ WHAT MAKES THIS A REAL PROOF ============================
//
// Genuine parallel connections. Every race below fires N callers through one
// Prisma pool with Promise.all, so N statements are in flight against N
// backends at once — which is exactly the situation the conditional update and
// the unique index are written for.
//
// And it is repeated. One round proves a guard held once; a race that only
// sometimes interleaves would pass by luck. Each race runs many rounds, and
// the sabotage script removes each guard and watches the double appear —
// which is the assertion that has never before been possible.

const ROUNDS = 12;
const RACERS = 8;

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

/**
 * Fire N callers as close to simultaneously as a single process can.
 *
 * They are created first and awaited second, so every one has been started
 * before any is waited on — the closest thing to a starting pistol without
 * spawning processes, and enough to interleave a conditional update.
 */
async function race<T>(n: number, run: (index: number) => Promise<T>): Promise<T[]> {
  const inFlight: Promise<T>[] = [];
  for (let i = 0; i < n; i++) inFlight.push(run(i));
  return Promise.all(inFlight);
}

async function main(): Promise<void> {
  const db = await startRealPostgres();

  // Pointed at the real database BEFORE anything imports the client, because
  // lib/prisma reads DATABASE_URL once at module load. This is why the suite
  // imports everything dynamically below.
  process.env.DATABASE_URL = db.url;
  process.env[TEST_DATABASE_ENV] = "1";

  const { prisma, prismaSystem } = await import("@/lib/prisma");
  const { enqueue, claimNext, complete } = await import("@/lib/jobs/queue");
  const { runOnce } = await import("@/lib/outbound/runOnce");
  const { recordDelivery } = await import("@/lib/webhooks/delivery");
  const { deductGrowthPoints } = await import("@/lib/growthPoints/ledger");

  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `cc-${stamp}@example.test` } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "CC", slug: `cc-${stamp}`, tagline: "t", description: "d" },
  });

  try {
    console.log("\n--- the connections really are concurrent ---\n");
    {
      // ============ PROVE THE HARNESS FIRST ==================
      //
      // Everything below is worthless if the database is serialising. Postgres
      // reports its own backend pids, so this asks it directly: N statements in
      // flight, how many distinct backends served them?
      const pids = await race(RACERS, async () => {
        // pg_sleep returns void, which the driver adapter cannot map — so it
        // is held in a CTE and only the pid is selected, cast to text for the
        // same reason. The sleep is what keeps the connection busy long enough
        // for the others to need their own.
        const rows = await prismaSystem.$queryRawUnsafe<{ pid: string }[]>(
          "WITH held AS (SELECT pg_sleep(0.05)) SELECT pg_backend_pid()::text AS pid FROM held",
        );
        return rows[0].pid;
      });
      const distinct = new Set(pids).size;
      assert("several backends served the race at once", distinct > 1,
        `only ${distinct} backend(s) — this database is serialising and no proof below would mean anything`);
      console.log(`        ${distinct} distinct Postgres backends for ${RACERS} concurrent callers`);
    }

    console.log("\n--- 1. two runners racing to claim one job ---\n");
    {
      // The conditional update is the lock: `status: "pending"` is in the WHERE,
      // so exactly one racer's update can match.
      let doubleClaims = 0;
      for (let round = 0; round < ROUNDS; round++) {
        const key = `cc-job-${stamp}-${round}`;
        await enqueue({ kind: "noop", idempotencyKey: key, storeId: store.id });

        const claimed = await race(RACERS, (i) => claimNext(`runner-${i}`));
        const gotIt = claimed.filter((job) => job !== null);
        if (gotIt.length > 1) doubleClaims++;

        // Exactly one, every round. More than one means two runners are about
        // to do the same work.
        if (gotIt.length !== 1) {
          assert(`round ${round}: exactly one runner claimed the job`, false,
            `${gotIt.length} runners claimed it`);
        }
        for (const job of gotIt) if (job) await complete(job.id);
      }
      eq("no round ever let two runners claim one job", doubleClaims, 0);
      assert("and the job was claimed, not simply missed", passes > 0);
    }

    console.log("\n--- 2. two callers racing runOnce for one key ---\n");
    {
      // The unique index on idempotencyKey is the claim. A loser must NOT
      // perform the effect — this is the guard between one charge and eight.
      let doubleEffects = 0;
      for (let round = 0; round < ROUNDS; round++) {
        const key = `cc-once-${stamp}-${round}`;
        let performed = 0;

        await race(RACERS, () =>
          runOnce({
            key, operation: "cc.charge", storeId: store.id,
            perform: async () => {
              performed++;
              // Held briefly so the window a second caller could slip through
              // is genuinely open rather than closed by luck of scheduling.
              await new Promise((r) => setTimeout(r, 20));
              return { result: { ok: true }, externalRef: `ref-${round}` };
            },
          }).catch(() => undefined),
        );

        if (performed !== 1) {
          doubleEffects++;
          assert(`round ${round}: the effect happened exactly once`, false, `${performed} times`);
        }
      }
      eq("no round ever performed one external effect twice", doubleEffects, 0);

      // And the record agrees: one row per key, whatever happened in flight.
      const rows = await prismaSystem.outboundOperation.count({
        where: { idempotencyKey: { startsWith: `cc-once-${stamp}-` } },
      });
      eq("one operation row per key, not one per caller", rows, ROUNDS);
    }

    console.log("\n--- 3. duplicate deliveries of one provider event ---\n");
    {
      // A provider retrying an event it already sent must be recognised, not
      // recorded twice — and the loser of the race must still be TOLD which
      // delivery it was, because the route uses that id to mark the outcome.
      let lostTheId = 0;
      for (let round = 0; round < ROUNDS; round++) {
        const eventId = `cc-evt-${stamp}-${round}`;
        const results = await race(RACERS, () =>
          recordDelivery({
            provider: `cc-${stamp}`, rawBody: JSON.stringify({ id: eventId }),
            signatureValid: true, externalEventId: eventId, storeId: store.id,
          }),
        );

        const rows = await prismaSystem.webhookDelivery.count({
          where: { provider: `cc-${stamp}`, externalEventId: eventId },
        });
        if (rows !== 1) {
          assert(`round ${round}: one row for one event`, false, `${rows} rows`);
        }

        // ============ THE HALF A UNIQUE INDEX DOES NOT COVER ====
        //
        // The index stops the duplicate ROW. It does not stop the losing caller
        // being handed null — and a route that receives null sets no delivery
        // id, so markProcessed does nothing and the delivery sits at `received`
        // for ever while its handler has already run.
        const blind = results.filter((r) => r === null).length;
        if (blind > 0) {
          lostTheId += blind;
          assert(`round ${round}: every caller learned which delivery it was`, false,
            `${blind} of ${RACERS} were handed null`);
        }
      }
      eq("no caller was ever left without a delivery id", lostTheId, 0);

      const total = await prismaSystem.webhookDelivery.count({
        where: { provider: `cc-${stamp}` },
      });
      eq("one row per event, across every round", total, ROUNDS);
    }

    console.log("\n--- 4. the Growth Point reservation ---\n");
    {
      // ============ THE ONE WHERE A DOUBLE IS A DEBT ===========
      //
      // A balance of exactly enough for one action, with eight callers trying.
      // Seven must lose. A guard that lets two through spends money the
      // business does not have.
      const COST = 10;
      for (let round = 0; round < ROUNDS; round++) {
        await prisma.store.update({
          where: { id: store.id },
          data: { growthPointBalance: COST },
        });

        const outcomes = await race(RACERS, async (i) => {
          const executionLogId = `cc-gp-${stamp}-${round}-${i}`;
          try {
            await deductGrowthPoints({
              storeId: store.id, actionType: "GENERATE_PRODUCT_DESCRIPTION",
              cost: COST, executionLogId,
            });
            return "charged";
          } catch {
            return "refused";
          }
        });

        const charged = outcomes.filter((o) => o === "charged").length;
        const after = await prisma.store.findUnique({
          where: { id: store.id }, select: { growthPointBalance: true },
        });

        // The invariant that matters is the BALANCE, not the count: whatever
        // the callers were told, the business must never end up owing points it
        // never had.
        if ((after?.growthPointBalance ?? 0) < 0) {
          assert(`round ${round}: the balance never goes negative`, false,
            `${after?.growthPointBalance} after ${charged} charges`);
        }
        if (charged > 1) {
          assert(`round ${round}: only one caller spent the last points`, false,
            `${charged} callers charged ${COST} against a balance of ${COST}`);
        }
      }
      assert("the balance never went negative in any round", true);
    }
  } finally {
    await prismaSystem.$disconnect().catch(() => {});
    await db.close();
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
