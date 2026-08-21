import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// THE MANUAL-EDIT SIGNAL — J4_OWNER_UNDERSTANDING.md's named gap:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-owner-edits-live.ts" -OutFile out.txt
//
// Its own words: "there's no current mechanism distinguishing 'the owner edited
// something Genesis created' from any other store mutation — this signal doesn't
// exist as its own tracked event yet."
//
// It was RECONSTRUCTABLE. Every BusinessEvent carries its executionId and
// ExecutionLog carries actorType, so the join existed. But a signal that
// requires a join nobody writes is a signal nobody uses, and "its own tracked
// event" is the difference.
//
// WHAT IS DELIBERATELY NOT BUILT HERE: no belief, no score, no threshold. An
// owner tidying a headline Genesis wrote is not evidence they dislike Genesis
// writing headlines. It might be, across many instances — and deciding how many
// is a real number this codebase's standing rule says nobody may pick casually.
// The fact is recorded and readable; the inference is left unmade.

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

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { planOwnerEdits, findOwnerEditsOfGenesisWork, mapExecutionToEvent } = await import(
    "@/lib/intelligence/executionEvents"
  );
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  // ==========================================================================
  console.log("\n=== 1. What counts as the owner correcting Genesis ===\n");
  // ==========================================================================
  const e = (id: string, recordId: string | null, actorType: string | null, day: number) => ({
    id,
    recordId,
    entityType: "item",
    occurredAt: daysAgo(day),
    actorType,
  });

  const edits = planOwnerEdits([
    // Genesis wrote it, the owner changed it three days later. The signal.
    e("g1", "rec-1", "GENESIS", 10),
    e("u1", "rec-1", "USER", 7),
    // The owner changed their own work. Not a correction of Genesis.
    e("u2", "rec-2", "USER", 9),
    e("u3", "rec-2", "USER", 4),
    // Genesis changed something twice and the owner never touched it.
    e("g2", "rec-3", "GENESIS", 8),
    e("g3", "rec-3", "GENESIS", 2),
    // A system sync is not the owner.
    e("g4", "rec-4", "GENESIS", 6),
    e("s1", "rec-4", "SYSTEM", 5),
    // Store-level: nothing to pair it with.
    e("g5", null, "GENESIS", 6),
    e("u4", null, "USER", 5),
    // Written before actorType existed. An absence, never guessed at.
    e("g6", "rec-5", null, 20),
    e("u5", "rec-5", null, 19),
  ]);

  check("only the real correction is reported", edits.map((x) => x.recordId), ["rec-1"]);
  check("with both sides of it", [edits[0].genesisEventId, edits[0].ownerEventId], ["g1", "u1"]);
  check("and how long the owner left it", edits[0].daysLater, 3);
  assert(
    "the owner editing their own work is not a correction",
    !edits.some((x) => x.recordId === "rec-2")
  );
  assert("a system sync is not the owner", !edits.some((x) => x.recordId === "rec-4"));
  assert("a store-level event pairs with nothing", !edits.some((x) => x.recordId === null));
  assert(
    "an event with no recorded actor is not guessed at",
    !edits.some((x) => x.recordId === "rec-5"),
    "absence, not inference"
  );

  // ==========================================================================
  console.log("\n=== 2. One correction, however many revisions ===\n");
  // ==========================================================================
  const revised = planOwnerEdits([
    e("g", "rec-a", "GENESIS", 10),
    e("u-first", "rec-a", "USER", 8),
    e("u-second", "rec-a", "USER", 6),
    e("u-third", "rec-a", "USER", 5),
  ]);
  check("a record edited three times is ONE correction", revised.length, 1);
  check("and it is the first edit", revised[0].ownerEventId, "u-first");

  // Genesis changing it again restarts the question.
  const again = planOwnerEdits([
    e("g-1", "rec-b", "GENESIS", 12),
    e("u-1", "rec-b", "USER", 10),
    e("g-2", "rec-b", "GENESIS", 6),
    e("u-2", "rec-b", "USER", 4),
  ]);
  check("Genesis changing it again makes a second correction possible", again.length, 2);
  check(
    "each paired with the Genesis change it followed",
    again.map((x) => [x.genesisEventId, x.ownerEventId]).sort(),
    [
      ["g-1", "u-1"],
      ["g-2", "u-2"],
    ]
  );

  // ==========================================================================
  console.log("\n=== 3. The mapper records who made the change ===\n");
  // ==========================================================================
  const mapped = mapExecutionToEvent({
    actionType: "update_product",
    input: { productId: "p1", name: "A better name" },
    status: "SUCCESS",
    executionId: "exec-1",
    actorType: "USER",
  });
  assert("an ordinary action still maps to an event", mapped !== null);
  check("carrying the actor", (mapped?.data as { actorType?: string } | undefined)?.actorType, "USER");

  const noActor = mapExecutionToEvent({
    actionType: "update_product",
    input: { productId: "p1", name: "x" },
    status: "SUCCESS",
    executionId: "exec-2",
  });
  check(
    "and honestly null when nobody said",
    (noActor?.data as { actorType?: string | null } | undefined)?.actorType,
    null
  );

  // ==========================================================================
  console.log("\n=== 4. Against real rows ===\n");
  // ==========================================================================
  const user = await prisma.user.create({ data: { email: "edits@example.test" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Edits", slug: "edits", tagline: "t", description: "d", currency: "USD" },
  });
  const other = await prisma.store.create({
    data: { userId: user.id, name: "Other", slug: "other", tagline: "t", description: "d", currency: "USD" },
  });

  const event = (storeId: string, recordId: string, actorType: string, day: number) =>
    prisma.businessEvent.create({
      data: {
        storeId,
        entityType: "item",
        eventType: "item.updated",
        recordId,
        sourceProvider: "genesis",
        summary: "s",
        occurredAt: daysAgo(day),
        data: { executionId: `x-${recordId}-${day}`, actionType: "update_product", actorType },
      },
    });

  await event(store.id, "item-1", "GENESIS", 9);
  await event(store.id, "item-1", "USER", 4);
  await event(store.id, "item-2", "GENESIS", 8);
  // The other business's owner correcting Genesis there.
  await event(other.id, "item-9", "GENESIS", 9);
  await event(other.id, "item-9", "USER", 3);

  const live = await findOwnerEditsOfGenesisWork(store.id);
  check("read back from real events", live.map((x) => x.recordId), ["item-1"]);
  check("with the real gap between them", live[0].daysLater, 5);
  assert("a Genesis change nobody corrected is absent", !live.some((x) => x.recordId === "item-2"));
  check(
    "and one business never sees another's corrections",
    (await findOwnerEditsOfGenesisWork(other.id)).map((x) => x.recordId),
    ["item-9"]
  );

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All owner-edit assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
