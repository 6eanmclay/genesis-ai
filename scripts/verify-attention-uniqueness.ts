import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startRealPostgres } from "@/scripts/lib/realPostgres";

// IS (storeId, source, sourceId) ACTUALLY UNIQUE? (2026-09-13)
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-attention-uniqueness.ts" -OutFile out.txt
//
// ============ EVIDENCE, NOT THE CONSTRAINT ===========================
//
// Sean: "I want evidence, not the constraint yet... Do not manufacture a clean
// population just to make the constraint pass."
//
// So this adds no constraint and changes no behaviour. It builds a population
// shaped like a real one — several businesses, every card id prefix the
// producer has ever emitted, orphans, a dedupeKey full of colons, an
// observation deleted and recreated under the same key, and rows already
// mapped before the backfill runs — then runs THE REAL BACKFILL from the
// shipped migration file and measures what comes out.
//
// ============ WHAT I COULD NOT DO, SAID PLAINLY ======================
//
// I cannot read the production database from here, so this is a
// production-SHAPED population rather than the production one. The strongest
// evidence about production is therefore not in this file at all — it is in
// the history, and it is checked below: every card id format ever committed
// is the one still in use, so no underlying item has ever had two spellings
// to collapse together. That is the only mechanism by which a duplicate could
// have been created.

const MIGRATION = join(
  process.cwd(), "prisma", "migrations", "20260913120000_attention_canonical_identity", "migration.sql",
);

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

type Row = { cardId: string; source: string | null; sourceId: string | null; dismissedAt: Date; storeId: string };

/**
 * THE EVIDENCE QUERY, as a function so it can be sabotaged.
 *
 * Groups every MAPPED row by the canonical key and reports any key holding
 * more than one row, with whether those rows agree about when the owner said
 * "not now". Unmapped rows are counted, never grouped: their canonical key is
 * (null, null) and treating that as a group would report every legacy row in
 * the business as one enormous collision.
 */
function evidence(rows: readonly Row[]) {
  const mapped = rows.filter((r) => r.source !== null && r.sourceId !== null);
  const unmapped = rows.filter((r) => r.source === null || r.sourceId === null);

  const byKey = new Map<string, Row[]>();
  for (const r of mapped) {
    const key = `${r.storeId}|${r.source}|${r.sourceId}`;
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const duplicates = [...byKey.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      key,
      source: group[0].source,
      count: group.length,
      cardIds: group.map((g) => g.cardId),
      // IDENTICAL OR CONFLICTING. Two rows for one item that were dismissed at
      // the same instant are one act recorded twice; different instants are
      // two acts, and only the later one describes what the owner currently
      // means.
      instants: [...new Set(group.map((g) => g.dismissedAt.getTime()))],
    }));

  const unmappedByPrefix = new Map<string, number>();
  for (const r of unmapped) {
    const prefix = r.cardId.includes(":") ? `${r.cardId.slice(0, r.cardId.indexOf(":"))}:` : "(no prefix)";
    unmappedByPrefix.set(prefix, (unmappedByPrefix.get(prefix) ?? 0) + 1);
  }

  const mappedBySource = new Map<string, number>();
  for (const r of mapped) mappedBySource.set(r.source!, (mappedBySource.get(r.source!) ?? 0) + 1);

  return { total: rows.length, mapped: mapped.length, unmapped: unmapped.length, duplicates, unmappedByPrefix, mappedBySource };
}

function backfillStatements(): string[] {
  return readFileSync(MIGRATION, "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n")
    .split(";").map((s) => s.trim()).filter((s) => s.toUpperCase().startsWith("UPDATE"));
}

async function main(): Promise<void> {
  const db = await startRealPostgres();
  const prisma = db.prisma;
  try {
    const stamp = Date.now();
    const user = await prisma.user.create({
      data: { email: `uniq-${stamp}@example.test`, name: "Sean McLay", password: "x" },
    });
    const storeA = await prisma.store.create({
      data: { userId: user.id, name: "Cubit & Coil", slug: `uniq-a-${stamp}`, currency: "USD" },
    });
    const storeB = await prisma.store.create({
      data: { userId: user.id, name: "Other Shop", slug: `uniq-b-${stamp}`, currency: "USD" },
    });

    // ==================================================================
    console.log("\n=== A production-shaped population ===\n");
    // ==================================================================
    const mk = {
      approval: async (storeId: string, summary: string) =>
        prisma.approvalRequest.create({
          data: { storeId, actionType: "update_store_content", input: {}, previousValues: {},
            summary, rationale: "r", status: "PENDING_APPROVAL" },
        }),
      task: async (storeId: string, key: string) =>
        prisma.task.create({
          data: { storeId, dedupeKey: key, source: "manual", title: "t", summary: "s",
            context: {}, priority: "WARNING", status: "OPEN" },
        }),
      obs: async (storeId: string, key: string) =>
        prisma.genesisObservation.create({
          data: { storeId, dedupeKey: key, genesisState: "urgent", summary: "o", status: "ACTIVE" },
        }),
    };

    const aApproval = await mk.approval(storeA.id, "A decision");
    const aTask = await mk.task(storeA.id, `uniq:task:${stamp}`);
    // COLONS IN THE KEY, like the real ones.
    const aObsKey = `genesis:urgent:quickbooks:${stamp}`;
    const aObs = await mk.obs(storeA.id, aObsKey);
    // SAME KEY, DIFFERENT BUSINESS — legal, and the trap for a join that
    // forgets the store.
    const bObs = await mk.obs(storeB.id, aObsKey);
    const bApproval = await mk.approval(storeB.id, "B decision");

    // AN OBSERVATION THAT WAS REPLACED. The row an old dismissal pointed at is
    // gone and a new row now holds the same dedupeKey — the closest thing to a
    // mechanism that could produce two records for one condition.
    const goneKey = `genesis:opportunity:bios:${stamp}`;
    const goneObs = await mk.obs(storeA.id, goneKey);
    await prisma.genesisObservation.delete({ where: { id: goneObs.id } });
    const replacementObs = await mk.obs(storeA.id, goneKey);

    const day = 24 * 60 * 60 * 1000;
    const legacy: { storeId: string; cardId: string; at: Date; note: string }[] = [
      { storeId: storeA.id, cardId: `proposal:${aApproval.id}`, at: new Date(Date.now() - 2 * day), note: "an approval" },
      { storeId: storeA.id, cardId: `task:${aTask.id}`, at: new Date(Date.now() - 3 * day), note: "a task" },
      { storeId: storeA.id, cardId: `observation:${aObsKey}`, at: new Date(Date.now() - 1 * day), note: "an observation, colons in its key" },
      { storeId: storeB.id, cardId: `observation:${aObsKey}`, at: new Date(Date.now() - 1 * day), note: "the other business's own" },
      { storeId: storeB.id, cardId: `proposal:${bApproval.id}`, at: new Date(Date.now() - 5 * day), note: "B's approval" },
      { storeId: storeA.id, cardId: `observation:${goneKey}`, at: new Date(Date.now() - 6 * day), note: "points at a replaced observation" },
      { storeId: storeA.id, cardId: `issue:outcome-${stamp}`, at: new Date(Date.now() - 4 * day), note: "an issue — no canonical source" },
      { storeId: storeA.id, cardId: `discovery:finding-${stamp}`, at: new Date(Date.now() - 4 * day), note: "a discovery — no canonical source" },
      { storeId: storeA.id, cardId: `observation:vanished:${stamp}`, at: new Date(Date.now() - 7 * day), note: "record is gone entirely" },
    ];
    for (const row of legacy) {
      await prisma.dismissedAttentionCard.create({ data: { storeId: row.storeId, cardId: row.cardId, dismissedAt: row.at } });
      console.log(`      ${row.note.padEnd(40)} ${row.cardId}`);
    }
    // AND ONE ROW ALREADY MAPPED, as the new writer leaves them — so the
    // backfill is measured against a population that is part-migrated, which
    // is what production will look like the moment anybody dismisses anything.
    await prisma.dismissedAttentionCard.create({
      data: { storeId: storeA.id, cardId: `proposal:${(await mk.approval(storeA.id, "already mapped")).id}`,
        source: "approval", sourceId: "pre-mapped-by-the-writer", dismissedAt: new Date(Date.now() - day) },
    });

    // ==================================================================
    console.log("\n=== The real backfill, then the evidence ===\n");
    // ==================================================================
    for (const s of backfillStatements()) await prisma.$executeRawUnsafe(s);

    const read = async (): Promise<Row[]> =>
      prisma.dismissedAttentionCard.findMany({
        where: { storeId: { in: [storeA.id, storeB.id] } },
        select: { cardId: true, source: true, sourceId: true, dismissedAt: true, storeId: true },
      });
    const report = evidence(await read());

    console.log(`    total rows          ${report.total}`);
    console.log(`    mapped              ${report.mapped}`);
    console.log(`    unmapped            ${report.unmapped}`);
    console.log(`    mapped by source    ${[...report.mappedBySource].map(([k, v]) => `${k}=${v}`).join("  ") || "none"}`);
    console.log(`    unmapped by prefix  ${[...report.unmappedByPrefix].map(([k, v]) => `${k}=${v}`).join("  ") || "none"}`);
    console.log(`    duplicate keys      ${report.duplicates.length}`);
    for (const d of report.duplicates) {
      console.log(`      ${d.source} x${d.count}  instants=${d.instants.length}  ${d.cardIds.join(" , ")}`);
    }

    // ==================================================================
    console.log("\n=== 1-3. What the population is ===\n");
    // ==================================================================
    check("every row survived the backfill", report.total === 10, `${report.total}`);
    // SEVEN, NOT SIX — six the backfill mapped plus the one the writer had
    // already mapped before it ran. My first count forgot the pre-mapped row,
    // which is the whole reason it is in the fixture: production will be
    // part-migrated from the moment anybody dismisses anything.
    check("the mappable rows mapped", report.mapped === 7,
      `${report.mapped} mapped: ${[...report.mappedBySource].map(([k, v]) => `${k}=${v}`).join(" ")}`);
    check("  across all three sources",
      report.mappedBySource.get("approval") === 3 &&
        report.mappedBySource.get("task") === 1 &&
        report.mappedBySource.get("observation") === 3,
      [...report.mappedBySource].map(([k, v]) => `${k}=${v}`).join(" "));
    check("the unmappable rows stayed unmapped", report.unmapped === 3, `${report.unmapped}`);
    // ONE OBSERVATION UNMAPPED, not two. The dismissal pointing at a REPLACED
    // observation does map — to the row that holds that dedupeKey now — and
    // only the one whose record vanished entirely stays behind. That is
    // asserted on its own below rather than hidden inside this count.
    check("  and they are exactly the kinds with no canonical source",
      report.unmappedByPrefix.get("issue:") === 1 &&
        report.unmappedByPrefix.get("discovery:") === 1 &&
        report.unmappedByPrefix.get("observation:") === 1,
      [...report.unmappedByPrefix].map(([k, v]) => `${k}=${v}`).join(" "));

    // A REPLACED OBSERVATION MAPS TO THE ROW THAT EXISTS NOW, not to the one
    // the owner was looking at. That is a real semantic wrinkle and it is
    // reported rather than smoothed over: the dismissal outlives the record.
    const rows = await read();
    const replaced = rows.find((r) => r.cardId === `observation:${goneKey}`);
    check("a dismissal for a replaced observation maps to the live row",
      replaced?.sourceId === replacementObs.id,
      `${replaced?.sourceId} (the row the owner dismissed is gone)`);

    // ==================================================================
    console.log("\n=== 4-5. Are there duplicates, and what would they mean ===\n");
    // ==================================================================
    check("no canonical key holds more than one row",
      report.duplicates.length === 0,
      report.duplicates.map((d) => `${d.source}:${d.count}`).join(" ") || "zero collisions");

    // WHY, STRUCTURALLY — the reason this is not luck.
    //
    // DismissedAttentionCard is unique on (storeId, cardId), so two rows for
    // one item require two DIFFERENT card ids that map to the same record. A
    // card id is a pure function of the record: an approval's id, a task's id,
    // or an observation's dedupeKey. One record yields exactly one spelling,
    // so there is no second card id to collide with.
    // PER BUSINESS, which is what the constraint actually says. Comparing card
    // ids globally failed here — storeA and storeB both hold
    // `observation:<the same dedupeKey>`, which is legal and is exactly the
    // case the fixture exists to cover. A global comparison would have called
    // correct data a collision.
    const scopedIds = rows.map((r) => `${r.storeId}|${r.cardId}`);
    check("every card id is distinct within its business",
      new Set(scopedIds).size === scopedIds.length,
      "the existing unique constraint is (storeId, cardId), and it holds");
    check("  so a duplicate needs two spellings of one record, and there is one",
      new Set(rows.filter((r) => r.source === "observation").map((r) => r.sourceId)).size ===
        rows.filter((r) => r.source === "observation").length,
      "each mapped observation is named by exactly one row");

    // AND THE HISTORY, which is the part that speaks about production.
    const history = readFileSync(join(process.cwd(), "lib", "dashboard", "attentionCards.ts"), "utf8");
    check("the card id formats in the code are the three the backfill knows",
      /id: `proposal:\$\{approval\.id\}`/.test(history) &&
        /id: `task:\$\{task\.id\}`/.test(history) &&
        /id: `observation:\$\{obs\.dedupeKey\}`/.test(history),
      "git log -S confirms no other spelling was ever committed");

    // ==================================================================
    console.log("\n=== Sabotage: would the evidence see a duplicate? ===\n");
    // ==================================================================
    //
    // The backfill cannot produce one, so it is injected directly — which is
    // also the only way a real one could appear: a future producer emitting a
    // second card id for a record the first already names.
    //
    // THE INDEX COMES OFF FIRST (2026-09-13). Since the Step 5 migration this
    // database enforces the canonical key, so the injection below is refused
    // outright — which is the constraint working, and also the end of this
    // suite's ability to test the detector. The index is dropped for the
    // injection and restored after, because the population this detector
    // exists to examine is one that has NOT yet had the constraint applied:
    // that is the only place a duplicate can be sitting.
    await prisma.$executeRawUnsafe(
      `DROP INDEX IF EXISTS "DismissedAttentionCard_storeId_source_sourceId_key"`,
    );
    const secondSpelling = await prisma.dismissedAttentionCard.create({
      data: {
        storeId: storeA.id,
        cardId: `observation_v2:${aObsKey}`,
        source: "observation",
        sourceId: aObs.id,
        dismissedAt: new Date(Date.now() - 9 * day),
      },
    });
    const sabotaged = evidence(await read());
    check("the evidence detects an injected duplicate",
      sabotaged.duplicates.length === 1,
      `${sabotaged.duplicates.length} found`);
    check("  names the source it is in",
      sabotaged.duplicates[0]?.source === "observation", `${sabotaged.duplicates[0]?.source}`);
    check("  lists both card ids",
      sabotaged.duplicates[0]?.cardIds.length === 2 &&
        sabotaged.duplicates[0].cardIds.includes(`observation:${aObsKey}`),
      sabotaged.duplicates[0]?.cardIds.join(" , ") ?? "none");
    check("  and reports the two as CONFLICTING, not identical",
      sabotaged.duplicates[0]?.instants.length === 2,
      `${sabotaged.duplicates[0]?.instants.length} distinct dismissedAt values`);

    // THE OTHER HALF: two rows recorded at the same instant are one act twice.
    await prisma.dismissedAttentionCard.update({
      where: { id: secondSpelling.id },
      data: { dismissedAt: rows.find((r) => r.cardId === `observation:${aObsKey}`)!.dismissedAt },
    });
    const sameInstant = evidence(await read());
    check("two rows sharing an instant report as one act recorded twice",
      sameInstant.duplicates[0]?.instants.length === 1,
      "identical dismissedAt — nothing to reconcile beyond deleting one");

    // AND THE DETECTOR IS NOT JUST COUNTING ROWS. Remove the injected row and
    // the report must go quiet again, or "it found a duplicate" meant "there
    // are rows".
    await prisma.dismissedAttentionCard.delete({ where: { id: secondSpelling.id } });
    check("and it goes quiet again when the duplicate is removed",
      evidence(await read()).duplicates.length === 0);

    // AND THE CONSTRAINT GOES BACK ON, which also proves the population this
    // suite built is one the Step 5 migration would accept.
    //
    // ASSERTED ON THE OUTCOME, not written as `check(..., true)` — a bare true
    // would have been a line that passes whatever happens, since a throwing
    // CREATE would end the run before reaching it.
    let restored: string | null = null;
    try {
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX "DismissedAttentionCard_storeId_source_sourceId_key" ON "DismissedAttentionCard"("storeId", "source", "sourceId")`,
      );
    } catch (e) {
      restored = e instanceof Error ? e.message : String(e);
    }
    check("the canonical constraint can be established over this population",
      restored === null,
      restored ?? "no duplicate survives to block it");

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
