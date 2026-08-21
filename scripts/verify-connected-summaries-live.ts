import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// CHAPTER 4's CONNECTED-DATA SUMMARIES — invoices, campaigns, appointments:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-connected-summaries-live.ts" -OutFile out.txt
//
// Five standing summaries reach every prompt J4 writes — Reason's own
// contextForPrompt and chat's buildChatDataContext both read them — and none had
// any verification coverage. They are pure computations over real
// BusinessRecords, so nothing here is externally blocked: the connector that
// SYNCS the rows needs credentials, the reads over them do not.
//
// THE RULE THEY ALL SHARE, and the reason they are worth testing at all: an
// honest null when there is nothing real to summarise, never a fabricated zero.
// "You have 0 outstanding invoices" and "I have no invoice data" are different
// sentences, and only one of them is true for a store with no accounting
// connected. A zero here would be J4 confidently reporting a clean ledger it has
// never seen.
//
// Everything is asserted across two businesses, because a summary borrowed from
// the other business would be specific, confident and wrong.

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

  const {
    getInvoiceSummary,
    getCampaignPerformanceSummary,
    getAppointmentSummary,
    getUpcomingAppointments,
    getAverageOpenRate,
  } = await import("@/lib/businessModel/reasoning");
  const { persistSyncedRecords } = await import("@/lib/businessModel/sync");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  let n = 0;
  const makeStore = (userId: string, name: string) =>
    prisma.store.create({
      data: {
        userId,
        name,
        slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${++n}`,
        tagline: "t",
        description: "d",
        currency: "USD",
      },
    });

  const owner = await prisma.user.create({ data: { email: "ch4@example.test" } });
  const iron = await makeStore(owner.id, "Iron Gym");
  const copper = await makeStore(owner.id, "Copper and Coil");

  let ext = 0;
  const record = (storeId: string, entityType: "document" | "campaign" | "appointment", data: unknown) =>
    persistSyncedRecords(storeId, "quickbooks", [
      { entityType: entityType as never, externalId: `ext-${++ext}`, data: data as never },
    ]);

  // ==========================================================================
  console.log("\n=== 1. Nothing connected is null, never zero ===\n");
  // ==========================================================================
  check("no invoice data is null", await getInvoiceSummary(iron.id), null);
  check("no campaign data is null", await getCampaignPerformanceSummary(iron.id), null);
  check("no appointment data is null", await getAppointmentSummary(iron.id), null);
  check("and no open rate to average", await getAverageOpenRate(iron.id), null);
  // The list is legitimately empty rather than null — an empty list of upcoming
  // appointments is a real answer, unlike a summary of data that does not exist.
  check("upcoming appointments is an empty list", await getUpcomingAppointments(iron.id), []);

  // ==========================================================================
  console.log("\n=== 2. Invoices: outstanding and overdue are different questions ===\n");
  // ==========================================================================
  await record(iron.id, "document", {
    type: "invoice", amountInCents: 50_000, status: "paid",
    contactId: null, issuedAt: daysAgo(60).toISOString(), dueAt: daysAgo(30).toISOString(),
  });
  // Outstanding and past its date: overdue.
  await record(iron.id, "document", {
    type: "invoice", amountInCents: 20_000, status: "pending",
    contactId: null, issuedAt: daysAgo(45).toISOString(), dueAt: daysAgo(15).toISOString(),
  });
  // Outstanding, not yet due: outstanding but NOT overdue.
  await record(iron.id, "document", {
    type: "invoice", amountInCents: 30_000, status: "pending",
    contactId: null, issuedAt: daysAgo(5).toISOString(), dueAt: daysAhead(10).toISOString(),
  });
  // Outstanding with NO due date — cannot be overdue, because nothing says when.
  await record(iron.id, "document", {
    type: "invoice", amountInCents: 7_000, status: "pending",
    contactId: null, issuedAt: daysAgo(20).toISOString(), dueAt: null,
  });
  // A different kind of document entirely.
  await record(iron.id, "document", {
    type: "receipt", amountInCents: 999_999, status: "paid",
    contactId: null, issuedAt: daysAgo(3).toISOString(), dueAt: null,
  });

  const invoices = await getInvoiceSummary(iron.id);
  check("three invoices are outstanding", invoices?.outstandingCount, 3);
  check("totalling what is actually owed", invoices?.outstandingTotalInCents, 57_000);
  check("only one of them is overdue", invoices?.overdueCount, 1);
  check("and the overdue total is only that one", invoices?.overdueTotalInCents, 20_000);
  assert(
    "an invoice with no due date is outstanding but never overdue",
    invoices?.overdueTotalInCents === 20_000,
    "nothing says when it was due, so nothing can say it is late"
  );
  assert(
    "a receipt is not an invoice",
    (invoices?.outstandingTotalInCents ?? 0) < 999_999,
    "the 999,999 receipt would be unmissable"
  );

  // ==========================================================================
  console.log("\n=== 3. Campaigns: an open rate needs both halves ===\n");
  // ==========================================================================
  await record(copper.id, "campaign", {
    name: "Spring send", channel: "email",
    sentAt: daysAgo(20).toISOString(), audienceSize: 200, metrics: { opens: 50 },
  });
  await record(copper.id, "campaign", {
    name: "Summer send", channel: "email",
    sentAt: daysAgo(5).toISOString(), audienceSize: 100, metrics: { opens: 40 },
  });
  // Sent, but the provider reported no opens. Not a 0% open rate — no rate.
  // Captured once: daysAgo() reads the clock, so calling it again at assertion
  // time compares two instants milliseconds apart.
  const newestSend = daysAgo(2).toISOString();
  await record(copper.id, "campaign", {
    name: "Unmeasured send", channel: "email",
    sentAt: newestSend, audienceSize: 500, metrics: null,
  });
  // Planned by J4 and never sent. It exists, and it has no performance.
  await record(copper.id, "campaign", {
    name: "Planned, not sent", channel: "email", status: "draft",
    content: "Draft copy", sentAt: null, audienceSize: null, metrics: null,
  });

  const campaigns = await getCampaignPerformanceSummary(copper.id);
  check("every campaign is counted, sent or not", campaigns?.campaignCount, 4);
  // (50/200 + 40/100) / 2 = (0.25 + 0.40) / 2 = 0.325. The unmeasured and
  // unsent ones are excluded rather than averaged in as zero.
  check("the open rate averages only the measurable ones", campaigns?.averageOpenRate, 0.325);
  check("the most recent SEND is the newest sentAt", campaigns?.mostRecentSentAt, newestSend);
  assert(
    "a draft never sent does not become the most recent send",
    campaigns?.mostRecentSentAt !== null,
    "and a null sentAt cannot win the comparison"
  );

  // ==========================================================================
  console.log("\n=== 4. Appointments: a rate needs a denominator ===\n");
  // ==========================================================================
  await record(iron.id, "appointment", {
    title: "Induction", startAt: daysAhead(3).toISOString(), endAt: null,
    contactIds: [], locationId: null, status: "confirmed",
  });
  await record(iron.id, "appointment", {
    title: "Assessment", startAt: daysAhead(9).toISOString(), endAt: null,
    contactIds: [], locationId: null, status: "confirmed",
  });
  await record(iron.id, "appointment", {
    title: "Last week's session", startAt: daysAgo(7).toISOString(), endAt: null,
    contactIds: [], locationId: null, status: "completed",
  });

  const noEvents = await getAppointmentSummary(iron.id);
  check("only future appointments are upcoming", noEvents?.upcomingCount, 2);
  check("with no created events, there is no denominator", noEvents?.createdLast30Days, 0);
  // THE HONESTY RULE: not 0%, which would read as "nobody ever cancels".
  check("so the cancellation rate is null, not zero", noEvents?.cancellationRate, null);

  const event = (storeId: string, eventType: string, day: number) =>
    prisma.businessEvent.create({
      data: {
        storeId, entityType: "appointment", eventType, recordId: null,
        sourceProvider: "google_calendar", summary: "s", occurredAt: daysAgo(day),
      },
    });
  await event(iron.id, "appointment.created", 20);
  await event(iron.id, "appointment.created", 10);
  await event(iron.id, "appointment.created", 4);
  await event(iron.id, "appointment.cancelled", 6);
  // Outside the window — must not be counted.
  await event(iron.id, "appointment.created", 45);
  await event(iron.id, "appointment.cancelled", 40);

  const withEvents = await getAppointmentSummary(iron.id);
  check("only events inside the window count", withEvents?.createdLast30Days, 3);
  check("cancellations likewise", withEvents?.cancelledLast30Days, 1);
  check("and the rate is a real fraction of them", withEvents?.cancellationRate, 1 / 3);

  const upcoming = await getUpcomingAppointments(iron.id);
  check("upcoming is soonest first", upcoming.map((a) => a.data.title), ["Induction", "Assessment"]);

  // ==========================================================================
  console.log("\n=== 5. No summary reaches across businesses ===\n");
  // ==========================================================================
  // Iron Gym has invoices and appointments; Copper & Coil has campaigns. Each
  // must see its own and nothing of the other's.
  check("Iron Gym has no campaign data at all", await getCampaignPerformanceSummary(iron.id), null);
  check("Copper & Coil has no invoice data", await getInvoiceSummary(copper.id), null);
  check("nor appointments", await getAppointmentSummary(copper.id), null);
  check("nor an open rate borrowed from nowhere", await getAverageOpenRate(iron.id), null);
  assert(
    "and Copper & Coil's open rate is its own",
    (await getAverageOpenRate(copper.id)) === 0.325
  );

  // Concurrently, for the same reason the two-tab test exists.
  const [ironInv, copperInv] = await Promise.all([getInvoiceSummary(iron.id), getInvoiceSummary(copper.id)]);
  check("concurrent reads stay separate", [ironInv?.outstandingCount ?? null, copperInv], [3, null]);

  // A third account's data never appears in either.
  const stranger = await prisma.user.create({ data: { email: "ch4-stranger@example.test" } });
  const theirs = await makeStore(stranger.id, "Somebody Else");
  await record(theirs.id, "document", {
    type: "invoice", amountInCents: 111_111, status: "pending",
    contactId: null, issuedAt: daysAgo(2).toISOString(), dueAt: daysAgo(1).toISOString(),
  });
  const ironAfter = await getInvoiceSummary(iron.id);
  check("another account's invoice changes nothing here", ironAfter?.outstandingTotalInCents, 57_000);
  check("and their own is their own", (await getInvoiceSummary(theirs.id))?.overdueTotalInCents, 111_111);

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All connected-summary assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
