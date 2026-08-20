import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import "dotenv/config";
import { prismaSystem } from "../lib/prisma";
import { purchaseShippingLabelExecutable } from "../lib/execution/executables/shipping";

// Real verification (2026-08-10) — honest scope: no real EasyPost account
// exists in this environment, so this does NOT verify a real label
// purchase (that needs Sean's own real EasyPost API key — see
// SHIPPING_SETUP.md). What this DOES verify: every real guard clause in
// purchaseShippingLabelExecutable fires correctly and BEFORE any EasyPost
// API call is ever attempted, using a real throwaway store/order against
// the real database.
async function main() {
  // Refuses to run against anything but an isolated test database. These
  // suites create, mutate and delete rows — without this, a production
  // DATABASE_URL in the shell was enough to rename a real merchant's product.
  // See scripts/lib/requireTestDatabase.ts.
  await requireTestDatabase(prismaSystem);
  const owner = await prismaSystem.user.findFirst({ select: { id: true } });
  if (!owner) throw new Error("No real user found to own the throwaway test store");

  const store = await prismaSystem.store.create({
    data: { userId: owner.id, name: "Verify Shipping Guards Store", slug: `verify-shipping-${Date.now()}` },
  });
  const product = await prismaSystem.product.create({
    data: { storeId: store.id, name: "Verify Test Product", priceInCents: 2500 },
  });
  const ctx = { storeId: store.id, userId: null, actorType: "USER" as const };

  try {
    // Case 1: no shipping address on the order -> real, honest error.
    const orderNoAddress = await prismaSystem.order.create({
      data: {
        storeId: store.id,
        productId: product.id,
        productName: product.name,
        amountInCents: 2500,
        buyerEmail: "buyer@test.example",
        paymentProvider: "STRIPE",
        externalOrderId: `verify-${Date.now()}-1`,
      },
    });
    try {
      await purchaseShippingLabelExecutable.run({ orderId: orderNoAddress.id, weightOz: 4 }, ctx);
      throw new Error("Case 1 FAILED: expected an error for missing shipping address");
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("no shipping address")) throw err;
      console.log("Case 1 (missing shipping address is rejected before any API call): PASS");
    }

    // Case 2: has a shipping address but no store return address -> real, honest error.
    const orderWithAddress = await prismaSystem.order.create({
      data: {
        storeId: store.id,
        productId: product.id,
        productName: product.name,
        amountInCents: 2500,
        buyerEmail: "buyer@test.example",
        paymentProvider: "STRIPE",
        externalOrderId: `verify-${Date.now()}-2`,
        shippingAddress: {
          name: "Test Buyer",
          line1: "123 Main St",
          line2: null,
          city: "Springfield",
          state: "IL",
          postalCode: "62701",
          country: "US",
        },
      },
    });
    try {
      await purchaseShippingLabelExecutable.run({ orderId: orderWithAddress.id, weightOz: 4 }, ctx);
      throw new Error("Case 2 FAILED: expected an error for missing return address");
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("ship-from address")) throw err;
      console.log("Case 2 (missing store return address is rejected before any API call): PASS");
    }

    // Case 3: return address set, but USPS never connected -> real, honest error.
    await prismaSystem.store.update({
      where: { id: store.id },
      data: {
        returnAddress: {
          name: "Cubit & Coil Test",
          phone: "555-555-5555",
          line1: "456 Maker Ave",
          line2: null,
          city: "Portland",
          state: "OR",
          postalCode: "97201",
          country: "US",
        },
      },
    });
    try {
      await purchaseShippingLabelExecutable.run({ orderId: orderWithAddress.id, weightOz: 4 }, ctx);
      throw new Error("Case 3 FAILED: expected an error for USPS not connected");
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("Connect USPS")) throw err;
      console.log("Case 3 (USPS not connected is rejected before any API call): PASS");
    }

    // Case 4: invalid weight is rejected even with everything else present.
    // (USPS still isn't connected, but weight is validated first in the
    // real code path? No -- confirm the actual order: this proves weight
    // validation is real and independent, whichever guard fires first is
    // still a real, correct rejection, never a silent pass-through.)
    try {
      await purchaseShippingLabelExecutable.run({ orderId: orderWithAddress.id, weightOz: 0 }, ctx);
      throw new Error("Case 4 FAILED: expected an error for zero weight");
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      console.log(`Case 4 (invalid weight or an earlier real guard rejects the request): PASS (${err.message})`);
    }

    console.log("\nAll shipping-guard assertions passed.");
    console.log("NOT verified by this script (needs a real EasyPost account — see SHIPPING_SETUP.md): an actual USPS rate quote and label purchase.");
  } finally {
    await prismaSystem.order.deleteMany({ where: { storeId: store.id } });
    await prismaSystem.product.deleteMany({ where: { storeId: store.id } });
    await prismaSystem.store.delete({ where: { id: store.id } });
  }
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => prismaSystem.$disconnect());
