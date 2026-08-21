import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// THE SWITCHER — BUSINESS_CONTEXT.md Phase D:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-business-switcher-live.ts" -OutFile out.txt
//
// Phase D's own words: "A switcher that navigates. It sets the active business
// (so the next landing is right) and then changes the URL. It does not hold
// state; the URL is the state." Plus item 10, the chooser for the ambiguous
// case.
//
// THE DEAD END THIS CLOSES. resolveBusiness has returned "ambiguous" since Phase
// 0 — correctly, because picking one would be the recency defect it was built to
// remove. But setActiveBusiness and accessibleBusinesses had NO CALLERS outside
// their own module, so an account reaching two businesses with nothing saying
// which was told to choose and given nowhere to do it. Every protected page
// bounced to /dashboard, which resolves the same way.
//
// What is asserted here is the resolution layer the switcher drives, and the
// invariant BUSINESS_CONTEXT.md says must never regress: a business is active
// because it was CHOSEN, never because it was touched.

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

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { resolveBusiness, setActiveBusiness, accessibleBusinesses } = await import(
    "@/lib/businessContext"
  );
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
  const makeStore = (userId: string, name: string, slug: string) =>
    prisma.store.create({
      data: { userId, name, slug, tagline: `${name} tagline`, description: "d", currency: "USD" },
    });

  await reset();
  const owner = await prisma.user.create({ data: { email: `owner-${++n}@example.test` } });
  const iron = await makeStore(owner.id, "Iron Gym", "iron-gym");
  const copper = await makeStore(owner.id, "Copper & Coil", "copper-coil");

  // ==========================================================================
  console.log("\n=== 1. The dead end, and that it is now answerable ===\n");
  // ==========================================================================
  const ambiguous = await resolveBusiness(owner.id);
  check("two businesses and nothing saying which is ambiguous", ambiguous.kind, "ambiguous");
  assert(
    "and the chooser is given real businesses to offer",
    ambiguous.kind === "ambiguous" && ambiguous.choices.length === 2
  );
  // The chooser reads this. Ordered by name so a list somebody is learning does
  // not reorder itself as they work.
  const listed = await accessibleBusinesses(owner.id);
  check("ordered by name, not recency", listed.map((b) => b.store.name), ["Copper & Coil", "Iron Gym"]);
  check("each carries the role it will be entered with", listed.map((b) => b.role), ["OWNER", "OWNER"]);

  // ==========================================================================
  console.log("\n=== 2. Choosing resolves it, and only choosing ===\n");
  // ==========================================================================
  const chosen = await setActiveBusiness(owner.id, copper.id);
  assert("the switch succeeds", chosen.ok === true);
  check("and returns the slug the URL becomes", chosen.ok && chosen.context.store.slug, "copper-coil");

  const afterChoice = await resolveBusiness(owner.id);
  check("resolution is no longer ambiguous", afterChoice.kind, "resolved");
  check("and it is the chosen one", afterChoice.kind === "resolved" && afterChoice.store.slug, "copper-coil");

  // THE INVARIANT BUSINESS_CONTEXT.md SAYS MUST NEVER REGRESS: a business is
  // never active because it was touched. Writing to the other one — the exact
  // act that used to move everything — must change nothing.
  await prisma.product.create({
    data: { storeId: iron.id, name: "Kettlebell", description: "d", priceInCents: 4500, active: true },
  });
  await prisma.store.update({ where: { id: iron.id }, data: { tagline: "touched just now" } });
  const afterTouch = await resolveBusiness(owner.id);
  check("touching the other business does NOT make it active",
    afterTouch.kind === "resolved" && afterTouch.store.slug, "copper-coil");

  // ==========================================================================
  console.log("\n=== 3. The two-tab test — the one that decides it ===\n");
  // ==========================================================================
  // Phase E's own framing: "two concurrent resolutions naming different slugs,
  // asserting neither sees the other's business — which fails against any
  // implementation that reads ambient state."
  const [tabA, tabB] = await Promise.all([
    resolveBusiness(owner.id, iron.id),
    resolveBusiness(owner.id, copper.id),
  ]);
  check("the tab that named Iron Gym got Iron Gym", tabA.kind === "resolved" && tabA.store.slug, "iron-gym");
  check("the tab that named Copper & Coil got Copper & Coil",
    tabB.kind === "resolved" && tabB.store.slug, "copper-coil");
  assert("neither borrowed the other's business",
    tabA.kind === "resolved" && tabB.kind === "resolved" && tabA.storeId !== tabB.storeId);
  // Naming a business must not move the pointer either — reading is not choosing.
  const stillCopper = await resolveBusiness(owner.id);
  check("and reading a named business did not silently switch to it",
    stillCopper.kind === "resolved" && stillCopper.store.slug, "copper-coil");

  // ==========================================================================
  console.log("\n=== 4. A business id is not a capability ===\n");
  // ==========================================================================
  const stranger = await prisma.user.create({ data: { email: `stranger-${++n}@example.test` } });
  const theirs = await makeStore(stranger.id, "Someone Else", "someone-else");

  const refused = await setActiveBusiness(owner.id, theirs.id);
  check("switching to a business you cannot reach is refused", refused, { ok: false, reason: "no_access" });
  const unmoved = await resolveBusiness(owner.id);
  check("and the active business is untouched",
    unmoved.kind === "resolved" && unmoved.store.slug, "copper-coil");
  // Refused, never substituted — succeeding with a different business than the
  // one asked for is worse than failing, because it succeeds.
  check("naming an unreachable business resolves to none, not to yours",
    (await resolveBusiness(owner.id, theirs.id)).kind, "none");

  // ==========================================================================
  console.log("\n=== 5. Nothing to choose between is not a choice ===\n");
  // ==========================================================================
  const solo = await prisma.user.create({ data: { email: `solo-${++n}@example.test` } });
  check("an account with no business resolves to none", (await resolveBusiness(solo.id)).kind, "none");
  check("and the chooser has nothing to list", await accessibleBusinesses(solo.id), []);

  await makeStore(solo.id, "Only One", "only-one");
  const only = await resolveBusiness(solo.id);
  check("one business is not a guess, it is the only answer", only.kind, "resolved");
  check("and needs no pointer to be set", (await prisma.user.findUniqueOrThrow({
    where: { id: solo.id }, select: { activeStoreId: true },
  })).activeStoreId, null);

  // ==========================================================================
  console.log("\n=== 6. A pointer that stops being reachable ===\n");
  // ==========================================================================
  // The case that makes the chooser necessary rather than merely convenient:
  // the active business is deleted, the column nulls, and the account is back to
  // two-and-nothing-saying-which with no way through.
  const third = await makeStore(owner.id, "Third Thing", "third-thing");
  await setActiveBusiness(owner.id, third.id);
  check("switched to the third", (await resolveBusiness(owner.id)).kind === "resolved" &&
    (await resolveBusiness(owner.id) as { store: { slug: string } }).store.slug, "third-thing");

  await prisma.store.delete({ where: { id: third.id } });
  check("deleting it nulls the pointer", (await prisma.user.findUniqueOrThrow({
    where: { id: owner.id }, select: { activeStoreId: true },
  })).activeStoreId, null);
  check("which lands back in ambiguous — the state the chooser answers",
    (await resolveBusiness(owner.id)).kind, "ambiguous");
  const recovered = await setActiveBusiness(owner.id, iron.id);
  assert("and choosing gets out of it", recovered.ok === true);
  check("into the business that was chosen",
    (await resolveBusiness(owner.id)).kind === "resolved" &&
      ((await resolveBusiness(owner.id)) as { store: { slug: string } }).store.slug, "iron-gym");

  await reset();
  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All switcher assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
