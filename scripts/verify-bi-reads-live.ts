import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import { execFile } from "child_process";

// THE THREE BI READS NOBODY HAD EVER EXECUTED, AGAINST A REAL DATABASE:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-bi-reads-live.ts" -OutFile out.txt
//
// BI_ENGINE.md's consolidated list named six things unproved against a
// database. Increment 3 closed three of them. These are the three that were
// left, and they have one shape in common: the ARITHMETIC is pure and already
// proved by the M2, M5 and M6 suites, while the READ that feeds it — the actual
// Prisma query, against actual rows, with actual status values — had never run.
//
// So nothing here re-tests arithmetic. Every assertion is about something only
// a database can answer:
//
//   1. backfill-topic-keys.ts   does the SCRIPT do what its plan says, in both
//                               modes, without touching a row it was not
//                               allowed to touch
//   2. getProfitability         does a REFUNDED order really contribute zero
//                               revenue while keeping its costs, and is an
//                               UNKNOWN cost really an exclusion rather than a
//                               zero, when both come out of Postgres
//   3. getObligations           do real status/fulfillmentStatus values bucket
//                               correctly, and does the address that IS in the
//                               row stay out of the answer
//
// THE FIXTURES ARE THE TEST. Each one is built so that the failure it guards
// against would produce a DIFFERENT NUMBER, not a missing one — a refund
// counted as revenue, or an unknown cost read as zero, both change the total in
// a way the expected value below would catch.

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

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { getProfitability } = await import("@/lib/businessModel/profitability");
  const { getObligations } = await import("@/lib/businessModel/obligations");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  /** Run the backfill script exactly as an operator would, against this database. */
  function runBackfill(args: string): Promise<string> {
    return new Promise((resolve) => {
      execFile(
        `npx tsx scripts/backfill-topic-keys.ts ${args}`,
        { env: { ...process.env, DATABASE_URL: db.url }, shell: true, maxBuffer: 20 * 1024 * 1024 },
        (_error, stdout, stderr) => resolve(`${stdout}${stderr}`)
      );
    });
  }

  async function reset() {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
        AND tablename <> '_genesis_test_database'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
  }

  let n = 0;
  async function business(slug: string) {
    const user = await prisma.user.create({ data: { email: `${slug}-${++n}@example.test` } });
    return prisma.store.create({
      data: { userId: user.id, name: slug, slug, tagline: "t", description: "d", currency: "USD" },
    });
  }

  // ==========================================================================
  console.log("\n=== 1. backfill-topic-keys.ts, both modes, against real rows ===\n");
  // ==========================================================================
  await reset();
  const s1 = await business("backfill-store");

  // Six rows covering every branch the plan can take, including the ones that
  // must produce NO write. A backfill is judged by what it leaves alone.
  const rows: Record<string, { actionType: string; input: object; topicKey: string | null }> = {
    hero: { actionType: "update_hero", input: { headline: "New" }, topicKey: null },
    rename: { actionType: "update_product", input: { productId: "p1", name: "Nicer name" }, topicKey: null },
    // Bookkeeping — deliberately unnamed, so no belief is ever counted about it.
    goal: { actionType: "update_goal_status", input: { goalId: "g1" }, topicKey: null },
    // An action type nobody has mapped. The ambiguous case, by definition.
    unmapped: { actionType: "some_future_action", input: { x: 1 }, topicKey: null },
    // update_product carrying only a productId: nothing was actually proposed.
    empty: { actionType: "update_product", input: { productId: "p1" }, topicKey: null },
    // ALREADY KEYED, to something the derivation would never produce, so an
    // overwrite would be unmistakable rather than invisible.
    keyed: { actionType: "update_seo", input: { title: "T" }, topicKey: "hand_authored_key" },
  };
  const ids: Record<string, string> = {};
  for (const [name, row] of Object.entries(rows)) {
    const created = await prisma.approvalRequest.create({
      data: {
        storeId: s1.id,
        actionType: row.actionType,
        input: row.input,
        previousValues: {},
        summary: `summary for ${name}`,
        status: "PENDING_APPROVAL",
        topicKey: row.topicKey,
      },
    });
    ids[name] = created.id;
  }

  const snapshot = () =>
    prisma.approvalRequest.findMany({
      where: { storeId: s1.id },
      select: {
        id: true,
        topicKey: true,
        summary: true,
        status: true,
        input: true,
        actionType: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

  const before = await snapshot();

  const dryOutput = await runBackfill("");
  // THE WHOLE ROW, not just topicKey: a dry run that wrote anything at all is a
  // dry run that lied, and which field it touched is not knowable in advance.
  check("dry run changes NOTHING — every field of every row identical", await snapshot(), before);
  assert("dry run says so out loud", dryOutput.includes("Dry run. Nothing was written."));
  assert(
    "dry run reads only the 5 rows with no key",
    dryOutput.includes("Decisions with no topicKey: 5"),
    "the already-keyed row is never even selected"
  );
  assert("dry run reports 2 derivable", /Derivable: 2/.test(dryOutput));
  assert("dry run reports 3 ambiguous", /Ambiguous — left null: 3/.test(dryOutput));

  const applyOutput = await runBackfill("--apply");
  assert("--apply reports 2 written", applyOutput.includes("Wrote 2 topic keys."));

  const afterApply = new Map(
    (
      await prisma.approvalRequest.findMany({
        where: { storeId: s1.id },
        select: { id: true, topicKey: true },
      })
    ).map((r) => [r.id, r.topicKey])
  );
  check("derivable: update_hero -> storefront_hero", afterApply.get(ids.hero), "storefront_hero");
  check("derivable: update_product{name} -> product_name_change", afterApply.get(ids.rename), "product_name_change");
  check("bookkeeping action stays null", afterApply.get(ids.goal), null);
  check("unmapped action stays null", afterApply.get(ids.unmapped), null);
  check("update_product proposing nothing stays null", afterApply.get(ids.empty), null);
  // The assertion the `where: { topicKey: null }` filter exists for.
  check("an EXISTING key is never overwritten", afterApply.get(ids.keyed), "hand_authored_key");

  // Nothing but topicKey moved — compared against the pre-run snapshot rather
  // than re-derived, so a change to summary, status or input would show.
  /** Everything except the one field the backfill is allowed to write. */
  const exceptTopicKey = (list: Awaited<ReturnType<typeof snapshot>>) =>
    list.map((row) => ({ ...row, topicKey: undefined }));
  check("--apply modified NO other field", exceptTopicKey(await snapshot()), exceptTopicKey(before));

  const secondApply = await runBackfill("--apply");
  assert(
    "re-running --apply finds only the honest nulls",
    secondApply.includes("Decisions with no topicKey: 3"),
    "the two derivable rows are done and stay done"
  );
  assert("second run writes nothing", secondApply.includes("Wrote 0 topic keys."));

  // ==========================================================================
  console.log("\n=== 2. getProfitability — the read, not the arithmetic ===\n");
  // ==========================================================================
  await reset();
  const s2 = await business("profit-store");
  const costed = await prisma.product.create({
    data: { storeId: s2.id, name: "Costed", description: "d", priceInCents: 5_000, costInCents: 2_000, active: true },
  });
  const uncosted = await prisma.product.create({
    // costInCents deliberately absent: Genesis does not know what this cost.
    data: { storeId: s2.id, name: "Uncosted", description: "d", priceInCents: 3_000, active: true },
  });

  let ext = 0;
  const order = (data: Record<string, unknown>) =>
    prisma.order.create({
      data: {
        storeId: s2.id,
        productName: "x",
        buyerEmail: "buyer@example.test",
        paymentProvider: "STRIPE",
        externalOrderId: `ext-${++ext}`,
        ...data,
      } as never,
    });

  await order({ productId: costed.id, amountInCents: 5_000, status: "paid", shippingCostInCents: 500 });
  // THE REFUND. Real money went back, and the product and the postage were
  // still spent — so this order must SUBTRACT: not vanish, and not add.
  await order({ productId: costed.id, amountInCents: 4_000, status: "refunded", shippingCostInCents: 600 });
  // THE UNKNOWN COST. Excluded from the profit figure entirely; reading the
  // missing cost as 0 would silently invent 3_000 - 0 - 700 = 2_300 of profit.
  await order({ productId: uncosted.id, amountInCents: 3_000, status: "paid", shippingCostInCents: 700 });
  // Cost known, postage never recorded — the other kind of incompleteness.
  await order({ productId: costed.id, amountInCents: 2_500, status: "paid" });

  const profit = await getProfitability(s2.id);

  // (5_000 - 2_000 - 500) + (0 - 2_000 - 600) = 2_500 - 2_600 = -100.
  // Every wrong reading lands somewhere else: refund-as-revenue gives +3_900,
  // refund-excluded-entirely gives +2_500, unknown-cost-as-zero gives +2_200.
  check("profit after recorded costs", profit.netOfPostage.profitAfterRecordedCostsInCents, -100);
  assert("a refunded order is a LOSS, never revenue", (profit.netOfPostage.profitAfterRecordedCostsInCents ?? 0) < 0);
  check("only the two fully-costed orders are counted", profit.netOfPostage.ordersFullyCosted, 2);
  check("the unknown cost is an EXCLUSION", profit.netOfPostage.ordersWithoutProductCost, 1);
  check("the missing postage is a separate exclusion", profit.netOfPostage.ordersWithCostButNoPostage, 1);
  check("coverage is honest about being partial", profit.netOfPostage.coverage, "partial");
  // Postage is real money spent whether or not the order could be costed — the
  // refunded one and the uncosted one both still bought a label.
  check("postage counts every recorded label", profit.netOfPostage.postageSpentInCents, 1_800);
  assert("the figure carries its own scope", profit.netOfPostage.basis.includes("excludes payment-processing fees"));

  // A store where nothing is costed at all. The number must be ABSENT, not
  // zero — 0 reads as "broke even", which is a claim nobody made.
  await reset();
  const s3 = await business("uncosted-store");
  const only = await prisma.product.create({
    data: { storeId: s3.id, name: "Only", description: "d", priceInCents: 1_000, active: true },
  });
  await prisma.order.create({
    data: {
      storeId: s3.id,
      productId: only.id,
      productName: "x",
      buyerEmail: "b@example.test",
      amountInCents: 1_000,
      paymentProvider: "STRIPE",
      externalOrderId: "u-1",
      shippingCostInCents: 200,
    },
  });
  const none = await getProfitability(s3.id);
  check("no costed order -> null, never 0", none.netOfPostage.profitAfterRecordedCostsInCents, null);
  check("coverage says none", none.netOfPostage.coverage, "none");

  // ==========================================================================
  console.log("\n=== 3. getObligations — real status values, and the address ===\n");
  // ==========================================================================
  await reset();
  const s4 = await business("obligations-store");
  // A REAL ADDRESS ON EVERY ROW. The privacy assertion is only worth something
  // if the data it must not surface is genuinely there to be surfaced.
  const ADDRESS = {
    line1: "17 Trafalgar Crescent",
    city: "Hartlepool",
    postalCode: "TS24 8NP",
    country: "GB",
    name: "Priya Raghunathan",
  };
  let oext = 0;
  const obligation = (data: Record<string, unknown>) =>
    prisma.order.create({
      data: {
        storeId: s4.id,
        productName: "Foam roller",
        buyerEmail: "waiting@example.test",
        amountInCents: 1_000,
        paymentProvider: "STRIPE",
        externalOrderId: `ob-${++oext}`,
        shippingAddress: ADDRESS,
        ...data,
      } as never,
    });

  await obligation({
    status: "paid",
    fulfillmentStatus: "unfulfilled",
    createdAt: daysAgo(5),
    trackingNumber: "1Z999",
    carrier: "USPS",
  });
  await obligation({ status: "paid", fulfillmentStatus: "unfulfilled", createdAt: daysAgo(12) });
  // Money went back. No package is owed, and this must never join `outstanding`.
  await obligation({ status: "refunded", fulfillmentStatus: "unfulfilled", createdAt: daysAgo(3) });
  // A status this module has never seen. Counted, named, and NOT assumed owed.
  await obligation({ status: "pending", fulfillmentStatus: "unfulfilled", createdAt: daysAgo(2) });
  await obligation({
    status: "paid",
    fulfillmentStatus: "fulfilled",
    createdAt: daysAgo(9),
    fulfilledAt: daysAgo(8),
  });

  const owed = await getObligations(s4.id);

  check("only paid+unfulfilled are owed", owed.outstandingCount, 2);
  check("oldest first", owed.outstanding.map((o) => o.daysWaiting), [12, 5]);
  check("oldest waiting days", owed.oldestWaitingDays, 12);
  check(
    "a real label is reported as a label, not as shipped",
    owed.outstanding.map((o) => o.labelPurchased),
    [false, true]
  );
  check("carrier only where one exists", owed.outstanding.map((o) => o.carrier), [null, "USPS"]);
  check("refunded-and-unfulfilled is counted apart", owed.refundedUnfulfilledCount, 1);
  check("an unrecognised status is counted, not assumed owed", owed.otherUnfulfilledCount, 1);
  check("and it is NAMED", owed.otherUnfulfilledStatuses, ["pending"]);
  // The breakdown counts every unfulfilled order including the refunded one, so
  // these two numbers legitimately disagree — and must not be conflated.
  check("breakdown carried through unchanged", { f: owed.fulfilledCount, u: owed.unfulfilledCount }, { f: 1, u: 4 });
  assert("unfulfilledCount is NOT outstandingCount", owed.unfulfilledCount !== owed.outstandingCount);

  // THE PRIVACY ASSERTION. Not "shippingAddress is absent from the select" —
  // that is readable from the source. This asks whether any part of a real
  // address that IS in the database reached the answer.
  const serialized = JSON.stringify(owed);
  check(
    "no part of the shipping address reaches the answer",
    Object.values(ADDRESS).filter((v) => serialized.includes(v)),
    []
  );
  assert(
    "and who is waiting is still answerable",
    owed.outstanding.every((o) => o.buyerEmail === "waiting@example.test")
  );

  await reset();
  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All BI read assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
