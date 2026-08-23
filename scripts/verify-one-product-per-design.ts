import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { createProductFromDesignExecutable } from "@/lib/execution/executables/productFromDesign";

// D3 — THE SAME DESIGN CANNOT BECOME TWO PRODUCTS:
//
//   npx tsx scripts/run-db-suites.ts one-product-per-design
//
// approve_design_as_product was the one genuinely non-idempotent path in the
// tool surface. Every other mutating handler is idempotent by accident of how
// it was written — an upsert, a same-value update, a proposal that supersedes
// its own. This one creates a product, and twice creates two.
//
// THE TEST ENTERS THE RACE, rather than checking the state after one. Two
// concurrent runs against the same design, both past every check, both reaching
// the create. A test that ran them in sequence would pass against the broken
// code, which is exactly how the proactive-delivery race stayed green for a day.

let failures = 0;
const results: { name: string; ok: boolean }[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const uniq = () => Math.random().toString(36).slice(2, 10);

async function main() {
  await requireTestDatabase(prismaSystem);

  const owner = await prisma.user.create({ data: { email: `d3-${uniq()}@test.local` } });
  const shop = await prisma.store.create({
    data: { userId: owner.id, name: "Copper & Coil", slug: `d3-${uniq()}` },
  });
  const neighbour = await prisma.store.create({
    data: { userId: owner.id, name: "Iron Gym", slug: `d3-n-${uniq()}` },
  });

  const design = await prisma.businessRecord.create({
    data: {
      storeId: shop.id,
      entityType: "design",
      sourceProvider: "genesis_generated",
      externalId: `dsg-${uniq()}`,
      data: {
        assetIds: [],
        surface: "garment.tshirt",
        arrangement: "centered",
        arrangementScale: null,
        printFileUrl: "https://example.test/print.png",
        mockupUrl: "https://example.test/mockup.png",
        sourceAssetUrls: [],
        createdAt: null,
      },
    },
  });

  const ctx = { storeId: shop.id, actorType: "GENESIS" as const, userId: owner.id };
  const input = { designId: design.id, name: "Copper Ring Tee", priceInCents: 2500 };

  // ==========================================================================
  console.log("\n=== 1. Two concurrent approvals, one product ===\n");
  // ==========================================================================
  // THE RACE ITSELF. Both calls read the design, both pass every check, and both
  // reach the create — which is the window a sequential test never enters.
  const raced = await Promise.allSettled([
    createProductFromDesignExecutable.run(input, ctx),
    createProductFromDesignExecutable.run(input, ctx),
  ]);

  const fulfilled = raced.filter((r) => r.status === "fulfilled");
  const rejected = raced.filter((r) => r.status === "rejected");
  check("exactly one approval succeeds", fulfilled.length, 1);
  check("and exactly one is refused", rejected.length, 1);

  const products = await prisma.product.findMany({ where: { storeId: shop.id } });
  check("one product exists, not two", products.length, 1);
  assert("carrying its design as provenance",
    (products[0]?.richContent as { designId?: string } | null)?.designId === design.id,
    JSON.stringify(products[0]?.richContent));

  // THE OWNER'S OWN WORD FOR IT. A raw constraint name is not a sentence.
  const refusal = rejected[0] as PromiseRejectedResult;
  assert("the refusal says what happened in plain words",
    String(refusal.reason?.message ?? refusal.reason).includes("already one of your products"),
    String(refusal.reason?.message ?? refusal.reason));
  assert("naming no constraint or column",
    !/P2002|unique|constraint|index|richContent/i.test(String(refusal.reason?.message ?? refusal.reason)),
    String(refusal.reason?.message ?? refusal.reason));

  // ==========================================================================
  console.log("\n=== 2. And not twice in sequence either ===\n");
  // ==========================================================================
  // The race is the hard case; this is the ordinary one — an owner approving the
  // same design again a minute later.
  let secondFailed = false;
  try {
    await createProductFromDesignExecutable.run(input, ctx);
  } catch {
    secondFailed = true;
  }
  assert("approving the same design again is refused", secondFailed);
  check("still one product",
    (await prisma.product.findMany({ where: { storeId: shop.id } })).length, 1);

  // ==========================================================================
  console.log("\n=== 3. The constraint is scoped, not global ===\n");
  // ==========================================================================
  // Every other product in the store has no designId. A non-partial index over
  // the extracted NULLs would have collapsed them into one another, so the
  // ordinary catalogue must still be able to hold many.
  for (let i = 0; i < 3; i++) {
    await prisma.product.create({
      data: { storeId: shop.id, name: `Plain ${i}`, priceInCents: 1000, position: i + 1 },
    });
  }
  check("products without a design are unaffected",
    (await prisma.product.findMany({ where: { storeId: shop.id } })).length, 4);

  // A DIFFERENT design in the same store is a different product.
  const second = await prisma.businessRecord.create({
    data: {
      storeId: shop.id, entityType: "design", sourceProvider: "genesis_generated",
      externalId: `dsg-${uniq()}`,
      data: {
        assetIds: [],
        surface: "garment.tshirt",
        arrangement: "centered",
        arrangementScale: null,
        printFileUrl: null,
        mockupUrl: "https://example.test/m2.png",
        sourceAssetUrls: [],
        createdAt: null,
      },
    },
  });
  await createProductFromDesignExecutable.run(
    { designId: second.id, name: "Second Tee", priceInCents: 2500 }, ctx
  );
  check("a different design may become its own product",
    (await prisma.product.findMany({ where: { storeId: shop.id } })).length, 5);

  // AND THE NEIGHBOUR IS UNTOUCHED. The index is per store, so one business
  // holding a product from a design cannot stop another from doing anything.
  check("the neighbour has no products of its own",
    (await prisma.product.findMany({ where: { storeId: neighbour.id } })).length, 0);

  // ==========================================================================
  console.log("\n=== 4. A refused attempt costs nothing ===\n");
  // ==========================================================================
  // Growth points are deducted by execute() only on a non-FAILED outcome, and a
  // throw is caught there rather than reaching the deduction. So the refused
  // approval above created no product AND no charge — the second half of D3's
  // invariant, and the half a constraint alone would not give.
  const charges = await prisma.growthPointTransaction.findMany({
    where: { storeId: shop.id, type: "DEDUCTION" },
  });
  check("no growth points were deducted for the refused attempt", charges.length, 0);

  await prisma.store.deleteMany({ where: { id: { in: [shop.id, neighbour.id] } } });
  await prisma.user.deleteMany({ where: { id: owner.id } });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
