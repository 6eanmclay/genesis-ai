import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// M8 AND M9's READS, AND THEIR ISOLATION — the last two open on BI_ENGINE.md:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-audience-recall-live.ts" -OutFile out.txt
//
// BI_ENGINE.md has carried these two as "still unexercised against real rows"
// since M8 and M9 shipped, alongside "and whether the store has any signups at
// all is unknown". Neither is externally blocked — nothing needed but a database
// — so they were open for want of a pass, not for want of anything real.
//
// Both are reads whose arithmetic is already proved pure by their own suites.
// What was never run is the query: which rows come back, scoped to which
// business, and with which columns deliberately absent.
//
// TWO PRIVACY PROPERTIES ARE THE POINT, not incidental:
//
//   getAudience         selects createdAt and NOTHING else — no email address is
//                       fetched at all, so none can reach a prompt. Data that is
//                       never read cannot leak.
//   findRelevantMessages reads only the OWNER's own messages, never J4's replies,
//                       so recall cannot quote J4 back to itself as if the owner
//                       had said it.
//
// And both are asserted across two businesses, because a subscriber count or a
// remembered sentence borrowed from the other business would be a confident,
// specific, entirely wrong answer.

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

  const { getAudience } = await import("@/lib/businessModel/audience");
  const { findRelevantMessages } = await import("@/lib/businessModel/conversationRecall");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  const makeStore = (userId: string, name: string, slug: string) =>
    prisma.store.create({
      data: { userId, name, slug, tagline: "t", description: "d", currency: "USD" },
    });

  const owner = await prisma.user.create({ data: { email: "audience-owner@example.test" } });
  const iron = await makeStore(owner.id, "Iron Gym", "iron-gym");
  const copper = await makeStore(owner.id, "Copper & Coil", "copper-coil");

  // ==========================================================================
  console.log("\n=== 1. Nobody has signed up — an absence, not a conclusion ===\n");
  // ==========================================================================
  const empty = await getAudience(iron.id);
  check("no subscribers", empty.subscriberCount, 0);
  check("no first signup — null, never a date", empty.firstSignupAt, null);
  check("no most recent", empty.mostRecentSignupAt, null);
  check("no timestamps", empty.recentSignupsAt, []);
  // The one that must never become 0: "nobody has signed up in 0 days" would
  // read as "somebody signed up today".
  check("and days-since is null, never zero", empty.daysSinceMostRecent, null);

  // ==========================================================================
  console.log("\n=== 2. Real signups, read from real rows ===\n");
  // ==========================================================================
  const signup = (storeId: string, email: string, day: number) =>
    prisma.newsletterSignup.create({
      data: { storeId, email, createdAt: daysAgo(day) },
    });

  // Captured ONCE. daysAgo() reads the clock, so calling it again at assertion
  // time drifts by milliseconds and compares two different instants.
  const at40 = daysAgo(40);
  const at12 = daysAgo(12);
  const at3 = daysAgo(3);

  await prisma.newsletterSignup.create({ data: { storeId: iron.id, email: "first@example.test", createdAt: at40 } });
  await prisma.newsletterSignup.create({ data: { storeId: iron.id, email: "second@example.test", createdAt: at12 } });
  await prisma.newsletterSignup.create({ data: { storeId: iron.id, email: "third@example.test", createdAt: at3 } });
  await signup(copper.id, "candle-lover@example.test", 8);

  const ironAudience = await getAudience(iron.id);
  check("every signup counted", ironAudience.subscriberCount, 3);
  check("the oldest is the first", ironAudience.firstSignupAt, at40.toISOString());
  check("the newest is the most recent", ironAudience.mostRecentSignupAt, at3.toISOString());
  check("days since the most recent is a real number", ironAudience.daysSinceMostRecent, 3);
  check("timestamps are newest first", ironAudience.recentSignupsAt, [
    at3.toISOString(),
    at12.toISOString(),
    at40.toISOString(),
  ]);

  // THE PRIVACY PROPERTY. Not "email is absent from the select" — that is
  // readable from the source. This asks whether a real address that IS in the
  // database reached the answer.
  const serialized = JSON.stringify(ironAudience);
  check(
    "no subscriber's email address is anywhere in the answer",
    ["first@example.test", "second@example.test", "third@example.test"].filter((e) => serialized.includes(e)),
    []
  );

  // ==========================================================================
  console.log("\n=== 3. One business's audience is not the other's ===\n");
  // ==========================================================================
  const copperAudience = await getAudience(copper.id);
  check("the other business has its own count", copperAudience.subscriberCount, 1);
  check("and its own most recent", copperAudience.daysSinceMostRecent, 8);
  assert(
    "the two counts are genuinely different",
    ironAudience.subscriberCount !== copperAudience.subscriberCount,
    "so a borrowed count would be visible"
  );
  check("and no address crosses either", JSON.stringify(copperAudience).includes("first@example.test"), false);

  const [tabA, tabB] = await Promise.all([getAudience(iron.id), getAudience(copper.id)]);
  check("concurrent reads stay separate", [tabA.subscriberCount, tabB.subscriberCount], [3, 1]);

  // ==========================================================================
  console.log("\n=== 4. What the owner actually said, recalled by topic ===\n");
  // ==========================================================================
  const said = (storeId: string, role: string, content: string, day: number) =>
    prisma.storeMessage.create({
      data: { storeId, role, content, createdAt: daysAgo(day) },
    });

  await said(iron.id, "user", "I want to keep the kettlebell range small and heavy.", 200);
  await said(iron.id, "user", "We decided against selling supplements.", 120);
  await said(iron.id, "user", "The Tuesday class is the one that fills up.", 30);
  // J4's own words. Recall must never quote these back as the owner's.
  await said(iron.id, "assistant", "You should absolutely sell supplements — they are high margin.", 119);
  // The other business's conversation.
  await said(copper.id, "user", "The soy wax supplier raised prices again.", 40);

  const supplements = await findRelevantMessages(iron.id, "what did we decide about supplements?");
  assert("the owner's own decision is recalled", supplements.length > 0);
  assert(
    "and it is what they said, not what J4 said",
    supplements.every((m) => !m.text.includes("high margin")),
    "recall reads only the owner's messages"
  );
  assert("the right sentence is first", supplements[0].text.includes("against selling supplements"));

  // Age is no barrier — this is the unbounded recall M9 exists for.
  const kettlebells = await findRelevantMessages(iron.id, "how did we want to handle kettlebells?");
  assert("a statement from 200 days ago is still reachable", kettlebells.length > 0);
  assert("and it is the right one", kettlebells[0].text.includes("kettlebell"));

  // A question about nothing returns nothing, rather than the newest message
  // dressed up as an answer.
  check(
    "an unrelated question recalls nothing",
    await findRelevantMessages(iron.id, "what is our policy on international shipping to Peru?"),
    []
  );

  // ==========================================================================
  console.log("\n=== 5. One business never remembers another's conversation ===\n");
  // ==========================================================================
  const waxFromIron = await findRelevantMessages(iron.id, "what happened with the soy wax supplier?");
  check("Iron Gym does not remember Copper & Coil's supplier", waxFromIron, []);

  const waxFromCopper = await findRelevantMessages(copper.id, "what happened with the soy wax supplier?");
  assert("while Copper & Coil does", waxFromCopper.length > 0);
  assert("and it is the real sentence", waxFromCopper[0].text.includes("soy wax supplier"));

  // The same question, both businesses, at once.
  const [ironWax, copperWax] = await Promise.all([
    findRelevantMessages(iron.id, "soy wax supplier prices"),
    findRelevantMessages(copper.id, "soy wax supplier prices"),
  ]);
  check("concurrently, one remembers and the other does not", [ironWax.length, copperWax.length > 0], [0, true]);

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All audience/recall assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
