import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { recordConversationOutcome } from "@/lib/conversation/recordOutcome";

// ONE FAILED REQUEST CANNOT WRITE THE SAME FAILURE REPEATEDLY (2026-09-09).
//
//   npx tsx scripts/run-db-suites.ts outcome-dedupe
//
// From production, 2026-09-06: the same 181-character failure message written
// TEN times in 78 seconds, with gaps of 273ms, 441ms, 618ms, 722ms, 752ms,
// 763ms, 3s and 71s. A failed execution leaves the proposal approvable, so
// every attempt ran, failed, and appended the same sentence - and J4 then read
// all ten back as context, which is why he kept raising the same warm-up
// proposal for days.
//
// Sean's requirement, verbatim: "prove one failed request cannot write the same
// assistant failure repeatedly."

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const FAILURE = 'I tried to apply that and it did not go through. "warm cream base with copper-toned section bands" is not a recognised background treatment. Nothing on your storefront changed.';

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({
    data: { email: `outcome-${Date.now()}@example.test`, name: "Owner" },
  });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Dedupe Test", slug: `dedupe-${Date.now()}` },
  });

  try {
    console.log("\n=== 1. The real production sequence: ten rapid retries ===\n");
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i += 1) outcomes.push(await recordConversationOutcome(store.id, FAILURE));

    const written = await prisma.storeMessage.count({
      where: { storeId: store.id, role: "assistant", content: FAILURE },
    });
    check("ten retries write exactly ONE message", written === 1, `${written} row(s)`);
    check("and nine were reported as duplicates",
      outcomes.filter((o) => o === "duplicate").length === 9,
      outcomes.join(","));

    console.log("\n=== 2. Nothing is hidden: a DIFFERENT outcome still writes ===\n");
    const other = "Done, and verified.";
    const r = await recordConversationOutcome(store.id, other);
    check("a different outcome is written", r === "written", r);
    check("the conversation now holds both",
      (await prisma.storeMessage.count({ where: { storeId: store.id, role: "assistant" } })) === 2);

    console.log("\n=== 3. The same outcome AFTER something else is said, writes again ===\n");
    // This is what makes it de-duplication rather than silence: if the owner
    // retries later and it fails again, and J4 has said anything in between,
    // they see the failure again.
    const again = await recordConversationOutcome(store.id, FAILURE);
    check("the same failure after an intervening message DOES write", again === "written", again);
    check("three assistant messages in total",
      (await prisma.storeMessage.count({ where: { storeId: store.id, role: "assistant" } })) === 3);

    console.log("\n=== 4. The owner's own messages are never suppressed ===\n");
    await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: "try it again" } });
    await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: "try it again" } });
    check("two identical user messages both survive",
      (await prisma.storeMessage.count({ where: { storeId: store.id, role: "user" } })) === 2,
      "the rule is about J4 repeating himself, not about the owner");

    console.log("\n=== 5. Control: the check can see a real duplicate ===\n");
    // Write the duplicate directly, the way the old code did, and prove the
    // count assertion above would have caught it.
    await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: FAILURE } });
    const now = await prisma.storeMessage.count({
      where: { storeId: store.id, role: "assistant", content: FAILURE },
    });
    check("an unguarded write really does duplicate", now === 3, `${now} — this is the bug being fixed`);
  } finally {
    await prisma.storeMessage.deleteMany({ where: { storeId: store.id } }).catch(() => {});
    await prisma.store.deleteMany({ where: { id: store.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
