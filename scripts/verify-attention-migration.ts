import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startRealPostgres } from "@/scripts/lib/realPostgres";

// THE LEGACY DISMISSALS SURVIVE THE IDENTITY CHANGE (2026-09-13).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-attention-migration.ts" -OutFile out.txt
//
// ============ WHAT IS UNDER TEST =====================================
//
// The SQL that actually ships. This suite READS
// prisma/migrations/20260913120000_attention_canonical_identity/migration.sql,
// takes its UPDATE statements, and runs those against a seeded legacy
// population — so what is proven is the migration itself rather than a
// re-implementation of it that could drift from the file by a word.
//
// The ALTER and CREATE INDEX statements are not re-run: the test database has
// already had the whole migration applied, which is itself the proof that the
// schema half is valid SQL.
//
// Sean's requirement for this step, verbatim: "Existing deferred records must
// survive the identity migration without changing who is considered deferred
// or for how long."

const MIGRATION = join(
  process.cwd(), "prisma", "migrations", "20260913120000_attention_canonical_identity", "migration.sql",
);

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/**
 * The backfill statements, from the shipped file.
 *
 * Comments are stripped before splitting because a `--` line inside the file
 * mentions the word UPDATE, and a suite that ran its own prose would be
 * testing my writing rather than the migration.
 */
function backfillStatements(): string[] {
  const sql = readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.toUpperCase().startsWith("UPDATE"));
}

async function main(): Promise<void> {
  const db = await startRealPostgres();
  const prisma = db.prisma;
  try {
    const statements = backfillStatements();
    console.log("\n=== the shipped migration, as executed ===\n");
    check("the migration file yields backfill statements", statements.length === 3, `${statements.length} UPDATEs`);
    for (const s of statements) console.log(`      ${s.split("\n")[0]} …`);

    // ======================================================================
    console.log("\n=== 1. The legacy population, one of every shape ===\n");
    // ======================================================================
    const stamp = Date.now();
    const user = await prisma.user.create({
      data: { email: `mig-${stamp}@example.test`, name: "Sean McLay", password: "x" },
    });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Cubit & Coil", slug: `mig-${stamp}`, currency: "USD" },
    });
    // A SECOND BUSINESS, because every join is scoped by storeId and a
    // migration that ignored that would move one owner's deferral onto
    // another's record. It gets a record whose id collides with nothing and a
    // dismissal that must NOT be touched by the first store's rows.
    const otherStore = await prisma.store.create({
      data: { userId: user.id, name: "Other Shop", slug: `mig-other-${stamp}`, currency: "USD" },
    });

    const approval = await prisma.approvalRequest.create({
      data: {
        storeId: store.id, actionType: "update_store_content", input: {}, previousValues: {},
        summary: "Rewrite the search listing", rationale: "why", status: "PENDING_APPROVAL",
      },
    });
    const task = await prisma.task.create({
      data: {
        storeId: store.id, dedupeKey: `mig:task:${stamp}`, source: "manual",
        title: "Photograph the saucepan", summary: "s", context: {}, priority: "WARNING", status: "OPEN",
      },
    });
    // THE INTERESTING ONE: a dedupeKey that itself contains colons, which is
    // what the real ones look like. Anything that tried to split the
    // presentation id on ":" would take the wrong half of this.
    const obsDedupe = `genesis:opportunity:bios:${stamp}`;
    const observation = await prisma.genesisObservation.create({
      data: {
        storeId: store.id, dedupeKey: obsDedupe, genesisState: "opportunity",
        summary: "Your bios are empty", status: "ACTIVE",
      },
    });
    // An observation in the OTHER store carrying the SAME dedupeKey. Legal —
    // the unique constraint is per store — and the trap for a join that
    // forgets storeId.
    const otherObservation = await prisma.genesisObservation.create({
      data: {
        storeId: otherStore.id, dedupeKey: obsDedupe, genesisState: "opportunity",
        summary: "Same condition, different business", status: "ACTIVE",
      },
    });

    const dismissedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days in
    const legacy = [
      { storeId: store.id, cardId: `proposal:${approval.id}`, what: "an approval" },
      { storeId: store.id, cardId: `task:${task.id}`, what: "a task" },
      { storeId: store.id, cardId: `observation:${obsDedupe}`, what: "an observation" },
      { storeId: store.id, cardId: `issue:some-issue-${stamp}`, what: "an issue (arrival-only)" },
      { storeId: store.id, cardId: `discovery:some-discovery-${stamp}`, what: "a discovery (arrival-only)" },
      { storeId: store.id, cardId: `observation:gone:${stamp}`, what: "an observation that no longer exists" },
      { storeId: otherStore.id, cardId: `observation:${obsDedupe}`, what: "the other business's own" },
    ];
    for (const row of legacy) {
      await prisma.dismissedAttentionCard.create({
        data: { storeId: row.storeId, cardId: row.cardId, dismissedAt },
      });
      console.log(`      ${row.what.padEnd(38)} ${row.cardId}`);
    }
    const beforeRows = await prisma.dismissedAttentionCard.findMany({
      where: { storeId: { in: [store.id, otherStore.id] } },
    });
    check("every legacy row starts with no canonical identity",
      beforeRows.every((r) => r.source === null && r.sourceId === null),
      `${beforeRows.length} rows`);

    // ======================================================================
    console.log("\n=== 2. The backfill maps what it can, and only that ===\n");
    // ======================================================================
    for (const s of statements) await prisma.$executeRawUnsafe(s);

    const byCard = async (storeId: string, cardId: string) =>
      prisma.dismissedAttentionCard.findFirst({ where: { storeId, cardId } });

    const a = await byCard(store.id, `proposal:${approval.id}`);
    check("an approval dismissal now names ApprovalRequest.id",
      a?.source === "approval" && a?.sourceId === approval.id, `${a?.source} ${a?.sourceId}`);
    const t = await byCard(store.id, `task:${task.id}`);
    check("a task dismissal now names Task.id",
      t?.source === "task" && t?.sourceId === task.id, `${t?.source} ${t?.sourceId}`);

    // THE ONE THE WHOLE STEP EXISTS FOR. The presentation id carried a
    // dedupeKey; the row now carries the observation's own id, resolved
    // through (storeId, dedupeKey) rather than by taking the string apart.
    const o = await byCard(store.id, `observation:${obsDedupe}`);
    check("an observation dismissal now names GenesisObservation.id",
      o?.source === "observation" && o?.sourceId === observation.id, `${o?.source} ${o?.sourceId}`);
    check("  and that is NOT the dedupeKey it was stored under",
      o?.sourceId !== obsDedupe && obsDedupe.includes(":"),
      "a dedupeKey containing colons could not have survived a split");

    // SCOPED BY BUSINESS. Same dedupeKey, different store, different row.
    const other = await byCard(otherStore.id, `observation:${obsDedupe}`);
    check("the other business's dismissal maps to ITS observation",
      other?.sourceId === otherObservation.id, `${other?.sourceId}`);
    check("  which is a different record entirely",
      other?.sourceId !== observation.id,
      "a join that forgot storeId would have collapsed these two");

    // ======================================================================
    console.log("\n=== 3. Nothing is dropped, and nothing is guessed ===\n");
    // ======================================================================
    const issue = await byCard(store.id, `issue:some-issue-${stamp}`);
    const discovery = await byCard(store.id, `discovery:some-discovery-${stamp}`);
    const orphan = await byCard(store.id, `observation:gone:${stamp}`);
    check("an issue dismissal survives, unmapped",
      issue !== null && issue.source === null, `source=${issue?.source}`);
    check("a discovery dismissal survives, unmapped",
      discovery !== null && discovery.source === null, `source=${discovery?.source}`);
    check("a dismissal whose record is gone survives, unmapped",
      orphan !== null && orphan.source === null, `source=${orphan?.source}`);
    const after = await prisma.dismissedAttentionCard.findMany({
      where: { storeId: { in: [store.id, otherStore.id] } },
    });
    check("no legacy row was deleted", after.length === legacy.length, `${after.length} of ${legacy.length}`);
    check("every row still carries its original cardId",
      after.every((r) => legacy.some((l) => l.cardId === r.cardId && l.storeId === r.storeId)),
      "the presentation id is kept, so the existing reader is untouched");

    // ======================================================================
    console.log("\n=== 4. Two dismissals never collapse onto one item ===\n");
    // ======================================================================
    const mapped = after.filter((r) => r.source !== null);
    const keys = mapped.map((r) => `${r.storeId}|${r.source}|${r.sourceId}`);
    check("every mapped row names a distinct item",
      new Set(keys).size === keys.length, `${keys.length} mapped, ${new Set(keys).size} distinct`);
    check("  and four of the seven mapped, which is the expected split",
      mapped.length === 4, `${mapped.length} mapped, ${after.length - mapped.length} left alone`);

    // ======================================================================
    console.log("\n=== 5. The seven-day window is untouched ===\n");
    // ======================================================================
    //
    // Sean: "A migrated dismissal preserves its original seven-day expiration
    // semantics." The window is computed from dismissedAt, so preserving the
    // semantics means preserving that timestamp exactly — not approximately.
    check("dismissedAt is byte-identical after the migration",
      after.every((r) => r.dismissedAt.getTime() === dismissedAt.getTime()),
      `all ${after.length} rows still at ${dismissedAt.toISOString()}`);
    const stillLive = Date.now() - dismissedAt.getTime() < 7 * 24 * 60 * 60 * 1000;
    check("  so a 3-day-old deferral is still in force, as it was before",
      stillLive, "the rule reads the same column it always did");

    // ======================================================================
    console.log("\n=== 6. The underlying records were not touched ===\n");
    // ======================================================================
    const obsAfter = await prisma.genesisObservation.findUnique({ where: { id: observation.id } });
    check("the observation is unchanged",
      obsAfter?.status === "ACTIVE" && obsAfter?.dedupeKey === obsDedupe && obsAfter?.summary === "Your bios are empty",
      `${obsAfter?.status} / ${obsAfter?.dedupeKey}`);
    const apprAfter = await prisma.approvalRequest.findUnique({ where: { id: approval.id } });
    check("the approval is unchanged", apprAfter?.status === "PENDING_APPROVAL", `${apprAfter?.status}`);
    const taskAfter = await prisma.task.findUnique({ where: { id: task.id } });
    check("the task is unchanged", taskAfter?.status === "OPEN", `${taskAfter?.status}`);

    // ======================================================================
    console.log("\n=== 7. Idempotent — running it again writes nothing ===\n");
    // ======================================================================
    const snapshot = JSON.stringify(
      after.map((r) => [r.cardId, r.source, r.sourceId, r.dismissedAt.toISOString()]).sort(),
    );
    for (const s of statements) await prisma.$executeRawUnsafe(s);
    for (const s of statements) await prisma.$executeRawUnsafe(s);
    const twice = await prisma.dismissedAttentionCard.findMany({
      where: { storeId: { in: [store.id, otherStore.id] } },
    });
    check("three runs produce exactly the state one run produced",
      JSON.stringify(twice.map((r) => [r.cardId, r.source, r.sourceId, r.dismissedAt.toISOString()]).sort()) === snapshot,
      "guarded by \"source\" IS NULL, so a re-run matches nothing");

    // A ROW MAPPED ONCE IS NOT REMAPPED IF THE WORLD CHANGES. The guard means
    // an already-mapped dismissal keeps pointing at the record it was about,
    // even if a new record later takes the same dedupeKey.
    await prisma.genesisObservation.delete({ where: { id: observation.id } });
    const replacement = await prisma.genesisObservation.create({
      data: {
        storeId: store.id, dedupeKey: obsDedupe, genesisState: "opportunity",
        summary: "A different row, same condition key", status: "ACTIVE",
      },
    });
    for (const s of statements) await prisma.$executeRawUnsafe(s);
    const afterReplacement = await byCard(store.id, `observation:${obsDedupe}`);
    check("an already-mapped row is not silently repointed at a new record",
      afterReplacement?.sourceId !== replacement.id,
      afterReplacement?.sourceId === replacement.id
        ? `REPOINTED to ${replacement.id} — the guard is gone`
        : `still ${afterReplacement?.sourceId}, not ${replacement.id}`);

    // ======================================================================
    console.log("\n=== 8. It cannot fall back to parsing or headlines ===\n");
    // ======================================================================
    //
    // The sabotage-shaped assertions, read from the shipped file. A migration
    // that split the presentation id would be a different file, and these are
    // what would have to be deleted to write one.
    const raw = readFileSync(MIGRATION, "utf8");
    const code = raw.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    check("the SQL never splits a cardId",
      !/split_part|substring|position\s*\(|left\s*\(|right\s*\(|trim\s*\(/i.test(code),
      "no string surgery on an identity");
    check("  and never matches on a pattern",
      !/\bLIKE\b|~~|SIMILAR TO|~\s*'/i.test(code),
      "a prefix LIKE would be inference wearing SQL");
    check("  and never reads a headline",
      !/summary|title|headline/i.test(code),
      "identity is never text an owner reads");
    // THE DIRECTION IS THE POINT. Every join builds the id from the record and
    // compares; nothing takes the stored id apart.
    const builds = (code.match(/'(proposal|task|observation):'\s*\|\|/g) ?? []).length;
    check("every mapping builds the id from the record instead",
      builds === 3, `${builds} of 3 statements construct-and-compare`);
    check("  each guarded so it is idempotent",
      (code.match(/"source"\s+IS\s+NULL/gi) ?? []).length === 3,
      "a re-run has nothing left to match");
    check("  and each scoped to one business",
      (code.match(/"storeId"\s*=\s*d\."storeId"/g) ?? []).length === 3,
      "same dedupeKey in two businesses is two different records");
    check("no underlying record is written by this migration",
      !/UPDATE\s+"(GenesisObservation|ApprovalRequest|Task)"|DELETE\s+FROM/i.test(code),
      "only DismissedAttentionCard is written");
    check("nothing is dropped or rewritten away",
      !/DROP\s+COLUMN|DROP\s+TABLE|ALTER\s+COLUMN[^;]*DROP/i.test(code),
      "cardId survives, so the existing reader keeps working");

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
    if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
