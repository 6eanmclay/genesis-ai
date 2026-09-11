import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// WHAT A SECOND ASSEMBLY WOULD COST, MEASURED BEFORE DECIDING (2026-09-10):
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/measure-office-assembly.ts" -OutFile out.txt
//
// Sean: "I want the double-assembly cost measured in a production-like
// environment before we accept it... Do not optimize prematurely just because
// two assemblies exist."
//
// ============ WHAT THIS CAN AND CANNOT TELL YOU =======================
//
// The 921ms baseline was measured against PRODUCTION, read by read. This runs
// against an in-process Postgres on localhost, so its ABSOLUTE numbers are not
// production numbers and must not be compared to 921 directly.
//
// Neon is a network hop per query; localhost is not. That gap does not scale
// the numbers uniformly either - it penalises a path by how many ROUND TRIPS it
// makes, not by how much work it does.
//
// ============ AND THE FIRST VERSION OF THIS PARAGRAPH WAS WRONG ========
//
// It said the RATIO between the assembler and the Office's own reads would
// transfer. The run disproved it, which is the most useful thing this script
// has done so far:
//
//                       production      localhost      collapsed by
//     Office's 6 reads      499 ms          5 ms            ~100x
//     the assembler         921 ms        156 ms              ~6x
//     ratio                  1.85           31
//
// Localhost removes the round trips that dominate the Office's reads and
// leaves the assembler's actual work standing. So a progressive-tier delta
// read off this run would be wrong by a factor of two, in the direction that
// makes the change look worse than it is.
//
// WHAT ACTUALLY TRANSFERS, and all that should be quoted from here:
//
//   - reuse saves exactly ONE WHOLE ASSEMBLY. Structural: (a) runs the
//     assembler twice and (b) runs it once, whatever one costs.
//   - the derivation is free. A pure function over data already in memory is
//     0 ms on any host.
//   - the payload bytes. Network-independent, so these ARE production numbers.
//
// The progressive-tier delta must be derived from the production baselines
// instead, and the report says so rather than quoting a local number as if it
// were a production one.
//
// NOT A PASS/FAIL SUITE. It prints numbers. Inventing a threshold here would be
// the made-up figure this codebase refuses elsewhere.

const uniq = () => Math.random().toString(36).slice(2);

/** Median of several runs. One sample of a database call is noise. */
async function sample<T>(label: string, runs: number, fn: () => Promise<T>): Promise<number> {
  await fn(); // warm: never measure connection setup
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    await fn();
    times.push(Number(process.hrtime.bigint() - t) / 1_000_000);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(
    `  ${label.padEnd(52)} ${median.toFixed(0).padStart(6)} ms   (min ${times[0].toFixed(0)}, max ${times[times.length - 1].toFixed(0)})`,
  );
  return median;
}

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  // Before any product module loads - lib/prisma builds its adapter from
  // DATABASE_URL at module-evaluation time.
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { prisma } = await import("@/lib/prisma");
  const { getBusinessUnderstanding } = await import("@/lib/businessModel/understanding");
  const { getPendingApprovals } = await import("@/lib/dashboard/pendingApprovals");
  const { getOpenTasks } = await import("@/lib/dashboard/tasks");
  const { getHandledSince } = await import("@/lib/dashboard/handled");
  const { officeFacts } = await import("@/lib/j4/officeFacts");
  const { buildBriefing, summariseHandled } = await import("@/lib/j4/officeBriefing");
  const { officeWork } = await import("@/lib/j4/officeWork");
  const { officeActionForObservation, officeActionForExplanation } = await import("@/lib/j4/officeActions");

  // ============ A BUSINESS THE SIZE OF A REAL ONE =====================
  //
  // The Office cardinalities are the ones measured in production and recorded
  // in lib/j4/officeActions.ts - 53 ideas, 34 information, 158 explanations -
  // rather than round numbers chosen to look plausible.
  const user = await prisma.user.create({ data: { email: `oa-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Copper & Coil", slug: `oa-${uniq()}`, tagline: "Hand-wound rings" },
  });

  const products = [];
  for (let i = 0; i < 120; i++) {
    products.push(
      await prisma.product.create({
        data: { storeId: store.id, name: `Product ${i}`, priceInCents: 1000 + i, active: true },
      }),
    );
  }
  for (let i = 0; i < 400; i++) {
    await prisma.order.create({
      data: {
        storeId: store.id,
        productId: products[i % products.length].id,
        productName: `Product ${i % products.length}`,
        amountInCents: 1000 + i,
        buyerEmail: `buyer${i % 50}@oa.test`,
        paymentProvider: "STRIPE",
        externalOrderId: `o-${uniq()}-${i}`,
        createdAt: new Date(Date.now() - (i % 60) * 86_400_000),
      },
    });
  }
  for (let i = 0; i < 87; i++) {
    await prisma.genesisObservation.create({
      data: {
        storeId: store.id,
        dedupeKey: `d-${uniq()}-${i}`,
        genesisState: i < 53 ? "opportunity" : "urgent",
        summary: `Observation ${i} about something in the business that J4 noticed.`,
        actionHref: i % 3 === 0 ? "/dashboard/connections" : null,
        status: "ACTIVE",
      },
    });
  }
  for (let i = 0; i < 158; i++) {
    await prisma.cognitiveOutput.create({
      data: {
        storeId: store.id,
        kind: "explanation",
        summary: `Explanation ${i}: why something in the business is the way it is.`,
        actionHref: null,
        status: "ACTIVE",
      },
    });
  }

  console.log(`\n=== 120 products, 400 orders, 87 observations, 158 explanations ===\n`);
  console.log("Localhost Postgres. Absolute numbers are NOT production numbers.\n");

  const RUNS = 5;

  // ---- 1. the assembler by itself ----------------------------------------
  console.log("--- 1. getBusinessUnderstanding() alone ---\n");
  const understandingMs = await sample("getBusinessUnderstanding", RUNS, () =>
    getBusinessUnderstanding(store.id, { viewerUserId: user.id }),
  );

  // ---- 2. the Office's own progressive reads -----------------------------
  //
  // Exactly what loadOfficeIntelligence does today: six reads in one
  // Promise.all, so the tier costs the SLOWEST of them, not their sum.
  const officeReads = () =>
    Promise.all([
      prisma.genesisObservation.findMany({
        where: { storeId: store.id, status: "ACTIVE" },
        select: { id: true, genesisState: true, summary: true, actionHref: true, firstNoticedAt: true },
        orderBy: { firstNoticedAt: "desc" },
      }),
      prisma.cognitiveOutput.findMany({
        where: { storeId: store.id, kind: "explanation", status: "ACTIVE" },
        select: { id: true, summary: true, actionHref: true },
        orderBy: { generatedAt: "desc" },
      }),
      getPendingApprovals(store.id),
      getOpenTasks(store.id),
      prisma.product.count({ where: { storeId: store.id, active: true } }),
      getHandledSince(store.id, 14),
    ]);

  console.log("\n--- 2. the Office progressive tier ---\n");
  const officeNowMs = await sample("TODAY: six reads in parallel", RUNS, officeReads);

  // WITH the understanding added to the SAME Promise.all. This is the number
  // that decides the user-facing cost: if they run in parallel, the tier costs
  // the slower of the two rather than their sum.
  const officeProposed = () =>
    Promise.all([officeReads(), getBusinessUnderstanding(store.id, { viewerUserId: user.id })]);
  const officeProposedMs = await sample("PROPOSED: those six + understanding, parallel", RUNS, officeProposed);

  // The sequential shape, for contrast - what it would cost if somebody awaited
  // the understanding before starting the Office's reads.
  const officeSequentialMs = await sample("if it were SEQUENTIAL instead (do not do this)", RUNS, async () => {
    await getBusinessUnderstanding(store.id, { viewerUserId: user.id });
    await officeReads();
  });

  // ---- 3. the combined path ----------------------------------------------
  //
  // The owner opens the Office (progressive) and THEN opens Understanding
  // (on-demand). (a) assembles twice; (b) reuses the first assembly.
  console.log("\n--- 3. Office, then Understanding opened ---\n");
  const twiceMs = await sample("(a) assemble twice: Office + Understanding", RUNS, async () => {
    await officeProposed();
    await getBusinessUnderstanding(store.id, { viewerUserId: user.id });
  });
  const onceMs = await sample("(b) reuse the first assembly", RUNS, officeProposed);

  // ---- 4. the derivation itself ------------------------------------------
  console.log("\n--- 4. the pure work layer ---\n");
  const u = await getBusinessUnderstanding(store.id, { viewerUserId: user.id });
  const handled = summariseHandled(await getHandledSince(store.id, 14), "/dashboard");
  const emptyState = { decisions: [], observations: [], tasks: [], handled };
  const workMs = await sample("officeWork() derivation (no database)", RUNS, async () =>
    officeWork(u, emptyState, "/dashboard"),
  );

  // ---- 5. payload -------------------------------------------------------
  //
  // Network-independent, so unlike the durations above these bytes ARE real.
  console.log("\n--- 5. payload, transitional duplication included ---\n");
  const [observations, explanations, approvals, tasks, productCount, handledRaw] = await officeReads();
  const ideas = observations.filter((o) => o.genesisState === "opportunity");
  const urgent = observations.filter((o) => o.genesisState === "urgent");
  // Derived before the legacy payload, because officeFacts now reads the same
  // work list the Office's sections filter rather than taking loose counts.
  const handledSummary = summariseHandled(handledRaw, "/dashboard");
  const work = officeWork(u, { decisions: [], observations: [], tasks: [], handled: handledSummary }, "/dashboard");
  const legacy = {
    briefingItems: buildBriefing(
      { decisions: approvals.map((a) => ({ id: a.id, summary: a.summary, rationale: a.rationale, createdAt: a.createdAt })), observations },
      "/dashboard",
    ),
    handled: handledSummary,
    facts: officeFacts(
      { activeProducts: productCount, openTasks: tasks.length, opportunities: ideas.length },
      "/dashboard",
      work,
    ),
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, summary: t.summary, href: t.actionHref, priority: t.priority })),
    ideas: ideas.map((o) => ({ id: o.id, summary: o.summary, href: officeActionForObservation(o, "/dashboard").kind === "open" ? "x" : null })),
    decisions: approvals.map((a) => ({ id: a.id, summary: a.summary, createdAt: a.createdAt.toISOString(), href: null })),
    information: [
      ...urgent.map((o) => ({ id: o.id, summary: o.summary, href: null, kind: "urgent" })),
      ...explanations.map((e) => ({ id: e.id, summary: e.summary, href: officeActionForExplanation(e, "/dashboard").kind === "open" ? "x" : null, kind: "curiosity" })),
    ],
  };

  const legacyBytes = Buffer.byteLength(JSON.stringify(legacy));
  const workBytes = Buffer.byteLength(JSON.stringify(work));
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`  legacy OfficeIntelligence fields                      ${kb(legacyBytes).padStart(9)}`);
  console.log(`  new work list (transitional, carried alongside)       ${kb(workBytes).padStart(9)}`);
  console.log(`  combined during the transition                        ${kb(legacyBytes + workBytes).padStart(9)}`);
  console.log(`  growth                                                ${((workBytes / legacyBytes) * 100).toFixed(0)}%`);
  console.log(`  work items: ${work.items.length}`);

  // ---- the numbers that decide -------------------------------------------
  console.log("\n=== WHAT THIS SAYS ===\n");
  const parallelCost = officeProposedMs - officeNowMs;
  const sequentialCost = officeSequentialMs - officeNowMs;
  const secondAssemblyCost = twiceMs - onceMs;
  console.log(`  understanding / Office reads ratio            ${(understandingMs / officeNowMs).toFixed(2)}x`);
  console.log(`  progressive tier, added cost IN PARALLEL      ${parallelCost >= 0 ? "+" : ""}${parallelCost.toFixed(0)} ms`);
  console.log(`  the same, if it were sequential               ${sequentialCost >= 0 ? "+" : ""}${sequentialCost.toFixed(0)} ms`);
  console.log(`  the SECOND assembly, on the on-demand path    ${secondAssemblyCost >= 0 ? "+" : ""}${secondAssemblyCost.toFixed(0)} ms`);
  console.log(`  the derivation itself                         ${workMs.toFixed(1)} ms`);
  console.log(
    `\n  parallel cost as a share of the assembler:   ${((parallelCost / understandingMs) * 100).toFixed(0)}%`,
  );
  console.log(
    `  (0% would mean the Office's own reads already cover it; 100% would mean it is added end to end)\n`,
  );

  await prisma.$disconnect();
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
