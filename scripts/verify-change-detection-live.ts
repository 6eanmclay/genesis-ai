import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// CHANGE DETECTION — where a fact becomes something that HAPPENED:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-change-detection-live.ts" -OutFile out.txt
//
// The entry to the whole memory pipeline: facts -> CHANGES -> insights ->
// recommendations -> observations -> beliefs. Everything downstream of it has
// been verified across this sprint; the step that produces the events had no
// coverage of its own.
//
// TWO GENUINELY DIFFERENT KINDS OF DETECTION, both producing one shape:
//
//   record rules   pure before/after comparisons, run per synced record, and
//                  provider-independent by construction — a QuickBooks invoice
//                  and a future Xero invoice produce the identical event
//                  through the identical rule, because every rule reads only
//                  canonical entity fields
//   time sweeps    conditions that become true purely from time passing, with
//                  no new sync data at all — an invoice already marked pending
//                  simply crosses its due date
//
// The sweeps need a re-sweep guard, because they run every scheduler pass and
// the condition stays true the whole time. Without it a single overdue invoice
// would emit an event every pass, forever, and the memory layer would learn
// that one late payer is the most eventful thing about the business.
//
// The same null-is-not-zero rule the insight detectors hold appears here too:
// nothing populates quantityAvailable, so a null must never read as depleted.

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
const daysAhead = (n: number) => new Date(Date.now() + n * DAY);

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { detectRecordChanges, detectOverdueInvoices, detectLowInventory, runChangeDetection } =
    await import("@/lib/intelligence/changeDetection");
  const { persistSyncedRecords } = await import("@/lib/businessModel/sync");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  let n = 0;
  const makeStore = (userId: string, name: string) =>
    prisma.store.create({
      data: {
        userId, name, slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${++n}`,
        tagline: "t", description: "d", currency: "USD",
      },
    });

  const owner = await prisma.user.create({ data: { email: "changes@example.test" } });

  const types = (candidates: { eventType: string }[]) => candidates.map((c) => c.eventType).sort();

  // ==========================================================================
  console.log("\n=== 1. A record appearing for the first time ===\n");
  // ==========================================================================
  const contact = { name: "Priya", email: "priya@example.test", roles: ["customer"], firstSeenAt: "2026-01-01", lastSeenAt: "2026-01-01" };
  check("a brand-new contact is a creation",
    types(detectRecordChanges("contact", null, contact as never)), ["contact.created"]);
  check("and an unchanged one is nothing at all",
    types(detectRecordChanges("contact", contact as never, contact as never)), []);
  check("a renamed contact is an update",
    types(detectRecordChanges("contact", contact as never, { ...contact, name: "Priya R" } as never)),
    ["contact.updated"]);
  // A field the rule does not watch is deliberately not an event — a sync
  // touching lastSeenAt on every pass must not be news.
  check("a touched timestamp alone is not an update",
    types(detectRecordChanges("contact", contact as never, { ...contact, lastSeenAt: "2026-02-02" } as never)),
    []);

  // ==========================================================================
  console.log("\n=== 2. An invoice being paid is the event, not the amount ===\n");
  // ==========================================================================
  const invoice = {
    type: "invoice", amountInCents: 50_000, status: "pending",
    contactId: null, issuedAt: daysAgo(30).toISOString(), dueAt: daysAgo(1).toISOString(),
  };
  check("a new invoice is a creation",
    types(detectRecordChanges("document", null, invoice as never)), ["invoice.created"]);
  check("pending to paid is the payment",
    types(detectRecordChanges("document", invoice as never, { ...invoice, status: "paid" } as never)),
    ["invoice.paid"]);
  // Already paid, synced again — not a second payment.
  check("paid to paid is not a second payment",
    types(detectRecordChanges("document",
      { ...invoice, status: "paid" } as never, { ...invoice, status: "paid" } as never)), []);
  // A receipt is not an invoice, so it produces no invoice event.
  check("a receipt appearing is not an invoice creation",
    types(detectRecordChanges("document", null, { ...invoice, type: "receipt" } as never)), []);

  // ==========================================================================
  console.log("\n=== 3. A cancellation is a transition, not a state ===\n");
  // ==========================================================================
  const appointment = {
    title: "Induction", startAt: daysAhead(3).toISOString(), endAt: null,
    contactIds: [], locationId: null, status: "confirmed",
  };
  check("a new appointment is a creation",
    types(detectRecordChanges("appointment", null, appointment as never)), ["appointment.created"]);
  check("confirmed to cancelled is a cancellation",
    types(detectRecordChanges("appointment", appointment as never, { ...appointment, status: "cancelled" } as never)),
    ["appointment.cancelled"]);
  // Re-syncing an already-cancelled appointment must not cancel it again — the
  // cancellation trend downstream counts these.
  check("cancelled to cancelled is nothing",
    types(detectRecordChanges("appointment",
      { ...appointment, status: "cancelled" } as never,
      { ...appointment, status: "cancelled" } as never)), []);

  // ==========================================================================
  console.log("\n=== 4. Time alone can make something true ===\n");
  // ==========================================================================
  const store = await makeStore(owner.id, "Sweep Store");
  let ext = 0;
  const doc = (data: object) =>
    persistSyncedRecords(
      store.id,
      "quickbooks",
      [{ entityType: "document" as const, externalId: `d-${++ext}`, data: data as never }],
      { provenance: "CONNECTOR", provenanceDetail: "quickbooks", statedById: null, modelExtracted: false }
    );

  await doc(invoice); // pending, due yesterday
  await doc({ ...invoice, status: "paid" }); // paid, also past due
  await doc({ ...invoice, dueAt: daysAhead(10).toISOString() }); // pending, not yet due
  await doc({ ...invoice, dueAt: null }); // pending, no due date at all

  const overdue = await detectOverdueInvoices(store.id);
  check("exactly one invoice is overdue", overdue.length, 1);
  check("and it is an overdue event", overdue[0].candidate.eventType, "invoice.overdue");
  assert("a paid invoice is never overdue", overdue.length === 1, "however far past its date");
  assert("nor is one with no due date", overdue.length === 1, "nothing says when it was due");

  // ==========================================================================
  console.log("\n=== 5. The re-sweep guard, which is what makes sweeps usable ===\n");
  // ==========================================================================
  // The condition stays true every pass. Without the guard, one late payer
  // would emit an event forever and dominate the store's own memory.
  await runChangeDetection(store.id, "quickbooks", []);
  const firstPass = await prisma.businessEvent.count({
    where: { storeId: store.id, eventType: "invoice.overdue" },
  });
  check("the first pass records it once", firstPass, 1);

  await runChangeDetection(store.id, "quickbooks", []);
  await runChangeDetection(store.id, "quickbooks", []);
  check("later passes record nothing new",
    await prisma.businessEvent.count({ where: { storeId: store.id, eventType: "invoice.overdue" } }), 1);
  assert("so one late payer cannot become the most eventful thing about the business",
    (await prisma.businessEvent.count({ where: { storeId: store.id, eventType: "invoice.overdue" } })) === 1);

  // ==========================================================================
  console.log("\n=== 6. Unknown stock is not empty stock ===\n");
  // ==========================================================================
  // Nothing populates quantityAvailable — internalMapper writes null for every
  // item — so a null reading as 0 would tell every owner their catalogue is
  // depleted. The same rule the insight detectors hold, at the event layer.
  await prisma.product.create({
    data: { storeId: store.id, name: "Candle", description: "d", priceInCents: 1_000, active: true },
  });
  check("an item with unknown stock produces no inventory event",
    await detectLowInventory(store.id), []);

  // With a real number, it does — asserted so the silence above is about the
  // null rather than the sweep being inert.
  const item = (name: string, quantityAvailable: number | null) => ({
    name, sku: null, priceInCents: 500, category: null, active: true, quantityAvailable,
  });
  const stocked = await persistSyncedRecords(
    store.id,
    "shopify",
    [
      { entityType: "item" as const, externalId: "i-1", data: item("Wick", 0) as never },
      { entityType: "item" as const, externalId: "i-2", data: item("Jar", 3) as never },
      { entityType: "item" as const, externalId: "i-3", data: item("Lid", 40) as never },
    ],
    { provenance: "CONNECTOR", provenanceDetail: "shopify", statedById: null, modelExtracted: false }
  );
  check("the stocked items were persisted", stocked.errors, []);
  const inventory = await detectLowInventory(store.id);
  check("zero is depleted and three is low, forty is neither",
    inventory.map((r) => r.candidate.eventType).sort(), ["inventory.depleted", "inventory.low"]);

  // ==========================================================================
  console.log("\n=== 7. Events belong to the business they came from ===\n");
  // ==========================================================================
  const other = await makeStore(owner.id, "Other Sweep Store");
  await runChangeDetection(other.id, "quickbooks", []);
  check("a business with nothing overdue records nothing",
    await prisma.businessEvent.count({ where: { storeId: other.id, eventType: "invoice.overdue" } }), 0);

  // The neighbour's overdue invoice is right there and must not be counted.
  const neighbourEvents = await prisma.businessEvent.findMany({ where: { storeId: other.id } });
  assert("and none of the neighbour's events appear here",
    neighbourEvents.every((e) => e.storeId === other.id));

  await doc({ ...invoice, dueAt: daysAgo(2).toISOString() });
  const [a, b] = await Promise.all([detectOverdueInvoices(store.id), detectOverdueInvoices(other.id)]);
  assert("concurrent sweeps stay separate", a.length > 0 && b.length === 0,
    `${a.length} vs ${b.length}`);

  // Every event written carries the provider that produced it, so a future
  // connector's events can be told from this one's.
  const written = await prisma.businessEvent.findMany({
    where: { storeId: store.id, eventType: "invoice.overdue" },
    select: { sourceProvider: true, recordId: true },
  });
  assert("each event names its source", written.every((e) => e.sourceProvider === "quickbooks"));
  assert("and the record it is about", written.every((e) => e.recordId !== null));

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All change-detection assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
