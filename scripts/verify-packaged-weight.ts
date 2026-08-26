import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import {
  parsePackagedWeight,
  toPoundsAndOunces,
  describePackagedWeight,
  parsePackagedDimensions,
  describePackageDimensions,
  OUNCES_PER_POUND,
  MAX_DIMENSION_IN,
} from "@/lib/shipping/packagedWeight";
import { shippedBy, ownerPacksThis, packagingHandledBy } from "@/lib/shipping/whoShips";
// NOT IMPORTED HERE. lib/fulfillment/parcel reaches the connector registry,
// which reaches lib/prisma at module load — before DATABASE_URL below is
// pointed at the throwaway Postgres. A static import binds that client to the
// wrong database and every query after it is refused. Imported inside main()
// instead, with everything else that touches the database.
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
const dims = (r: ReturnType<typeof parsePackagedDimensions>) =>
  r.ok ? [r.lengthIn, r.widthIn, r.heightIn] : `ERROR: ${r.error}`;

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;
  // A throwaway key, so the EasyPost credentials this suite writes can be
  // stored and read back the way the real ones are. Set before the credential
  // module is imported, which reads it at load.
  process.env.INTEGRATION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

  // Imported after the database is pointed at, so every client binds to it —
  // including the two shipping modules, which hold their own reference.
  const { prisma } = await import("@/lib/prisma");
  const { parcelForProduct } = await import("@/lib/shipping/rates");
  const { productSupportsLiveShipping } = await import("@/lib/shipping/checkoutShipping");
  const { editProductExecutable } = await import("@/lib/execution/executables/products");
  const { purchaseLabelForOrder } = await import("@/lib/execution/executables/shipping");
  const { parcelToProductData, hasAnyMeasurement, partnerParcelFor, NO_PARTNER_PARCEL } =
    await import("@/lib/fulfillment/parcel");
  const { printfulFulfillmentConnector } = await import("@/lib/fulfillment/printful");
  const { encryptCredentials } = await import("@/lib/integrations/credentials");

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

  // ========================================================================
  console.log("\n=== 7. The other three sides of the parcel ===\n");
  // ========================================================================
  // lengthIn/widthIn/heightIn arrived in the same 2026-08-20 migration as
  // weightOz and were written by nothing either. Rating fell back to 6x4x2 for
  // every product in the system — right for a ring in a mailer, wrong for
  // anything bigger, and Priority Mail prices dimensional weight.

  eq("three measurements become three numbers", dims(parsePackagedDimensions("10", "8", "4")), [10, 8, 4]);
  eq("fractions of an inch survive", dims(parsePackagedDimensions("10.5", "8", "0.75")), [10.5, 8, 0.75]);
  eq("all three blank clears them", dims(parsePackagedDimensions("", "", "")), [null, null, null]);
  eq("and so does nothing at all", dims(parsePackagedDimensions(null, undefined, "  ")), [null, null, null]);

  // ALL THREE OR NONE. Two of three is not a partly-known parcel; it is one
  // where the rating code silently substitutes a default for the third, which
  // is the invented number this whole field exists to remove.
  assert("two of three is refused", !parsePackagedDimensions("10", "8", "").ok);
  assert("one of three is refused", !parsePackagedDimensions("10", "", "").ok);
  assert("and the refusal says which way out there is",
    /leave all three blank/.test(String(dims(parsePackagedDimensions("10", "8", "")))),
    "clearing them is a real answer and the merchant has to be told so");

  // POSITIVE, every one of them.
  assert("a zero side is refused", !parsePackagedDimensions("10", "8", "0").ok);
  assert("a negative side is refused", !parsePackagedDimensions("10", "-8", "4").ok);
  assert("CONTROL: and a zero is refused wherever it sits, not only last",
    !parsePackagedDimensions("0", "8", "4").ok && !parsePackagedDimensions("10", "0", "4").ok,
    "every position validated, not just the one the loop happened to read");
  assert("words are refused", !parsePackagedDimensions("ten", "8", "4").ok);
  assert("over the domestic size limit is refused",
    !parsePackagedDimensions(String(MAX_DIMENSION_IN + 1), "8", "4").ok,
    "caught where it is typed rather than at checkout, in front of a customer");
  eq("CONTROL: and the limit itself is allowed",
    dims(parsePackagedDimensions(String(MAX_DIMENSION_IN), "8", "4")), [MAX_DIMENSION_IN, 8, 4]);

  eq("stored dimensions read as a sentence", describePackageDimensions(10, 8, 4), "10 × 8 × 4 in");
  eq("and a partial set describes nothing", describePackageDimensions(10, null, 4), null);

  // --- saved, cleared, and left alone -------------------------------------
  await editProductExecutable.run(
    { productId: product.id, name: "Renamed Ring", weightOz: 20, lengthIn: 10, widthIn: 8, heightIn: 4 }, ctx
  );
  const boxed = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
  eq("the box is stored", [boxed.lengthIn, boxed.widthIn, boxed.heightIn], [10, 8, 4]);
  eq("CONTROL: alongside the weight, not instead of it", boxed.weightOz, 20);

  await editProductExecutable.run(
    { productId: product.id, lengthIn: null, widthIn: null, heightIn: null }, ctx
  );
  const cleared = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
  eq("clearing them stores null, never zero",
    [cleared.lengthIn, cleared.widthIn, cleared.heightIn], [null, null, null]);
  eq("CONTROL: and clearing the box does not clear the weight", cleared.weightOz, 20);

  // THE OVERWRITE THIS GUARDS AGAINST. An edit that does not mention the box
  // must leave it exactly as the merchant measured it — the same
  // presence-not-truthiness rule a naming edit once broke on brand identity,
  // where naming a field it wasn't changing wrote undefined over a real value.
  await editProductExecutable.run(
    { productId: product.id, lengthIn: 10, widthIn: 8, heightIn: 4 }, ctx
  );
  await editProductExecutable.run({ productId: product.id, name: "Tensor Ring", priceInCents: 3499 }, ctx);
  const afterUnrelated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
  eq("editing name and price leaves the merchant's measurements alone",
    [afterUnrelated.lengthIn, afterUnrelated.widthIn, afterUnrelated.heightIn], [10, 8, 4]);
  eq("CONTROL: and the price really changed", afterUnrelated.priceInCents, 3499);

  const boxVerified = await editProductExecutable.verify(
    { productId: product.id, lengthIn: 10, widthIn: 8, heightIn: 4 }, ctx, undefined as never
  );
  eq("the read-back verifies the stored box", boxVerified.state, "verified");
  const wrongBox = await editProductExecutable.verify(
    { productId: product.id, lengthIn: 99, widthIn: 8, heightIn: 4 }, ctx, undefined as never
  );
  assert("CONTROL: and would have caught a box that did not land",
    wrongBox.state !== "verified",
    "a verify that passes on the wrong number verifies nothing");

  // --- what rating does with them -----------------------------------------
  const measured = parcelForProduct({ weightOz: 20, lengthIn: 10, widthIn: 8, heightIn: 4 });
  eq("rating uses the measurements it was given",
    [measured?.lengthIn, measured?.widthIn, measured?.heightIn], [10, 8, 4]);
  const unmeasured = parcelForProduct({ weightOz: 20, lengthIn: null, widthIn: null, heightIn: null });
  assert("and falls back to a mailer only where there is genuinely nothing",
    unmeasured !== null && unmeasured.lengthIn === 6 && unmeasured.widthIn === 4 && unmeasured.heightIn === 2);
  assert("CONTROL: the fallback never displaces an entered value",
    measured !== null && measured.lengthIn !== 6 && measured.widthIn !== 4 && measured.heightIn !== 2,
    "a default that overwrote a measurement would quote the wrong box on every order");

  // --- and the merchant can still change them at the label -----------------
  assert("the label form is pre-filled with the product box",
    /defaultValue=\{parcel\.lengthIn \?\? undefined\}/.test(list) &&
    /defaultValue=\{parcel\.widthIn \?\? undefined\}/.test(list) &&
    /defaultValue=\{parcel\.heightIn \?\? undefined\}/.test(list));
  assert("and stays editable, because the packed box may not be the estimated one",
    !/name="lengthIn"[\s\S]{0,200}readOnly/.test(list));

  assert("the product form asks for all three",
    /name="lengthIn"/.test(form) && /name="widthIn"/.test(form) && /name="heightIn"/.test(form));
  assert("in the same shipping section as the weight",
    form.indexOf('name="lengthIn"') > form.indexOf('name="weightLb"'),
    "one place a merchant describes the parcel, not two");
  assert("and says the box is what is being described",
    /Package dimensions/.test(form) && /box as it goes out/.test(form));

  // ========================================================================
  console.log("\n=== 8. Only whoever actually packs it is asked ===\n");
  // ========================================================================
  // ProductSourceKind has recorded who ships each kind since 2026-08-20 — in
  // its own schema comments, no less — and nothing read it. So a Printful shirt
  // that J4 created, boxed in Printful's warehouse and posted by Printful, was
  // asked for a packaged weight the owner could not possibly know, and would
  // have been offered a Buy Label button for a parcel not in the building.

  eq("what the owner makes, the owner ships", shippedBy("OWNER_MADE"), "OWNER");
  eq("wholesale they hold and post, likewise", shippedBy("WHOLESALE_STOCKED"), "OWNER");
  eq("private label, likewise", shippedBy("PRIVATE_LABEL"), "OWNER");
  eq("contract manufactured, likewise", shippedBy("CONTRACT_MANUFACTURED"), "OWNER");
  eq("print on demand is shipped by the partner", shippedBy("PRINT_ON_DEMAND"), "PARTNER");
  eq("so is a dropshipped order", shippedBy("WHOLESALE_DROPSHIP"), "PARTNER");
  eq("and a digital product ships nothing at all", shippedBy("DIGITAL"), "NOBODY");
  // Every product that predates sourcing, and every manually created one.
  eq("an unsourced product is the owner's to ship", shippedBy(null), "OWNER");

  assert("only the owner is asked to pack",
    ownerPacksThis("OWNER_MADE") && !ownerPacksThis("PRINT_ON_DEMAND") && !ownerPacksThis("DIGITAL"));
  assert("and a partner-shipped product says who does instead",
    (packagingHandledBy("PRINT_ON_DEMAND", "Printful") ?? "").includes("Printful"));
  eq("while an owner-shipped one has nothing to explain",
    packagingHandledBy("OWNER_MADE", null), null);

  // --- the gate the storefront actually uses -------------------------------
  await prisma.product.update({
    where: { id: product.id, storeId: store.id },
    data: { weightOz: 20, lengthIn: 10, widthIn: 8, heightIn: 4, active: true, sourceKind: "OWNER_MADE" },
  });
  eq("an owner-made product with a weight can be quoted",
    await productSupportsLiveShipping(store.id, product.id), true);

  // THE SAME PRODUCT, SAME WEIGHT, ONLY WHO SHIPS IT CHANGED. Rates here are
  // quoted against the OWNER'S OWN EasyPost account and the label is theirs to
  // print — so quoting them for a parcel a partner posts would charge the
  // customer for postage nobody in this business will ever buy.
  await prisma.product.update({
    where: { id: product.id, storeId: store.id },
    data: { sourceKind: "PRINT_ON_DEMAND" },
  });
  eq("a partner-shipped product is not quoted against the owner's account",
    await productSupportsLiveShipping(store.id, product.id), false);
  await prisma.product.update({
    where: { id: product.id, storeId: store.id },
    data: { sourceKind: "DIGITAL" },
  });
  eq("and neither is one that ships nothing",
    await productSupportsLiveShipping(store.id, product.id), false);
  await prisma.product.update({
    where: { id: product.id, storeId: store.id },
    data: { sourceKind: "OWNER_MADE" },
  });
  eq("CONTROL: and it opens again for the owner's own",
    await productSupportsLiveShipping(store.id, product.id), true);

  const editForm = codeOnly(
    readFileSync(join(process.cwd(), "app", "dashboard", "products", "EditProductForm.tsx"), "utf8")
  );
  assert("the product form asks who packs it before asking what it weighs",
    /packagingHandledBy\(/.test(editForm) && /packedByOther \?/.test(editForm),
    "otherwise an owner is asked to invent a number that becomes real postage");

  const ordersList = codeOnly(
    readFileSync(join(process.cwd(), "app", "dashboard", "OrdersList.tsx"), "utf8")
  );
  assert("and no label is offered for a parcel the owner never holds",
    /order\.shippedBy === "OWNER" && canBuyLabel/.test(ordersList));
  assert("with the partner named rather than a silent gap",
    /Your fulfilment partner ships this one/.test(ordersList));

  // ========================================================================
  console.log("\n=== 9. Packaging from the partner, when the partner has it ===\n");
  // ========================================================================
  // The requirement is that a partner-created product never needs its weight
  // typed in. Neither Printful nor Printify exposes one — checked field by
  // field against both APIs' own documentation on 2026-08-26 — so what is
  // asserted here is the SEAM: whatever a partner does supply is written, and
  // what it does not supply is left alone rather than zeroed.

  eq("nothing supplied writes nothing", parcelToProductData(NO_PARTNER_PARCEL), {});
  eq("a weight alone contributes the weight",
    parcelToProductData({ weightOz: 6, lengthIn: null, widthIn: null, heightIn: null }),
    { weightOz: 6 });
  eq("a full parcel contributes all four",
    parcelToProductData({ weightOz: 6, lengthIn: 10, widthIn: 8, heightIn: 4 }),
    { weightOz: 6, lengthIn: 10, widthIn: 8, heightIn: 4 });
  // ALL THREE OR NONE, the same rule the form enforces: two of three would
  // leave rating substituting a default for the third.
  eq("a partial box contributes no box",
    parcelToProductData({ weightOz: 6, lengthIn: 10, widthIn: null, heightIn: 4 }),
    { weightOz: 6 });
  eq("and zeroes are not measurements",
    parcelToProductData({ weightOz: 0, lengthIn: 0, widthIn: 0, heightIn: 0 }), {});
  assert("a parcel with nothing in it is recognised as empty",
    !hasAnyMeasurement(NO_PARTNER_PARCEL) &&
      hasAnyMeasurement({ weightOz: 6, lengthIn: null, widthIn: null, heightIn: null }));

  // Printful answers honestly rather than being left unimplemented, so the
  // absence is recorded in code instead of being re-investigated later.
  eq("Printful is asked and says it does not know",
    await printfulFulfillmentConnector.getParcel!({
      storeId: store.id, storeDraftId: null, externalProductId: "1", externalVariantId: "1",
    }),
    null);
  eq("and asking a partner that cannot answer yields nothing, never a throw",
    await partnerParcelFor({
      provider: "PRINTFUL", storeId: store.id, storeDraftId: null,
      externalProductId: "1", externalVariantId: "1",
    }),
    NO_PARTNER_PARCEL);
  eq("as does asking about a product with no partner at all",
    await partnerParcelFor({
      provider: null, storeId: store.id, storeDraftId: null,
      externalProductId: null, externalVariantId: null,
    }),
    NO_PARTNER_PARCEL);

  const fromDesign = codeOnly(
    readFileSync(join(process.cwd(), "lib", "execution", "executables", "productFromDesign.ts"), "utf8")
  );
  assert("a product J4 hands to a partner records that the partner has it",
    /fulfillmentProvider: connector\.provider/.test(fromDesign) &&
      /sourceKind: "PRINT_ON_DEMAND"/.test(fromDesign),
    "this wrote externalProductId alone, so the product looked owner-made and the owner was asked to weigh it");
  assert("and writes whatever packaging the partner did supply",
    /\.\.\.parcelToProductData\(parcel\)/.test(fromDesign));

  const adopt = codeOnly(readFileSync(join(process.cwd(), "lib", "sourcing", "adopt.ts"), "utf8"));
  assert("adoption does the same",
    /\.\.\.parcelToProductData\(parcel\)/.test(adopt));
  assert("and asks the partner OUTSIDE the transaction",
    adopt.indexOf("partnerParcelFor") < adopt.indexOf("prisma.$transaction"),
    "a network call under a row lock serialises every adoption behind the slowest partner");

  // ========================================================================
  console.log("\n=== 10. What actually shipped, kept as its own fact ===\n");
  // ========================================================================
  // Product.weightOz is the owner's standing ESTIMATE. What a label was really
  // bought against is a different number — the owner weighs the box after
  // packing it — and it was recorded nowhere.

  const bare = await prisma.product.create({
    data: { storeId: store.id, name: "Unmeasured", priceInCents: 1000, sourceKind: "OWNER_MADE" },
  });
  const order = await prisma.order.create({
    data: {
      storeId: store.id, productId: bare.id, productName: "Unmeasured",
      amountInCents: 1000, buyerEmail: "b@test.local", status: "paid",
      paymentProvider: "STRIPE", externalOrderId: `cs_${uniq()}`,
      shippingAddress: {
        name: "Sarah Chen", line1: "1600 Pearl St", city: "Boulder",
        state: "CO", postalCode: "80302", country: "US",
      },
    },
  });
  await prisma.store.update({
    where: { id: store.id },
    data: {
      returnAddress: {
        name: "Cubit & Coil", line1: "417 Montgomery St", city: "San Francisco",
        state: "CA", postalCode: "94104", country: "US",
      },
    },
  });
  await prisma.storeIntegration.updateMany({
    where: { storeId: store.id, provider: "EASYPOST" },
    data: { status: "CONNECTED", credentials: encryptCredentials({ apiKey: "EZTK_test" }) },
  });

  // The buyer is injected, so no postage is bought and no key is spent.
  const fakeBuyer = async () => ({
    carrier: "USPS", service: "Priority Mail", trackingNumber: "9400111899223197428490",
    trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490",
    labelUrl: "https://example.test/label.pdf", costInCents: 892,
  });

  await purchaseLabelForOrder(
    { orderId: order.id, weightOz: 26, lengthIn: 12, widthIn: 9, heightIn: 5 },
    { storeId: store.id } as never,
    fakeBuyer as never
  );

  const shipped = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  eq("the order records the weight the label was bought against", shipped.parcelWeightOz, 26);
  eq("and the box it was bought against",
    [shipped.parcelLengthIn, shipped.parcelWidthIn, shipped.parcelHeightIn], [12, 9, 5]);
  eq("CONTROL: alongside what the postage cost", shipped.shippingCostInCents, 892);

  // AND THE PRODUCT LEARNS IT — but only because it knew nothing.
  const learned = await prisma.product.findUniqueOrThrow({ where: { id: bare.id } });
  eq("a product with no weight learns the one that shipped", learned.weightOz, 26);
  eq("and the box", [learned.lengthIn, learned.widthIn, learned.heightIn], [12, 9, 5]);

  // NEVER OVERWRITES. A one-off heavier box must not silently rewrite the
  // estimate every future quote is built from — Sean's own instruction.
  const alreadyMeasured = await prisma.product.create({
    data: {
      storeId: store.id, name: "Already measured", priceInCents: 1000,
      sourceKind: "OWNER_MADE", weightOz: 20, lengthIn: 10, widthIn: 8, heightIn: 4,
    },
  });
  const order2 = await prisma.order.create({
    data: {
      storeId: store.id, productId: alreadyMeasured.id, productName: "Already measured",
      amountInCents: 1000, buyerEmail: "b2@test.local", status: "paid",
      paymentProvider: "STRIPE", externalOrderId: `cs_${uniq()}`,
      shippingAddress: {
        name: "Sarah Chen", line1: "1600 Pearl St", city: "Boulder",
        state: "CO", postalCode: "80302", country: "US",
      },
    },
  });
  await purchaseLabelForOrder(
    { orderId: order2.id, weightOz: 44, lengthIn: 16, widthIn: 12, heightIn: 8 },
    { storeId: store.id } as never,
    fakeBuyer as never
  );

  const untouched = await prisma.product.findUniqueOrThrow({ where: { id: alreadyMeasured.id } });
  eq("a product the owner already measured keeps their weight", untouched.weightOz, 20);
  eq("and their box", [untouched.lengthIn, untouched.widthIn, untouched.heightIn], [10, 8, 4]);
  const shipped2 = await prisma.order.findUniqueOrThrow({ where: { id: order2.id } });
  eq("while the order still records what really shipped", shipped2.parcelWeightOz, 44);
  assert("so the estimate and the actual parcel are separate facts",
    untouched.weightOz !== shipped2.parcelWeightOz,
    "one heavier box must not rewrite every future quote");

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
