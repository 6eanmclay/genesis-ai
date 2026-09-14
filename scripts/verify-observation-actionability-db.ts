import "@/scripts/lib/allowServerOnly";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prismaSystem } from "@/lib/prisma";
import { officeActionForObservation } from "@/lib/j4/officeActions";
import { sectionFor } from "@/lib/j4/officeSections";
import { observationNeedFor, declaredObservationNeedKeys } from "@/lib/j4/observationNeeds";
import { J4_CANNOT } from "@/lib/j4/boundaries";

// WHAT AN OBSERVATION NEEDS DECIDES WHERE IT GOES:
//
//   npx tsx scripts/run-db-suites.ts observation-actionability
//
// ============ THE CONTRACT (2026-09-14) ================================
//
// officeActionForObservation had two answers — `open` with an href, `none`
// without — and sectionFor maps BOTH to "noticed". So every observation, of
// every kind, rendered under "I have seen these and cannot act on them yet."
//
// The five rows below are the REAL ones the natural cron produced in
// production on 2026-09-14, copied verbatim. Every one of them landed in
// "noticed", including the one whose own summary reads "I cannot send them: no
// email provider is connected yet" — a row naming exactly what the owner must
// do, under a heading saying nothing could be done.
//
// THROUGH THE DATABASE, NOT PAST IT. The rows are written and read back rather
// than handed to the mapper as literals, so what is asserted is a real row.
//
// The select here is a COPY of the Office's, not the Office's own — that file
// is "use server" and cannot export a constant — so this suite would not by
// itself notice dedupeKey being dropped from that query, at which point every
// row silently returns to "noticed" with nothing failing. Section 5 checks
// that against the source instead, which is the honest instrument for a mirror
// this file cannot import.
//
// THE FOUR CATEGORIES ARE UNCHANGED. Asserted, because the fix must not have
// been a fifth bucket in disguise.

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
function eq(label: string, actual: unknown, expected: unknown): void {
  assert(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Verbatim from the 2026-09-14 production read. */
const PRODUCTION_ROWS = [
  {
    dedupeKey: "commerce:orders_shipped_untracked",
    actionHref: "/dashboard/orders",
    summary: "1 order is marked shipped with no tracking number, so the buyer has no way to follow it.",
    expectMissing: "information",
  },
  {
    dedupeKey: "commerce:receipts_unsent",
    actionHref: "/dashboard/connections",
    summary:
      "11 buyers have not been sent an order confirmation — the earliest ordered 56 days ago. I cannot send them: no email provider is connected yet.",
    expectMissing: "permission",
  },
  {
    dedupeKey: "commerce:payment_connection_broken",
    actionHref: "/dashboard/payments",
    summary: "Your Stripe connection is not working, so this store cannot reliably take payments.",
    expectMissing: "permission",
  },
] as const;

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  const user = await prismaSystem.user.create({ data: { email: `oa-${stamp}@example.test` } });
  const store = await prismaSystem.store.create({
    data: { userId: user.id, name: "Copper Works", slug: `oa-${stamp}`, currency: "USD" },
  });

  // The five real rows: two stores' worth of untracked/receipts plus the one
  // payment row, collapsed onto one store because placement is per row.
  const rows = [
    ...PRODUCTION_ROWS,
    // The second store's duplicates of two families, to prove placement is a
    // property of the condition rather than of one row.
    {
      dedupeKey: "commerce:orders_shipped_untracked_dup",
      actionHref: "/dashboard/orders",
      summary: "1 order is marked shipped with no tracking number, so the buyer has no way to follow it.",
      expectMissing: null,
    },
  ];
  for (const r of rows) {
    await prismaSystem.genesisObservation.create({
      data: {
        storeId: store.id,
        dedupeKey: r.dedupeKey,
        genesisState: "urgent",
        summary: r.summary,
        actionHref: r.actionHref,
        status: "ACTIVE",
      },
    });
  }
  // A producer that has declared nothing, with a destination.
  await prismaSystem.genesisObservation.create({
    data: {
      storeId: store.id, dedupeKey: "integration:quickbooks_stale", genesisState: "opportunity",
      summary: "QuickBooks has not synced in a while.", actionHref: "/dashboard/connections", status: "ACTIVE",
    },
  });
  // And one with neither.
  await prismaSystem.genesisObservation.create({
    data: {
      storeId: store.id, dedupeKey: "discovery:something", genesisState: "opportunity",
      summary: "A thing J4 noticed.", actionHref: null, status: "ACTIVE",
    },
  });

  // THE SAME SELECT THE OFFICE USES. A field missing here is the regression.
  const read = await prismaSystem.genesisObservation.findMany({
    where: { storeId: store.id, status: "ACTIVE" },
    select: { id: true, genesisState: true, summary: true, actionHref: true, dedupeKey: true, firstNoticedAt: true },
  });
  const byKey = new Map(read.map((r) => [r.dedupeKey, r]));

  // ====================================================================
  console.log("\n1. The three real Commerce conditions ask the owner\n");
  // ====================================================================
  for (const row of PRODUCTION_ROWS) {
    const o = byKey.get(row.dedupeKey)!;
    const action = officeActionForObservation(o, "/b/copper");
    const section = sectionFor(action);

    eq(`${row.dedupeKey}: needs the owner`, action.kind, "needs_owner");
    eq(`  ${row.dedupeKey}: lands in needs_you`, section, "needs_you");
    if (action.kind === "needs_owner") {
      // WHICH KIND of missing thing — the distinction the Office was built to
      // carry. A tracking number is information; a connection is permission.
      eq(`  ${row.dedupeKey}: missing is ${row.expectMissing}`, action.missing, row.expectMissing);
      assert(`  ${row.dedupeKey}: says what is needed`, action.what.trim().length > 0, action.what);
      assert(`  ${row.dedupeKey}: and why J4 cannot`, action.because.trim().length > 0, action.because);
      // THE DESTINATION IS STILL THE PRODUCER'S, rebased onto this business.
      assert(`  ${row.dedupeKey}: keeps the producer's own destination`,
        action.provideAt?.href === row.actionHref.replace("/dashboard", "/b/copper"),
        action.provideAt?.href ?? "(none)");
    }
  }

  // ====================================================================
  console.log("\n2. Nothing declared falls through, unchanged\n");
  // ====================================================================
  {
    // THE SAFE DEFAULT. An undeclared key must behave exactly as it did before
    // this existed — it must not be quietly asserted non-actionable, and it
    // must not be dragged into needs_you.
    const withHref = byKey.get("integration:quickbooks_stale")!;
    const a = officeActionForObservation(withHref, "/b/copper");
    eq("an undeclared key with a destination still opens", a.kind, "open");
    eq("  and stays in noticed", sectionFor(a), "noticed");

    const bare = byKey.get("discovery:something")!;
    const b = officeActionForObservation(bare, "/b/copper");
    eq("an undeclared key with no destination is still none", b.kind, "none");
    eq("  and stays in noticed", sectionFor(b), "noticed");

    // A COMMERCE-LOOKING KEY NOBODY DECLARED. Proves the lookup is by exact
    // key and not by prefix — a producer opts in per condition.
    const near = byKey.get("commerce:orders_shipped_untracked_dup")!;
    const c = officeActionForObservation(near, "/b/copper");
    eq("an undeclared commerce key is not swept in by its prefix", c.kind, "open");
    eq("  and stays in noticed", sectionFor(c), "noticed");
  }

  // ====================================================================
  console.log("\n3. The registry cannot describe a J4 that does not exist\n");
  // ====================================================================
  {
    const known = new Set(J4_CANNOT.map((b) => b.id));
    for (const key of declaredObservationNeedKeys()) {
      const need = observationNeedFor(key)!;
      assert(`${key} cites a boundary that exists`, known.has(need.boundary), need.boundary);
    }
    assert("at least the three measured conditions are declared",
      declaredObservationNeedKeys().length >= 3, declaredObservationNeedKeys().join(", "));
    // THE STALE FAMILY IS DELIBERATELY ABSENT — no row has ever been seen, and
    // a boundary is a claim about the world rather than about the backlog.
    eq("orders_unfulfilled_stale is deliberately undeclared",
      observationNeedFor("commerce:orders_unfulfilled_stale"), null);
  }

  // ====================================================================
  console.log("\n4. Still four categories\n");
  // ====================================================================
  {
    // There is no exported list of sections to count, so the invariant is
    // checked the way it actually matters: every action kind the Office can
    // produce still maps into the same four buckets (or nowhere, for
    // `internal`). A fifth category would show up here as a fifth value.
    const everyKind = [
      { kind: "needs_owner", missing: "information", what: "w", because: "b" },
      { kind: "execute", label: "l", intent: "approve", offer: "act" },
      { kind: "execute", label: "l", intent: "approve", offer: "decide" },
      { kind: "open", label: "Open", href: "/x" },
      { kind: "none", because: "b" },
      { kind: "internal", because: "b" },
    ] as unknown as Parameters<typeof sectionFor>[0][];
    const produced = [...new Set(everyKind.map((a) => sectionFor(a)).filter((x) => x !== null))].sort().join(",");
    eq("every action kind still lands in the same four sections",
      produced, "decide,needs_you,noticed,ready_to_go");
  }

  // ====================================================================
  console.log("\n5. The Office actually asks for the key\n");
  // ====================================================================
  {
    // A MIRROR, GUARDED. app/j4/intelligence-actions.ts is "use server", so it
    // cannot export the select for this suite to share — and without dedupeKey
    // in it, observationNeedFor is handed undefined for every row and the whole
    // mapping above silently reverts. Asserted against the source because that
    // is the only place the mirror is visible.
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(process.cwd(), "app", "j4", "intelligence-actions.ts"), "utf8");
    const query = src.slice(src.indexOf("prisma.genesisObservation.findMany"));
    const selectBlock = query.slice(0, query.indexOf("orderBy"));
    assert("the Office's observation query selects dedupeKey",
      /dedupeKey:\s*true/.test(selectBlock),
      selectBlock.replace(/\s+/g, " ").slice(0, 200));
  }

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failures > 0) {
    console.log("\nFAILED:");
    for (const line of failed) console.log(`  ${line}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaSystem.$disconnect();
  });
