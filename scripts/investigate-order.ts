import { prismaSystem } from "@/lib/prisma";

// WHAT ACTUALLY HAPPENED TO A REAL ORDER — READ ONLY.
//
//   npx tsx scripts/investigate-order.ts
//
// Sean, 2026-08-31: "Do not invent a reversal or mutate a real order just to
// test it. Determine what that action actually changed, whether it can be
// safely reversed, and report back before modifying the real order."
//
// So it reads and reports, and there is no write path in this file.
//
// RAW SQL, ON PURPOSE. The deployed database is several migrations behind this
// branch — Order.disputeStatus does not exist there — so the generated client
// asks for columns production has never had. Reading the column list first and
// selecting only what is really there is the difference between investigating
// the order and crashing on the way to it.

async function main(): Promise<void> {
  const columns = await prismaSystem.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'Order' ORDER BY ordinal_position`,
  );
  const have = new Set(columns.map((c) => c.column_name));
  console.log(`\nThe deployed Order table has ${have.size} columns.\n`);

  const wanted = [
    "id", "storeId", "productName", "quantity", "amountInCents", "buyerEmail", "status",
    "paymentProvider", "externalOrderId", "externalPaymentId", "shippingAddress",
    "shippingAddressVerification", "fulfillmentStatus", "fulfilledAt", "carrier",
    "trackingNumber", "trackingUrl", "labelUrl", "labelClaimedAt", "shippingCostInCents",
    "shippingChargedInCents", "listSubtotalInCents", "discountInCents", "appliedPromotionLabel",
    "shipmentStatus", "deliveredAt", "confirmationSentAt", "shipmentNotifiedAt",
    "ownerNotifiedAt", "disputeStatus", "createdAt",
  ].filter((c) => have.has(c));

  const missing = [
    "disputeStatus", "listSubtotalInCents", "discountInCents", "quantity", "shipmentStatus",
    "ownerNotifiedAt", "shippingAddressVerification",
  ].filter((c) => !have.has(c));
  if (missing.length) {
    console.log(`NOT DEPLOYED (columns this branch has and production does not):`);
    console.log(`  ${missing.join(", ")}\n`);
  }

  const select = wanted.map((c) => `"${c}"`).join(", ");
  const orders = await prismaSystem.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT ${select} FROM "Order" ORDER BY "createdAt" DESC LIMIT 10`,
  );

  console.log(`${orders.length} most recent order(s).\n`);
  for (const order of orders) {
    console.log("=".repeat(70));
    for (const key of wanted) {
      const value = order[key];
      if (value === null || value === undefined) continue;
      console.log(`  ${key.padEnd(30)} ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
    const nulls = wanted.filter((k) => order[k] === null);
    console.log(`  --- null: ${nulls.join(", ")}`);
    console.log("");
  }

  await prismaSystem.$disconnect();
}

void main();
