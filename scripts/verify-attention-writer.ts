import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startRealPostgres } from "@/scripts/lib/realPostgres";

// ONE DEFERRAL PER ITEM, HELD BY THE DATABASE (2026-09-13).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-attention-writer.ts" -OutFile out.txt
//
// ============ WHAT THIS COVERS =======================================
//
// Step 5: the unique constraint on (storeId, source, sourceId), the writer
// moving onto that same key, and — the part that matters most because it runs
// against production on push — the preflight that REFUSES rather than
// reconciles when an unexpected duplicate exists.
//
// The writer is exercised through the same upsert shape the server action
// performs. The action itself resolves a session and a business first, which a
// script has no honest way to provide; what is asserted here is the write, and
// the shape of the action's own call is asserted from its source so the two
// cannot drift apart silently.

const MIGRATION_DIR = join(process.cwd(), "prisma", "migrations");
const PREFLIGHT = join(MIGRATION_DIR, "20260913180000_attention_deferral_unique", "migration.sql");

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** The migration's statements, split so the preflight can be run on its own. */
function migrationParts(): { preflight: string; dropIndex: string; createUnique: string } {
  const sql = readFileSync(PREFLIGHT, "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  const preflightMatch = /DO \$preflight\$[\s\S]*?\$preflight\$;/.exec(sql);
  const dropMatch = /DROP INDEX[^;]*;/.exec(sql);
  const createMatch = /CREATE UNIQUE INDEX[\s\S]*?;/.exec(sql);
  return {
    preflight: preflightMatch?.[0] ?? "",
    dropIndex: dropMatch?.[0] ?? "",
    createUnique: createMatch?.[0] ?? "",
  };
}

async function main(): Promise<void> {
  const db = await startRealPostgres();
  const prisma = db.prisma;
  try {
    const parts = migrationParts();
    console.log("\n=== the shipped migration, in three parts ===\n");
    check("the preflight was found", parts.preflight.length > 0, `${parts.preflight.length} chars`);
    check("the unique index was found", /CREATE UNIQUE INDEX/.test(parts.createUnique));
    check("  and the redundant plain index is dropped",
      /DROP INDEX IF EXISTS "DismissedAttentionCard_storeId_source_sourceId_idx"/.test(parts.dropIndex),
      "a unique index covers the same lookups");

    const stamp = Date.now();
    const user = await prisma.user.create({
      data: { email: `writer-${stamp}@example.test`, name: "Sean McLay", password: "x" },
    });
    const storeA = await prisma.store.create({
      data: { userId: user.id, name: "Cubit & Coil", slug: `writer-a-${stamp}`, currency: "USD" },
    });
    const storeB = await prisma.store.create({
      data: { userId: user.id, name: "Other Shop", slug: `writer-b-${stamp}`, currency: "USD" },
    });

    /**
     * The write the server action performs, with its two branches.
     *
     * Mirrors dismissAttentionCard's body exactly; the assertion that they
     * stay the same shape is made against its source at the end.
     */
    const dismiss = async (storeId: string, cardId: string, ref: { source: string; id: string } | null) => {
      if (ref) {
        await prisma.dismissedAttentionCard.upsert({
          where: { storeId_source_sourceId: { storeId, source: ref.source, sourceId: ref.id } },
          create: { storeId, cardId, source: ref.source, sourceId: ref.id },
          update: { dismissedAt: new Date() },
        });
      } else {
        await prisma.dismissedAttentionCard.upsert({
          where: { storeId_cardId: { storeId, cardId } },
          create: { storeId, cardId },
          update: { dismissedAt: new Date() },
        });
      }
    };
    const rowsFor = (storeId: string) =>
      prisma.dismissedAttentionCard.findMany({ where: { storeId }, orderBy: { cardId: "asc" } });

    // ==================================================================
    console.log("\n=== 1 + 5. Two spellings of one item are one deferral ===\n");
    // ==================================================================
    const obsId = `obs-${stamp}`;
    await dismiss(storeA.id, `observation:key:with:colons:${stamp}`, { source: "observation", id: obsId });
    const first = await rowsFor(storeA.id);
    check("the first write creates the deferral", first.length === 1, `${first.length} row`);

    // THE SAME ITEM, A DIFFERENT PRESENTATION SPELLING. Under the old writer
    // this created a second row, because the card id was the identity. It is
    // the exact regression the constraint and this cutover exist to prevent.
    await dismiss(storeA.id, `observation_v2:${obsId}`, { source: "observation", id: obsId });
    const second = await rowsFor(storeA.id);
    check("a second spelling does NOT create a second deferred state",
      second.length === 1, `${second.length} rows for one item`);
    check("  and the row keeps the card id it was created with",
      second[0].cardId === `observation:key:with:colons:${stamp}`,
      `${second[0].cardId} — compatibility data, not identity`);
    check("  while its canonical identity is the item",
      second[0].source === "observation" && second[0].sourceId === obsId,
      `${second[0].source}/${second[0].sourceId}`);

    // ==================================================================
    console.log("\n=== 2. The same item in two businesses stays separate ===\n");
    // ==================================================================
    await dismiss(storeB.id, `observation:key:with:colons:${stamp}`, { source: "observation", id: obsId });
    check("business B gets its own deferral for the same sourceId",
      (await rowsFor(storeB.id)).length === 1);
    check("  and business A still has exactly one",
      (await rowsFor(storeA.id)).length === 1,
      "the key is scoped by store, so one owner's 'not now' is not another's");

    // ==================================================================
    console.log("\n=== 3. Same raw id, different source, different item ===\n");
    // ==================================================================
    const shared = `collision-${stamp}`;
    await dismiss(storeA.id, `task:${shared}`, { source: "task", id: shared });
    await dismiss(storeA.id, `proposal:${shared}`, { source: "approval", id: shared });
    const bySource = (await rowsFor(storeA.id)).filter((r) => r.sourceId === shared);
    check("a task and an approval with the same raw id are two deferrals",
      bySource.length === 2, `${bySource.length}`);
    check("  distinguished by source",
      new Set(bySource.map((r) => r.source)).size === 2,
      bySource.map((r) => r.source).join(" "));

    // ==================================================================
    console.log("\n=== 4. Legacy rows keep working on their own path ===\n");
    // ==================================================================
    await dismiss(storeA.id, `issue:outcome-${stamp}`, null);
    await dismiss(storeA.id, `discovery:finding-${stamp}`, null);
    const legacy = (await rowsFor(storeA.id)).filter((r) => r.source === null);
    check("an issue and a discovery are stored with no canonical identity",
      legacy.length === 2, `${legacy.length}`);
    check("  and both are outside the unique constraint, being NULL",
      legacy.every((r) => r.source === null && r.sourceId === null),
      "Postgres treats NULLs as distinct, which is why they coexist");
    // RE-DISMISSING A LEGACY CARD STILL UPDATES ITS OWN ROW.
    const beforeLegacy = legacy[0].dismissedAt.getTime();
    await new Promise((r) => setTimeout(r, 5));
    await dismiss(storeA.id, legacy[0].cardId, null);
    const afterLegacy = (await rowsFor(storeA.id)).find((r) => r.cardId === legacy[0].cardId);
    check("  and re-dismissing one moves its own timestamp, creating nothing",
      afterLegacy !== undefined && afterLegacy.dismissedAt.getTime() > beforeLegacy &&
        (await rowsFor(storeA.id)).filter((r) => r.source === null).length === 2,
      "the legacy path is unchanged");

    // ==================================================================
    console.log("\n=== 7. Seven-day semantics are unchanged ===\n");
    // ==================================================================
    const target = (await rowsFor(storeA.id)).find((r) => r.sourceId === obsId)!;
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await prisma.dismissedAttentionCard.update({ where: { id: target.id }, data: { dismissedAt: old } });
    await dismiss(storeA.id, `observation:key:with:colons:${stamp}`, { source: "observation", id: obsId });
    const refreshed = (await rowsFor(storeA.id)).find((r) => r.sourceId === obsId)!;
    check("saying 'not now' again moves the clock forward",
      refreshed.dismissedAt.getTime() > old.getTime(),
      "seven days from the most recent one, off the same column as always");
    check("  and does not create a second row to measure from",
      (await rowsFor(storeA.id)).filter((r) => r.sourceId === obsId).length === 1);

    // ==================================================================
    console.log("\n=== 8. Re-confirming the observation changes nothing ===\n");
    // ==================================================================
    //
    // Today a deferral is purely time-boxed: re-detecting a condition does not
    // clear it. That was raised as an open product question at the contract
    // commit and deliberately left alone, so this asserts the CURRENT
    // semantics rather than a preferred future one.
    const liveObs = await prisma.genesisObservation.create({
      data: { storeId: storeA.id, dedupeKey: `writer:obs:${stamp}`, genesisState: "urgent",
        summary: "something", status: "ACTIVE" },
    });
    await dismiss(storeA.id, `observation:writer:obs:${stamp}`, { source: "observation", id: liveObs.id });
    const beforeConfirm = (await rowsFor(storeA.id)).find((r) => r.sourceId === liveObs.id)!;
    // The sweep's own re-confirmation: same row, bumped lastConfirmedAt.
    await prisma.genesisObservation.update({
      where: { id: liveObs.id },
      data: { lastConfirmedAt: new Date(), status: "ACTIVE" },
    });
    const afterConfirm = (await rowsFor(storeA.id)).find((r) => r.sourceId === liveObs.id)!;
    check("re-confirming the condition leaves the deferral exactly as it was",
      afterConfirm.dismissedAt.getTime() === beforeConfirm.dismissedAt.getTime() &&
        afterConfirm.id === beforeConfirm.id,
      "unchanged semantics — the open question was not quietly answered here");

    // ==================================================================
    console.log("\n=== 6. A duplicate stops the migration, and names it ===\n");
    // ==================================================================
    //
    // The preflight is the reason this commit can be pushed at all: it runs
    // against production data nobody here has seen.
    //
    // The unique index is already in place in this database, so a duplicate
    // cannot simply be inserted. It is created the only way a real one could
    // appear — the index dropped, as it would be absent on a database that has
    // not yet had this migration, the rows written, and then the migration's
    // own preflight run against them.
    await prisma.$executeRawUnsafe(`DROP INDEX "DismissedAttentionCard_storeId_source_sourceId_key"`);
    const dupCardId = `observation_ghost:${obsId}`;
    await prisma.dismissedAttentionCard.create({
      data: { storeId: storeA.id, cardId: dupCardId, source: "observation", sourceId: obsId },
    });
    check("a duplicate canonical key now exists to be caught",
      (await rowsFor(storeA.id)).filter((r) => r.source === "observation" && r.sourceId === obsId).length === 2);

    let raised: string | null = null;
    try {
      await prisma.$executeRawUnsafe(parts.preflight);
    } catch (e) {
      raised = e instanceof Error ? e.message : String(e);
    }
    check("the preflight refuses", raised !== null, raised ? "it raised" : "IT LET THE DUPLICATE THROUGH");
    check("  and names the conflicting canonical key",
      raised !== null && raised.includes(obsId) && raised.includes(storeA.id),
      raised ? `mentions store and sourceId` : "no diagnostic");
    check("  and says the constraint was not created",
      raised !== null && /was NOT created/i.test(raised));
    check("  and reconciles nothing",
      (await rowsFor(storeA.id)).filter((r) => r.source === "observation" && r.sourceId === obsId).length === 2,
      "both rows are still there — no winner chosen, no timestamps merged");

    // AND WITH THE DUPLICATE RESOLVED BY A PERSON, the migration completes.
    await prisma.dismissedAttentionCard.deleteMany({ where: { cardId: dupCardId } });
    let afterFix: string | null = null;
    try {
      await prisma.$executeRawUnsafe(parts.preflight);
      await prisma.$executeRawUnsafe(parts.createUnique);
    } catch (e) {
      afterFix = e instanceof Error ? e.message : String(e);
    }
    check("once the duplicate is gone the migration proceeds",
      afterFix === null, afterFix ?? "preflight passed and the index was created");

    // ==================================================================
    console.log("\n=== The constraint is real, not just declared ===\n");
    // ==================================================================
    let violation: string | null = null;
    try {
      await prisma.dismissedAttentionCard.create({
        data: { storeId: storeA.id, cardId: `observation_third:${obsId}`, source: "observation", sourceId: obsId },
      });
    } catch (e) {
      violation = e instanceof Error ? e.message : String(e);
    }
    check("the database itself refuses a second row for one item",
      violation !== null, violation ? "unique violation" : "THE INDEX IS NOT ENFORCING");
    // AND IT DOES NOT OVER-REACH: legacy NULL rows are still free to coexist.
    await dismiss(storeA.id, `issue:another-${stamp}`, null);
    check("  while legacy rows with no canonical identity still coexist",
      (await rowsFor(storeA.id)).filter((r) => r.source === null).length === 3,
      "NULLs are distinct, so the constraint binds only real items");

    // ==================================================================
    console.log("\n=== Sabotage guard: the writer uses the canonical pair ===\n");
    // ==================================================================
    //
    // Asserting that the index exists proves the database is strict. It does
    // NOT prove the writer stopped keying on the card id — with the old writer
    // a second spelling would now throw a unique violation at the owner
    // instead of silently duplicating, which is a worse failure than the one
    // being fixed. So the action's own upsert is read.
    const action = readFileSync(join(process.cwd(), "app", "dashboard", "ai-actions.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const body = action.slice(action.indexOf("export async function dismissAttentionCard"));
    const scoped = body.slice(0, body.indexOf("\n}"));
    check("the canonical branch upserts on storeId_source_sourceId",
      /where: \{ storeId_source_sourceId: \{ storeId, source: ref\.source, sourceId: ref\.id \} \}/.test(scoped),
      "the item decides, not the card");
    check("  and the legacy branch still upserts on storeId_cardId",
      /where: \{ storeId_cardId: \{ storeId, cardId \} \}/.test(scoped),
      "issue:/discovery: keep the path they have always had");
    check("  and the branch is chosen by whether a canonical row exists",
      /if \(ref\) \{/.test(scoped),
      "never by which surface is asking");
    check("  and cardId is not rewritten on update",
      !/update: \{[^}]*cardId/.test(scoped),
      "it is compatibility data; rewriting it could collide with another row");

    // ============ AND THE MIRROR IS THE WRITER =========================
    //
    // The behavioural assertions above run against `dismiss` in this file, not
    // against the server action — the action resolves a session and a business
    // first, which a script cannot honestly provide. That is a real limit, and
    // it is the shape this codebase has been caught by before: a test seam
    // standing in for the thing it tests, and passing after the real one
    // changed.
    //
    // Under the writer sabotage only the source assertions above failed; the
    // behavioural ones stayed green because they were exercising the copy. So
    // the copy is pinned to the original: both `where` clauses are extracted
    // from THIS file and from the action, and compared. Change the writer
    // without changing the mirror and this fails, which is the only thing that
    // makes the behaviour above evidence about the product.
    const self = readFileSync(join(process.cwd(), "scripts", "verify-attention-writer.ts"), "utf8");
    const mirror = self.slice(self.indexOf("const dismiss = async"), self.indexOf("const rowsFor ="));
    const wheres = (src: string) => (src.match(/where: \{ storeId_[a-zA-Z_]+: \{[^}]*\} \}/g) ?? []).sort();
    const mirrorWheres = wheres(mirror);
    const actionWheres = wheres(scoped);
    check("the mirror in this suite uses the writer's exact keys",
      mirrorWheres.length === 2 && JSON.stringify(mirrorWheres) === JSON.stringify(actionWheres),
      `mirror ${mirrorWheres.length} / action ${actionWheres.length}: ${
        JSON.stringify(mirrorWheres) === JSON.stringify(actionWheres) ? "identical" : "DRIFTED"
      }`);

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
