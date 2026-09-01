import { prismaSystem } from "@/lib/prisma";

// UNDOING ONE ACCIDENTAL CLICK, AND PROVING IT UNDID ONLY THAT.
//
//   npx tsx scripts/reverse-accidental-fulfilment.ts <orderId>
//
// ============ WHAT IS BEING REVERSED (2026-08-31) =====================
//
// An order was marked fulfilled by hand at 2026-08-31T09:59:55Z. That action —
// toggleOrderFulfilledExecutable — writes exactly two columns and does nothing
// else: no supplier order, no label, no email. Confirmed by reading it, not by
// assuming: shipmentNotifiedAt is null, carrier/trackingNumber/labelUrl are all
// null, and isEmailConfigured() is false on this deployment so nothing could
// have been sent even had something tried.
//
// Sean, having asked for the investigation first: "Safely reverse Gabriel
// Mendies' accidental fulfilled state. Restore exactly the two columns you
// identified and verify nothing else changes. Do not send anything externally."
//
// ============ SO IT SNAPSHOTS EVERY COLUMN, BOTH SIDES ================
//
// SELECT * before and after, and a diff. "Exactly the two columns" is a claim
// about all forty-eight of them, and the only honest way to make it is to look
// at all forty-eight. Raw SQL because the deployed database is ten migrations
// behind this branch — the generated client asks for columns production has
// never had.
//
// ============ AND IT REFUSES RATHER THAN GUESSES ======================
//
// The same guard the executable itself applies, re-checked here against live
// data: a parcel with tracking must not become unfulfilled, because that would
// show an order needing fulfilment while the goods are already in the post.
// If any precondition fails this exits without writing.

const REVERSIBLE_FROM = "fulfilled";
const REVERSIBLE_TO = "unfulfilled";

type Row = Record<string, unknown>;

function show(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return value.toISOString();
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

async function snapshot(orderId: string): Promise<Row | null> {
  const rows = await prismaSystem.$queryRawUnsafe<Row[]>(
    `SELECT * FROM "Order" WHERE "id" = $1`,
    orderId,
  );
  return rows[0] ?? null;
}

async function main(): Promise<void> {
  const orderId = process.argv[2];
  if (!orderId) {
    console.error("Usage: npx tsx scripts/reverse-accidental-fulfilment.ts <orderId>");
    process.exitCode = 1;
    return;
  }

  const before = await snapshot(orderId);
  if (!before) {
    console.error(`No order ${orderId}.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nOrder ${orderId}`);
  console.log(`  fulfillmentStatus  ${show(before.fulfillmentStatus)}`);
  console.log(`  fulfilledAt        ${show(before.fulfilledAt)}`);
  console.log(`  trackingNumber     ${show(before.trackingNumber)}`);
  console.log(`  labelUrl           ${show(before.labelUrl)}`);
  console.log(`  shipmentNotifiedAt ${show(before.shipmentNotifiedAt)}`);
  console.log(`  status             ${show(before.status)}\n`);

  // ---- the refusals, each with its own reason ------------------------
  const refusals: string[] = [];
  if (before.fulfillmentStatus !== REVERSIBLE_FROM) {
    refusals.push(`it is already "${show(before.fulfillmentStatus)}" — nothing to reverse`);
  }
  if (before.trackingNumber) {
    refusals.push("it has a tracking number, so the parcel is already in the post");
  }
  if (before.labelUrl || before.labelClaimedAt) {
    refusals.push("a shipping label was bought for it");
  }
  if (before.shipmentNotifiedAt) {
    refusals.push("the customer has already been told it shipped");
  }
  if (refusals.length > 0) {
    console.error("REFUSED, and nothing was written:");
    for (const reason of refusals) console.error(`  · ${reason}`);
    process.exitCode = 1;
    return;
  }

  // ---- the write: two columns, conditional on the state just read ----
  //
  // storeId in the WHERE alongside the id, matching the rule every write in
  // this codebase follows; fulfillmentStatus too, so a concurrent change is
  // detected rather than overwritten.
  const changed = await prismaSystem.$executeRawUnsafe(
    `UPDATE "Order"
        SET "fulfillmentStatus" = $1, "fulfilledAt" = NULL
      WHERE "id" = $2 AND "storeId" = $3 AND "fulfillmentStatus" = $4`,
    REVERSIBLE_TO,
    orderId,
    before.storeId as string,
    REVERSIBLE_FROM,
  );
  if (changed !== 1) {
    console.error(`Wrote ${changed} rows — expected 1. The order changed while this was running.`);
    process.exitCode = 1;
    return;
  }

  // ---- and the proof that it was only those two ----------------------
  const after = await snapshot(orderId);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after ?? {})])].sort();
  const diffs = keys.filter((key) => show(before[key]) !== show(after?.[key]));

  console.log("Changed:");
  for (const key of diffs) {
    console.log(`  ${key.padEnd(22)} ${show(before[key])}  ->  ${show(after?.[key])}`);
  }

  const expected = ["fulfillmentStatus", "fulfilledAt"];
  const unexpected = diffs.filter((d) => !expected.includes(d));
  const missing = expected.filter((e) => !diffs.includes(e));

  console.log(`\n${keys.length} columns compared.`);
  if (unexpected.length === 0 && missing.length === 0) {
    console.log("Exactly the two columns changed. Nothing else moved.\n");
  } else {
    if (unexpected.length) console.error(`UNEXPECTED CHANGES: ${unexpected.join(", ")}`);
    if (missing.length) console.error(`EXPECTED BUT UNCHANGED: ${missing.join(", ")}`);
    process.exitCode = 1;
  }

  await prismaSystem.$disconnect();
}

void main();
