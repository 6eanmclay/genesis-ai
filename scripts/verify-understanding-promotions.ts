import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// J4 CAN SEE THE SALES IT STARTED (J4_CAPABILITY_AUDIT.md, P0a):
//
//   npx tsx scripts/verify-understanding-promotions.ts
//
// ============ WHAT WAS WRONG =======================================
//
// J4 could CREATE a promotion and then never see it again. `Promotion` was not
// referenced in lib/businessModel/understanding.ts at all, the Business Map's
// "On sale in your storefront" is a PRODUCT's active flag rather than a
// discount, and reasoning.ts's "sale" means a revenue transaction. So the
// canonical understanding — the one thing every J4 surface reasons from — had
// no idea which discounts were running.
//
// Two consequences, both about money. J4 could not answer "what sales am I
// running?". And it could not stop a sale, because it could not NAME one: the
// action that ends a promotion (`update_promotion`) has existed in full the
// whole time, and nothing could produce it.
//
// ============ WHY NAMES AND IDS ARE BOTH HERE ======================
//
// The digest carries NAMES because that is what a person says and what a model
// must match against. The understanding carries IDS because that is what a
// handler resolves a name to before proposing a change. Keeping both, in the
// two different places, is what stops a cuid reaching an owner — which has
// happened in this codebase before — while still letting the change be aimed at
// a real row.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passes++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    failed.push(label);
    console.log(`  FAIL  ${label}  — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const uniq = () => Math.random().toString(36).slice(2, 10);

async function main(): Promise<void> {
  const db = await startRealPostgres();
  try {
    await run(db);
  } finally {
    // A failure must not also cost six minutes. Closing here rather than at
    // the end of run() is what stops a thrown assertion leaving a Postgres up
    // until the runner's timeout kills it.
    await db.close();
  }
}

async function run(db: Awaited<ReturnType<typeof startRealPostgres>>): Promise<void> {
  await db.prisma.$disconnect();
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { prisma } = await import("@/lib/prisma");
  const { getBusinessUnderstanding } = await import("@/lib/businessModel/understanding");
  const { digestOf, renderDigest } = await import("@/lib/businessModel/digest");

  const owner = await prisma.user.create({ data: { email: `promo-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Cubit & Coil", slug: `promo-${uniq()}`, published: true },
  });
  // A SECOND store, because a promotion leaking between businesses is the one
  // failure here that would be worse than not seeing promotions at all.
  const other = await prisma.store.create({
    data: { userId: owner.id, name: "Someone Else", slug: `other-${uniq()}`, published: true },
  });

  const ring = await prisma.product.create({
    data: { storeId: store.id, name: "Sacred Cubit Copper Tensor Ring", priceInCents: 4200, active: true },
  });

  console.log("=== 1. a store running nothing says so honestly ===");
  const quiet = await getBusinessUnderstanding(store.id);
  check("no promotions is an empty list, not a missing field", quiet.activePromotions, []);
  check("and the digest does not invent a line about it", renderDigest(digestOf(quiet)).includes("Running now:"), false);

  console.log("=== 2. a running sale is visible, with what it actually does ===");
  const sale = await prisma.promotion.create({
    data: {
      storeId: store.id,
      name: "Spring Sale",
      kind: "SALE",
      discountType: "PERCENTAGE",
      percentOff: 20,
      scope: "ALL_PRODUCTS",
      active: true,
    },
  });
  const withSale = await getBusinessUnderstanding(store.id);
  check("the sale is in the understanding", withSale.activePromotions.length, 1);
  check("named", withSale.activePromotions[0]?.name, "Spring Sale");
  check("with its discount", withSale.activePromotions[0]?.percentOff, 20);
  check("and its reach", withSale.activePromotions[0]?.scope, "ALL_PRODUCTS");
  // The id is what a handler resolves a spoken name to. Carried, never shown.
  check("carrying the id a handler would aim at", withSale.activePromotions[0]?.id, sale.id);

  const rendered = renderDigest(digestOf(withSale));
  check("the digest names it, so a model can match what the owner says", rendered.includes("Spring Sale"), true);
  check("and describes the discount", rendered.includes("20% off"), true);
  // The rule that keeps a cuid off a screen: the id belongs in the object, and
  // never in the text a model is handed to repeat back.
  check("and never puts the id in front of anyone", rendered.includes(sale.id), false);

  console.log("=== 3. a code promotion reads as a code ===");
  await prisma.promotion.create({
    data: {
      storeId: store.id,
      name: "Launch code",
      kind: "CODE",
      discountType: "FIXED_AMOUNT",
      code: "SAVE10",
      amountOffInCents: 500,
      scope: "SELECTED_PRODUCTS",
      active: true,
      products: { create: [{ productId: ring.id }] },
    },
  });
  const withCode = await getBusinessUnderstanding(store.id);
  check("both are visible", withCode.activePromotions.length, 2);
  const code = withCode.activePromotions.find((p) => p.kind === "CODE");
  check("the code a customer types is carried", code?.code, "SAVE10");
  check("and how many products it covers", code?.productCount, 1);
  check("the digest says it is a code", renderDigest(digestOf(withCode)).includes("code SAVE10"), true);

  console.log("=== 4. a stopped sale stops being visible ===");
  //
  // The point of the whole change: this is the state an owner reaches by
  // ending a sale, and J4 must not keep describing it as running.
  // updateMany WITH the storeId, not update by id. Tenant isolation refuses an
  // unscoped Promotion.update outright — it caught this line when it was
  // written the obvious way, which is the guard doing exactly its job.
  await prisma.promotion.updateMany({
    where: { id: sale.id, storeId: store.id },
    data: { active: false },
  });
  const afterStop = await getBusinessUnderstanding(store.id);
  check("the stopped sale is gone", afterStop.activePromotions.some((p) => p.id === sale.id), false);
  check("and the one still running remains", afterStop.activePromotions.length, 1);

  console.log("=== 5. another business's sale is never visible here ===");
  await prisma.promotion.create({
    data: { storeId: other.id, name: "Not Yours", kind: "SALE", discountType: "PERCENTAGE", percentOff: 90, scope: "ALL_PRODUCTS", active: true },
  });
  const stillMine = await getBusinessUnderstanding(store.id);
  check("no promotion leaks between businesses", stillMine.activePromotions.some((p) => p.name === "Not Yours"), false);
  check("and the other business sees its own", (await getBusinessUnderstanding(other.id)).activePromotions.length, 1);

  console.log("");
  console.log(`${failures} failed, ${passes} passed`);
  for (const label of failed) console.log(`  - ${label}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
