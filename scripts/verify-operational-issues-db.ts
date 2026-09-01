import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { getOperationalIssues } from "@/lib/dashboard/operationalIssues";
import { getAttentionItems } from "@/lib/dashboard/needsAttention";
import { buildAttentionCards } from "@/lib/dashboard/attentionCards";
import { platformHealth, needsAttention, STALL_MS } from "@/lib/admin/platformHealth";
import { readFileSync } from "node:fs";

// WHEN THE MACHINERY FAILS, THE OWNER IS THE ONE IT HAPPENED TO:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts operational-issues-db
//
// ============ THE CONDITION THIS EXISTS FOR (2026-08-31) ===============
//
// A customer's order confirmation fails five times and gives up. Today the
// platform notices: the job is dead-lettered, platformHealth counts it,
// ops.alerts reports "1 job(s) gave up entirely" to Sentry, and an operator
// could read it on /admin/operations.
//
// The merchant whose customer never heard from them sees nothing.
//
// Every one of those rows carries a storeId. The count was computed
// platform-wide and never attributed, and there was a mature attention system
// on the owner's dashboard with nothing feeding it. This proves the join, in
// both directions: the owner now learns, and the operator still does.
//
// ============ AND WHAT AN OWNER IS NOT SHOWN ==========================
//
// A stopped scheduler, a critical security signal, and any row belonging to no
// business. Asserted as deliberate absences rather than left untested, because
// a merchant told "the scheduler is overdue" has been alarmed about something
// they cannot act on.

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

let seq = 0;
async function makeStore(stamp: number) {
  const n = ++seq;
  const user = await prisma.user.create({ data: { email: `oi-${stamp}-${n}@example.test` } });
  return prisma.store.create({
    data: { userId: user.id, name: "Cubit", slug: `oi-${stamp}-${n}`, tagline: "t", description: "d" },
  });
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  console.log("\n--- a dead-lettered order email reaches the owner it happened to ---\n");
  const store = await makeStore(stamp);
  {
    await prismaSystem.job.create({
      data: {
        kind: "notification.order", storeId: store.id, status: "dead",
        idempotencyKey: `oi-dead-${stamp}`, attempts: 5, maxAttempts: 5,
        lastError: "Resend returned 401",
      },
    });

    const items = await getOperationalIssues(store.id);
    eq("the owner is told exactly once", items.length, 1);
    eq("and it is a failure, not a warning", items[0].severity, "FAILED");
    assert("it says what could not be done, in their language",
      /order email/i.test(items[0].message), items[0].message);
    assert("it says what they can do about it",
      /contact the customer/i.test(items[0].message), items[0].message);
    assert("and it says where to go", items[0].actionHref === "/dashboard/orders", items[0].actionHref);
    assert("the internal job kind is never printed at them",
      !items[0].message.includes("notification.order"), items[0].message);
    assert("nor the provider's error text",
      !items[0].message.includes("401"), items[0].message);
  }

  console.log("\n--- and the operator still sees it too ---\n");
  {
    // ============ THE JOIN ADDS A READER, IT DOES NOT MOVE ONE =====
    //
    // The owner-facing path must not have quietly taken this away from the
    // operator surface that has always had it.
    const health = await platformHealth();
    assert("platformHealth still counts the dead letter",
      health.queue.deadLetters.some((d) => d.storeId === store.id));
    assert("and needsAttention still says a person is required",
      needsAttention(health).some((r) => /gave up entirely/.test(r)));
  }

  console.log("\n--- another business's failure is not shown to this one ---\n");
  {
    const other = await makeStore(stamp);
    await prismaSystem.job.create({
      data: {
        kind: "notification.order", storeId: other.id, status: "dead",
        idempotencyKey: `oi-dead-other-${stamp}`, attempts: 5, maxAttempts: 5,
      },
    });
    eq("this owner still sees only their own", (await getOperationalIssues(store.id)).length, 1);
    eq("and the other sees only theirs", (await getOperationalIssues(other.id)).length, 1);
  }

  console.log("\n--- platform maintenance belongs to nobody, and is shown to nobody ---\n");
  {
    // A prune job that gave up is a real operator problem and not a fact about
    // any business. It has a null storeId, so no owner query can reach it —
    // asserted, because "no store" and "every store" are one typo apart.
    await prismaSystem.job.create({
      data: {
        kind: "retention.sweep", storeId: null, status: "dead",
        idempotencyKey: `oi-sys-${stamp}`, attempts: 5, maxAttempts: 5,
      },
    });
    eq("the owner's list is unchanged", (await getOperationalIssues(store.id)).length, 1);

    const health = await platformHealth();
    assert("but the operator is told",
      health.queue.deadLetters.some((d) => d.kind === "retention.sweep" && d.storeId === null));
  }

  console.log("\n--- an unknown outcome is a warning, and says not to just try again ---\n");
  {
    const s = await makeStore(stamp);
    await prismaSystem.outboundOperation.create({
      data: {
        storeId: s.id, operation: "email.confirmationSentAt", status: "indeterminate",
        idempotencyKey: `oi-ind-${stamp}`, attempts: 1,
      },
    });
    const items = await getOperationalIssues(s.id);
    eq("one item", items.length, 1);
    eq("a warning — it may well have arrived", items[0].severity, "WARNING");
    assert("it is honest that we do not know",
      /do not know whether it arrived/i.test(items[0].message), items[0].message);
    assert("and it says to check before sending again",
      /check with the customer before sending it again/i.test(items[0].message), items[0].message);
  }

  console.log("\n--- a delivery we could not process says an order may be missing ---\n");
  {
    const s = await makeStore(stamp);
    await prismaSystem.webhookDelivery.create({
      data: {
        provider: "STRIPE", storeId: s.id, status: "failed", signatureValid: true,
        externalEventId: `evt-oi-${stamp}`, payload: "{}",
      },
    });
    const items = await getOperationalIssues(s.id);
    eq("one item", items.length, 1);
    assert("it names the provider", /STRIPE/.test(items[0].message), items[0].message);
    assert("it says an order may be missing",
      /order may be missing/i.test(items[0].message), items[0].message);
    assert("and it does NOT offer the owner a replay button",
      !/replay/i.test(items[0].message), items[0].message);
  }

  console.log("\n--- an unsigned delivery is a security matter, not a merchant's problem ---\n");
  {
    const s = await makeStore(stamp);
    await prismaSystem.webhookDelivery.create({
      data: {
        provider: "STRIPE", storeId: s.id, status: "failed", signatureValid: false,
        externalEventId: `evt-oi-bad-${stamp}`, payload: "{}",
      },
    });
    eq("somebody knocking is not shown to the shopkeeper",
      (await getOperationalIssues(s.id)).length, 0);
  }

  console.log("\n--- a stalled job is a warning that says it will be retried ---\n");
  {
    const s = await makeStore(stamp);
    await prismaSystem.job.create({
      data: {
        kind: "notification.order", storeId: s.id, status: "running",
        idempotencyKey: `oi-stall-${stamp}`, attempts: 1,
        lockedAt: new Date(Date.now() - STALL_MS - 60_000), lockedBy: "worker-1",
      },
    });
    const items = await getOperationalIssues(s.id);
    eq("one item", items.length, 1);
    eq("a warning, because it may still finish", items[0].severity, "WARNING");
    assert("and it says so", /will be retried/i.test(items[0].message), items[0].message);

    // A job locked a moment ago is simply running.
    const fresh = await makeStore(stamp);
    await prismaSystem.job.create({
      data: {
        kind: "notification.order", storeId: fresh.id, status: "running",
        idempotencyKey: `oi-fresh-${stamp}`, attempts: 1,
        lockedAt: new Date(), lockedBy: "worker-1",
      },
    });
    eq("work in progress is not an alarm", (await getOperationalIssues(fresh.id)).length, 0);
  }

  console.log("\n--- the same failure three times is one card, not three ---\n");
  {
    const s = await makeStore(stamp);
    for (let i = 0; i < 3; i++) {
      await prismaSystem.job.create({
        data: {
          kind: "notification.order", storeId: s.id, status: "dead",
          idempotencyKey: `oi-dup-${stamp}-${i}`, attempts: 5, maxAttempts: 5,
        },
      });
    }
    eq("three real rows", (await getOperationalIssues(s.id)).length, 3);

    // Through the reader the dashboard actually calls, the existing dedupe
    // collapses them — which is why the messages carry no row ids.
    const { recentOutcomes } = await getAttentionItems(s.id, {
      store: { published: true }, products: [{ active: true }],
      stripeIntegration: { status: "CONNECTED" }, paypalIntegration: null,
    });
    const operational = recentOutcomes.filter((i) => i.kind === "operational-failure");
    eq("one card for the owner", operational.length, 1);
    eq("carrying all three occurrences", operational[0].count, 3);
  }

  console.log("\n--- the card an owner actually sees carries the destination ---\n");
  {
    const s = await makeStore(stamp);
    await prismaSystem.job.create({
      data: {
        kind: "notification.order", storeId: s.id, status: "dead",
        idempotencyKey: `oi-card-${stamp}`, attempts: 5, maxAttempts: 5,
      },
    });
    const { recentOutcomes } = await getAttentionItems(s.id, {
      store: { published: true }, products: [{ active: true }],
      stripeIntegration: { status: "CONNECTED" }, paypalIntegration: null,
    });
    const { cards } = buildAttentionCards({
      basePath: "/dashboard", issues: recentOutcomes, pendingApprovals: [],
      nextRecommendation: null, discoveryItems: [], tasks: [],
    });
    const card = cards.find((c) => c.kind === "issue");
    assert("there is a card", !!card);
    assert("and it carries the link, which no card ever did before",
      card?.kind === "issue" && card.actionHref === "/dashboard/orders",
      card?.kind === "issue" ? String(card.actionHref) : "not an issue card");
  }

  console.log("\n--- a broken connection now says where to reconnect it ---\n");
  {
    // The pre-existing five actionHref call sites, proven end to end for the
    // first time: this is the defect the sweep found rather than introduced.
    const s = await makeStore(stamp);
    await prismaSystem.storeIntegration.create({
      data: { storeId: s.id, provider: "STRIPE", status: "NEEDS_ATTENTION", lastError: "revoked" },
    });
    const { recentOutcomes } = await getAttentionItems(s.id, {
      store: { published: true }, products: [{ active: true }],
      stripeIntegration: { status: "NEEDS_ATTENTION" }, paypalIntegration: null,
    });
    const { cards } = buildAttentionCards({
      basePath: "/dashboard", issues: recentOutcomes, pendingApprovals: [],
      nextRecommendation: null, discoveryItems: [], tasks: [],
    });
    const withHref = cards.filter((c) => c.kind === "issue" && c.actionHref === "/dashboard/payments");
    assert("the payments screen is reachable from the card", withHref.length > 0,
      JSON.stringify(cards.map((c) => (c.kind === "issue" ? c.actionHref : c.kind))));
  }

  console.log("\n--- the operator's conditions stay the operator's ---\n");
  {
    // Source-asserted deliberately, and kept apart from the execution evidence
    // above: this is a statement about what the owner-facing reader must never
    // grow, which no fixture can demonstrate.
    const source = readFileSync("lib/dashboard/operationalIssues.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    assert("it never reads scheduler health", !/schedulerHealth|scheduledTaskRun/.test(source));
    assert("it never reads the security stream", !/securitySignal/.test(source));
    assert("every query it makes is scoped to one business",
      (source.match(/where: \{ storeId/g) ?? []).length >= 4, source.slice(0, 100));
    assert("and it goes through the tenant-guarded client, not prismaSystem",
      !/prismaSystem/.test(source));
  }

  // ============ THE ROWS THIS SUITE PLANTED, CLEARED AGAIN =========
  //
  // Job, OutboundOperation and WebhookDelivery are all counted by PLATFORM-WIDE
  // readers — the telemetry footprint and platformHealth. Rows left behind here
  // are rows another suite counts, and the lane shares one database: this suite
  // passed alone and turned verify-telemetry-db red in the full run until this
  // existed. The same lesson the storage rows taught two commits ago.
  // Deliveries first: WebhookDelivery.storeId is onDelete SetNull, so deleting
  // the business would leave the row behind unowned rather than removing it.
  await prismaSystem.webhookDelivery.deleteMany({ where: { externalEventId: { startsWith: "evt-oi-" } } });
  await prismaSystem.job.deleteMany({ where: { idempotencyKey: { startsWith: "oi-" } } });
  await prismaSystem.outboundOperation.deleteMany({ where: { idempotencyKey: { startsWith: "oi-" } } });
  // And the fixtures themselves. Deleting the rows this suite planted was not
  // enough — the full lane still turned verify-telemetry-db red, and only
  // removing the businesses and accounts too brought it back to green. A suite
  // that leaves fixtures behind in a shared database is a suite that changes
  // what every later suite counts.
  await prismaSystem.user.deleteMany({ where: { email: { startsWith: "oi-" } } });

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
