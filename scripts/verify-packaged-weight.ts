import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import {
  parsePackagedWeight,
  toPoundsAndOunces,
  describePackagedWeight,
  OUNCES_PER_POUND,
} from "@/lib/shipping/packagedWeight";
import { readFileSync } from "fs";
import { join } from "path";

// THE FIELD THAT MAKES SHIPPING REACHABLE:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-packaged-weight.ts" -OutFile out.txt
//
// Product.weightOz has existed since 2026-08-20. Checkout rating reads it, the
// label form reads it, and NOTHING HAS EVER WRITTEN IT — all 55 production
// products have it null, so productSupportsLiveShipping returns false for every
// one of them, the checkout shipping step is unreachable for every store, and
// none of the five real orders carries a shipping charge.
//
// This suite is about that one field, and about the path it unlocks: a weight
// the merchant can enter, stored in the unit the system already uses, picked up
// by rating without anything else changing.
//
// BRINGS ITS OWN POSTGRES, and is therefore NOT in the shared runner — the same
// arrangement verify-attach-tracking, verify-owner-facts and
// verify-conversations already use, and for the same measured reason: added as
// a 43rd shared suite it killed the harness outright with ECONNRESET. A green
// shared count does not include this file, so it has to be run.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const uniq = () => Math.random().toString(36).slice(2, 10);
const ok = (r: ReturnType<typeof parsePackagedWeight>) => (r.ok ? r.weightOz : `ERROR: ${r.error}`);

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  // Imported after the database is pointed at, so every client binds to it —
  // including the two shipping modules, which hold their own reference.
  const { prisma } = await import("@/lib/prisma");
  const { parcelForProduct } = await import("@/lib/shipping/rates");
  const { productSupportsLiveShipping } = await import("@/lib/shipping/checkoutShipping");
  const { editProductExecutable } = await import("@/lib/execution/executables/products");

  // ========================================================================
  console.log("\n=== 1. Pounds and ounces become ounces ===\n");
  // ========================================================================
  eq("a pound is sixteen ounces", ok(parsePackagedWeight("1", "")), OUNCES_PER_POUND);
  eq("one pound four ounces", ok(parsePackagedWeight("1", "4")), 20);
  eq("ounces alone need no zero pounds", ok(parsePackagedWeight("", "12")), 12);
  eq("pounds alone need no zero ounces", ok(parsePackagedWeight("3", "")), 48);
  eq("a fractional ounce survives", ok(parsePackagedWeight("", "4.6")), 4.6);
  assert("because a carrier prices what it weighs, not what it rounds to",
    ok(parsePackagedWeight("", "4.6")) === 4.6);

  // ========================================================================
  console.log("\n=== 2. What is refused, and what is not ===\n");
  // ========================================================================
  eq("both blank clears the weight rather than erroring",
    ok(parsePackagedWeight("", "")), 0);
  assert("because refusing to let a merchant undo a mistake is worse than the mistake",
    parsePackagedWeight("", "").ok);
  assert("an explicit zero is refused", !parsePackagedWeight("0", "0").ok,
    "somebody asserting a parcel weighs nothing, which no carrier will price");
  assert("a negative weight is refused", !parsePackagedWeight("-1", "").ok);
  assert("and a negative ounce", !parsePackagedWeight("", "-4").ok);
  assert("letters are refused", !parsePackagedWeight("heavy", "").ok);
  assert("and so is a blank-looking non-number", !parsePackagedWeight("", "abc").ok);
  assert("over the 70 lb domestic ceiling is refused",
    !parsePackagedWeight("71", "").ok,
    "caught where it was entered rather than at checkout in front of a customer");
  assert("CONTROL: exactly 70 lb is allowed", parsePackagedWeight("70", "").ok);

  // ========================================================================
  console.log("\n=== 3. It round-trips ===\n");
  // ========================================================================
  eq("20 oz reads back as 1 lb 4 oz", toPoundsAndOunces(20), { pounds: "1", ounces: "4" });
  eq("12 oz stays ounces only", toPoundsAndOunces(12), { pounds: "", ounces: "12" });
  eq("48 oz is pounds only", toPoundsAndOunces(48), { pounds: "3", ounces: "" });
  eq("null is two blanks", toPoundsAndOunces(null), { pounds: "", ounces: "" });
  eq("and it reads as a sentence", describePackagedWeight(20), "1 lb 4 oz");
  eq("nothing to say about no weight", describePackagedWeight(null), null);
  for (const oz of [1, 4.6, 15, 16, 20, 48, 1120]) {
    eq(`${oz} oz survives a round trip`,
      ok(parsePackagedWeight(toPoundsAndOunces(oz).pounds, toPoundsAndOunces(oz).ounces)), oz);
  }

  // ========================================================================
  console.log("\n=== 4. Saved, loaded, and cleared ===\n");
  // ========================================================================
  const owner = await prisma.user.create({ data: { email: `pw-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Copper & Coil", slug: `pw-${uniq()}` },
  });
  const product = await prisma.product.create({
    data: { storeId: store.id, name: "Tensor Ring", priceInCents: 2999 },
  });
  const ctx = { storeId: store.id } as never;

  eq("a new product has no weight",
    (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).weightOz, null);

  await editProductExecutable.run(
    { productId: product.id, name: "Tensor Ring", priceInCents: 2999, weightOz: 20 }, ctx
  );
  eq("saving 1 lb 4 oz stores 20",
    (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).weightOz, 20);

  // CLEARED IS NULL, NOT ZERO. Both mean "cannot quote", but null is the honest
  // one: nobody has said what this weighs.
  await editProductExecutable.run(
    { productId: product.id, name: "Tensor Ring", priceInCents: 2999, weightOz: 0 }, ctx
  );
  eq("clearing it stores null, never zero",
    (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).weightOz, null);

  // An edit that does not mention weight must not wipe one.
  await editProductExecutable.run({ productId: product.id, name: "Tensor Ring", priceInCents: 2999, weightOz: 20 }, ctx);
  await editProductExecutable.run({ productId: product.id, name: "Renamed Ring" }, ctx);
  const afterRename = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
  eq("editing the name leaves the weight alone", afterRename.weightOz, 20);
  eq("CONTROL: and the name really changed", afterRename.name, "Renamed Ring");

  const verified = await editProductExecutable.verify(
    { productId: product.id, name: "Renamed Ring", weightOz: 20 }, ctx, undefined as never
  );
  eq("the read-back verifies the stored weight", verified.state, "verified");

  // ========================================================================
  console.log("\n=== 5. Checkout rating picks it up, with nothing else changed ===\n");
  // ========================================================================
  // This is the whole point: rating already existed and was dark.
  eq("a product with no weight cannot be quoted",
    parcelForProduct({ weightOz: null, lengthIn: null, widthIn: null, heightIn: null }), null);
  assert("because a guessed weight becomes a real price on a real order",
    parcelForProduct({ weightOz: null, lengthIn: 6, widthIn: 4, heightIn: 2 }) === null,
    "having a box is not having a weight");

  const parcel = parcelForProduct({ weightOz: 20, lengthIn: null, widthIn: null, heightIn: null });
  eq("a product with a weight can be", parcel?.weightOz, 20);
  assert("and gets a default box rather than being refused",
    parcel !== null && parcel.lengthIn > 0 && parcel.widthIn > 0 && parcel.heightIn > 0,
    "dimensions matter less than weight, and weight is the one thing never invented");

  // The real gate the storefront uses, against a real row.
  //
  // WEIGHT IS ISOLATED AS THE VARIABLE. productSupportsLiveShipping requires a
  // connected EasyPost AND a connected Stripe as well — the Stripe half was
  // added 2026-08-20 after a store with EasyPost and PayPal but no Stripe took
  // a customer through the entire address-and-rates flow and then failed on the
  // buy. So both are connected here first; what this asserts is that with
  // everything else in place, the weight is what decides.
  await prisma.storeIntegration.createMany({
    data: [
      { storeId: store.id, provider: "EASYPOST", status: "CONNECTED" },
      { storeId: store.id, provider: "STRIPE", status: "CONNECTED" },
    ] as never,
  });
  await prisma.product.update({
    where: { id: product.id, storeId: store.id },
    data: { weightOz: 20, active: true },
  });
  eq("the store's own shipping gate now opens for this product",
    await productSupportsLiveShipping(store.id, product.id), true);

  await prisma.product.update({ where: { id: product.id, storeId: store.id }, data: { weightOz: null } });
  eq("CONTROL: and closes again when the weight is cleared",
    await productSupportsLiveShipping(store.id, product.id), false);

  // ========================================================================
  console.log("\n=== 6. The merchant still adjusts the final package weight ===\n");
  // ========================================================================
  const list = codeOnly(readFileSync(join(process.cwd(), "app", "dashboard", "OrdersList.tsx"), "utf8"));
  assert("the label form is pre-filled from the product",
    /defaultValue=\{parcel\.weightOz \?\? undefined\}/.test(list));
  assert("and stays editable, so the packed parcel can differ from the estimate",
    !/name="weightOz"[\s\S]{0,200}readOnly/.test(list),
    "the merchant weighs the box after packing it; that number is what buys the label");

  const form = codeOnly(readFileSync(join(process.cwd(), "app", "dashboard", "products", "EditProductForm.tsx"), "utf8"));
  assert("the product field is pounds AND ounces",
    /name="weightLb"/.test(form) && /name="weightOz"/.test(form));
  assert("and says it means the packaged weight",
    /boxed and ready to post/.test(form),
    "a merchant entering the bare product weight under-quotes every order and never sees it");

  await prisma.store.delete({ where: { id: store.id } });
  await prisma.user.delete({ where: { id: owner.id } });
  await db.close();

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
