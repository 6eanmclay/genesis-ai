import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// DATED COMMITMENTS — J4_FOUNDATION.md's last non-blocked coverage gap:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-commitments-live.ts" -OutFile out.txt
//
// The capability: a deadline stated inside an uploaded document stops being a
// sentence in Asset.summary and becomes something J4 holds, can sort by, and
// carries into every reasoning path.
//
// WHAT THIS SUITE IS ACTUALLY DEFENDING. Not the arithmetic — the REFUSALS. A
// deadline is the one kind of fact where being confidently wrong is worse than
// saying nothing: an owner who trusts an invented renewal date misses the real
// one. So most of what follows asserts that something was NOT written.
//
// The model is never called here. planCommitments is the gate every extracted
// commitment passes through, so the rules are testable without a provider —
// which is the point of putting them in a pure function rather than a prompt.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const capture = (over: Partial<Record<string, unknown>> = {}) => ({
  title: "Lease renewal",
  kind: "lease",
  dueDate: "2026-12-01",
  counterparty: "Hartlepool Industrial Estates",
  amountInCents: 145_000,
  sourceQuote: "This lease shall terminate on 1 December 2026 unless renewed.",
  ...over,
});

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const {
    readDueDate,
    planCommitments,
    planCommitmentHorizon,
    recordCommitments,
    getCommitments,
  } = await import("@/lib/businessAssets/commitments");
  const { getBusinessUnderstanding } = await import("@/lib/businessModel/understanding");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  async function reset() {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
        AND tablename <> '_genesis_test_database'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
  }

  let n = 0;
  async function business(slug: string) {
    const user = await prisma.user.create({ data: { email: `${slug}-${++n}@example.test` } });
    return prisma.store.create({
      data: { userId: user.id, name: slug, slug, tagline: "t", description: "d", currency: "USD" },
    });
  }

  // ==========================================================================
  console.log("\n=== 1. A date, or nothing ===\n");
  // ==========================================================================
  check("a real date is a date", readDueDate("2026-12-01"), "2026-12-01");
  // The one that matters: Date.parse accepts this and rolls it to March 2nd,
  // silently moving a deadline by two days.
  check("30 February is refused, not rolled forward", readDueDate("2026-02-30"), null);
  check("31 April is refused", readDueDate("2026-04-31"), null);
  check("a month name is not a date", readDueDate("December 2026"), null);
  check("an unpadded date is refused", readDueDate("2026-2-3"), null);
  check("an empty string is refused", readDueDate(""), null);
  check("a leap day in a leap year is real", readDueDate("2028-02-29"), "2028-02-29");
  check("a leap day in a common year is not", readDueDate("2026-02-29"), null);

  // ==========================================================================
  console.log("\n=== 2. What planCommitments refuses to write ===\n");
  // ==========================================================================
  const ASSET = "asset-record-1";
  const planned = planCommitments({
    raw: [
      capture(),
      // "a twelve-month lease" — a term with no stated end. The prompt forbids
      // computing one; this is the code refusing to store one if it arrives.
      capture({ title: "Twelve month term", dueDate: "" }),
      capture({ title: "Insurance renewal", dueDate: "2026-13-01" }),
      // A date with nothing behind it. The quote is how the owner checks it.
      capture({ title: "Licence renewal", dueDate: "2027-03-15", sourceQuote: "   " }),
      capture({ title: "   ", dueDate: "2027-04-15" }),
      // The same deadline read twice out of one document.
      capture(),
      // Genuinely a second deadline in the same document.
      capture({ title: "Insurance renewal", kind: "insurance", dueDate: "2027-01-31" }),
    ],
    assetRecordId: ASSET,
    confidence: 0.9,
  });

  check("only the two real deadlines survive", planned.length, 2);
  check(
    "and they are the right two",
    planned.map((p) => p.data.title).sort(),
    ["Insurance renewal", "Lease renewal"]
  );
  assert(
    "a term with no stated end writes NOTHING",
    !planned.some((p) => p.data.title === "Twelve month term"),
    "not a record with a null date — no record"
  );
  assert("an impossible month writes nothing", !planned.some((p) => p.data.dueDate.startsWith("2026-13")));
  assert("a date with no quote writes nothing", !planned.some((p) => p.data.title === "Licence renewal"));
  assert("the same deadline read twice collapses to one", new Set(planned.map((p) => p.externalId)).size === 2);

  const lease = planned.find((p) => p.data.title === "Lease renewal")!;
  check("provenance points at the document", lease.data.sourceAssetRecordId, ASSET);
  assert("the sentence it was read from is kept", lease.data.sourceQuote.includes("1 December 2026"));
  check("confidence is carried, not hidden", lease.data.confidence, 0.9);

  const blankKind = planCommitments({
    raw: [capture({ kind: "  " })],
    assetRecordId: ASSET,
    confidence: null,
  });
  check("an unstated kind becomes 'other', never a guess", blankKind[0].data.kind, "other");
  check("an absent confidence stays absent", blankKind[0].data.confidence, null);

  // ==========================================================================
  console.log("\n=== 3. Persistence, and re-reading the same document ===\n");
  // ==========================================================================
  await reset();
  const store = await business("commitment-store");

  const firstWrite = await recordCommitments(store.id, planned);
  check("both were persisted", firstWrite.length, 2);

  const rows = await prisma.businessRecord.findMany({
    where: { storeId: store.id, entityType: "commitment" },
  });
  check("as ordinary BusinessRecord rows", rows.length, 2);
  check("under one source provider", [...new Set(rows.map((r) => r.sourceProvider))], ["genesis_upload"]);

  // THE UPSERT. Classifying the same file again must not double the owner's
  // deadlines — the stable key is what makes re-processing safe.
  await recordCommitments(store.id, planned);
  const afterRerun = await prisma.businessRecord.count({
    where: { storeId: store.id, entityType: "commitment" },
  });
  check("re-reading the same document writes no duplicates", afterRerun, 2);

  // A corrected date in the same document is a different commitment, not an
  // edit of the old one — and both being visible is the honest outcome.
  const corrected = planCommitments({
    raw: [capture({ dueDate: "2026-12-08" })],
    assetRecordId: ASSET,
    confidence: 0.9,
  });
  await recordCommitments(store.id, corrected);
  check("a different date is a different commitment", await prisma.businessRecord.count({
    where: { storeId: store.id, entityType: "commitment" },
  }), 3);

  // The registry validates these like any other synced record.
  const rejected = await recordCommitments(store.id, [
    // Deliberately malformed past the pure gate, to prove the schema is real.
    { externalId: "bad-1", data: { title: "No quote" } as never },
  ]);
  check("a record failing the registry schema is not written", rejected.length, 0);
  check("and nothing was left behind", await prisma.businessRecord.count({
    where: { storeId: store.id, entityType: "commitment" },
  }), 3);

  // ==========================================================================
  console.log("\n=== 4. The horizon — no threshold, only real days ===\n");
  // ==========================================================================
  const today = new Date("2026-08-21T00:00:00Z");
  const horizon = planCommitmentHorizon({
    commitments: [
      { recordId: "r1", data: { ...capture(), dueDate: "2026-08-01" } as never },
      { recordId: "r2", data: { ...capture(), dueDate: "2026-08-21" } as never },
      { recordId: "r3", data: { ...capture(), dueDate: "2026-12-01" } as never },
      { recordId: "r4", data: { ...capture(), dueDate: "2027-01-31" } as never },
      // A hand-edited row whose date is not a date. Skipped, never NaN.
      { recordId: "r5", data: { ...capture(), dueDate: "sometime" } as never },
    ],
    today,
  });

  check("what has passed is separate from what is coming", horizon.overdue.length, 1);
  check("due TODAY is upcoming — a deadline you can still meet is not missed", horizon.upcoming.length, 3);
  check("days are real, and negative when passed", horizon.overdue[0].daysUntilDue, -20);
  check("today is zero days away", horizon.upcoming[0].daysUntilDue, 0);
  check("102 days to the lease", horizon.upcoming[1].daysUntilDue, 102);
  check("soonest first", horizon.upcoming.map((c) => c.dueDate), ["2026-08-21", "2026-12-01", "2027-01-31"]);
  check("the next real deadline", horizon.nextDueDate, "2026-08-21");
  assert("an unparseable stored date is skipped, never NaN days away",
    [...horizon.overdue, ...horizon.upcoming].every((c) => Number.isFinite(c.daysUntilDue)));
  assert("no bucket claims to know what 'soon' means",
    !Object.keys(horizon).some((k) => /soon|urgent|late|overdueSoon/.test(k) && k !== "overdue"));

  // ==========================================================================
  console.log("\n=== 5. It reaches what J4 actually knows ===\n");
  // ==========================================================================
  const live = await getCommitments(store.id);
  check("every persisted commitment is read back", live.overdue.length + live.upcoming.length, 3);
  assert("each one still points at its document",
    [...live.overdue, ...live.upcoming].every((c) => c.sourceAssetRecordId === ASSET));
  assert("each one still carries its sentence",
    [...live.overdue, ...live.upcoming].every((c) => c.sourceQuote.length > 0));

  const understanding = await getBusinessUnderstanding(store.id);
  check(
    "BusinessUnderstanding carries them",
    understanding.commitments.overdue.length + understanding.commitments.upcoming.length,
    3
  );
  check("and the same next deadline", understanding.commitments.nextDueDate, live.nextDueDate);

  // ==========================================================================
  console.log("\n=== 6. One business never sees another's deadlines ===\n");
  // ==========================================================================
  const other = await business("other-store");
  const theirs = await getBusinessUnderstanding(other.id);
  check("a business with no documents has no commitments", theirs.commitments.upcoming.length, 0);
  check("and no overdue ones either", theirs.commitments.overdue.length, 0);
  check("and no next deadline — null, not a borrowed date", theirs.commitments.nextDueDate, null);

  const empty = await getCommitments(other.id);
  check("the read is scoped to the store", empty.upcoming.length + empty.overdue.length, 0);

  await reset();
  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All commitment assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
