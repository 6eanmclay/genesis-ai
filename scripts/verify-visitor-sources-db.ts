import "@/scripts/lib/allowServerOnly";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prismaSystem } from "@/lib/prisma";
import { getVisitorSources } from "@/lib/dashboard/visitorSources";

// WHERE VISITORS CAME FROM, AND THE TWO WAYS THIS QUIETLY GOES WRONG:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts visitor-sources-db
//
// ============ BOTH FAILURE MODES ARE REAL, NOT HYPOTHETICAL ============
//
// A read-only production read on 2026-09-13 found both before a line of this
// surface was written, which is why they are the two things this suite exists
// to hold down. Neither is visible by reading the screen: each produces a
// smaller number that looks entirely plausible.
//
//   1. COUNTING ORDERS ON attributionSource INSTEAD OF attributionKind.
//      `direct_unknown` carries a null source BY DESIGN, so filtering on the
//      source column silently drops every directly-attributed order.
//      Production: 7 orders carry a kind, 5 carry a source — a 29% undercount
//      that reads as a bug in the recorder rather than in the query.
//
//   2. AN EMPTY STATE THAT IS NOT AN ESTABLISHED ZERO. "No rows came back"
//      and "this store has had no visitors" are different claims, and the
//      surface may only make the second one. The n=0 case is asserted on the
//      real query against a real empty store rather than assumed.
//
// The single-visit state is asserted too, because a store with one visit is
// the TYPICAL store in production — 511 of 524 visits belong to one shop and
// seven others have exactly one — so n=1 is the common case, not an edge.
//
// And the hosts are asserted to stay apart. lib/attribution/classify.ts fixes
// the rule ("A HOST IS RECORDED AS THE HOST IT IS", "linktr.ee STAYS
// linktr.ee"); collapsing the Facebook family at the read would reintroduce
// exactly the inference the recorder refuses to make.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${name}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  assert(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/** A store, seeded through the system client so the tenant guard is not the subject. */
async function makeStore(stamp: number, suffix: string) {
  const user = await prismaSystem.user.create({
    data: { email: `vis-${suffix}-${stamp}@example.test`, name: "Owner", password: "x" },
  });
  return prismaSystem.store.create({
    data: {
      userId: user.id,
      name: `Visit Shop ${suffix}`,
      slug: `vis-${suffix}-${stamp}`,
      currency: "USD",
    },
  });
}

async function visit(
  storeId: string,
  token: string,
  kind: string,
  source: string | null,
  seenAt?: Date,
) {
  await prismaSystem.storeVisit.create({
    data: {
      storeId,
      visitToken: token,
      attributionKind: kind,
      source,
      evidence: source ? "Referer host" : "no Referer header",
      landingPath: "/",
      ...(seenAt ? { firstSeenAt: seenAt, lastSeenAt: seenAt } : {}),
    },
  });
}

async function order(
  storeId: string,
  ref: string,
  kind: string | null,
  source: string | null,
) {
  await prismaSystem.order.create({
    data: {
      storeId,
      productName: "Copper Tensor Ring",
      quantity: 1,
      amountInCents: 3232,
      buyerEmail: `buyer-${ref}@example.test`,
      paymentProvider: "STRIPE",
      externalOrderId: `cs_vis_${ref}`,
      status: "paid",
      attributionKind: kind,
      attributionSource: source,
    },
  });
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  // =====================================================================
  console.log("\n--- an established zero, not an absence ---\n");
  // =====================================================================
  {
    const empty = await makeStore(stamp, "empty");
    const read = await getVisitorSources(empty.id);

    // THE WHOLE POINT OF THIS SECTION. The store exists, the query ran, and
    // every field says "nothing" rather than being undefined or absent — so
    // the surface can state a zero it actually established.
    eq("a store with no visits reports zero visits", read.totalVisits, 0);
    eq("with no window to report", [read.firstSeenAt, read.lastSeenAt], [null, null]);
    eq("no kinds", read.byKind, []);
    eq("no sources", read.sources, []);
    eq("no orders", read.totalOrders, 0);
    eq("and no attributed orders", read.attributedOrders, 0);
    eq("and nothing to break down", read.orderSources, []);
  }

  // =====================================================================
  console.log("\n--- one visit is a first-class state, not a degenerate one ---\n");
  // =====================================================================
  {
    const solo = await makeStore(stamp, "solo");
    const when = new Date("2026-09-10T11:00:00.000Z");
    await visit(solo.id, `tok-solo-${stamp}`, "observed_referral", "t.co", when);
    const read = await getVisitorSources(solo.id);

    eq("one visit counts as one", read.totalVisits, 1);
    eq("one kind, with one visit in it", read.byKind, [{ kind: "observed_referral", visits: 1 }]);
    eq("one source, named as recorded", read.sources, [
      { source: "t.co", kind: "observed_referral", visits: 1 },
    ]);
    // The window is a single instant, which the screen must render as a day
    // rather than as a range from a date to itself.
    assert(
      "and the window opens and closes on the same day",
      read.firstSeenAt !== null &&
        read.lastSeenAt !== null &&
        read.firstSeenAt.toDateString() === read.lastSeenAt.toDateString(),
      `${read.firstSeenAt?.toISOString()} → ${read.lastSeenAt?.toISOString()}`,
    );
  }

  // =====================================================================
  console.log("\n--- orders are counted by kind, never by source ---\n");
  // =====================================================================
  {
    const shop = await makeStore(stamp, "orders");
    // Referred and attributed — carries both a kind and a host.
    await order(shop.id, `a-${stamp}`, "observed_referral", "t.co");
    // ATTRIBUTED AS DIRECT. A kind, and a null source BY DESIGN. This is the
    // row a source-column filter silently drops.
    await order(shop.id, `b-${stamp}`, "direct_unknown", null);
    // Genuinely unattributed — predates the recorder. Not an attributed order
    // and must not be counted as one.
    await order(shop.id, `c-${stamp}`, null, null);

    const read = await getVisitorSources(shop.id);

    eq("every order is counted", read.totalOrders, 3);
    // THE ASSERTION THIS SUITE EXISTS FOR. Two, not one: counting on
    // attributionSource returns 1 here and looks perfectly reasonable.
    eq("two of them carry attribution", read.attributedOrders, 2);
    assert(
      "and the directly-attributed order is one of them",
      read.orderSources.some((row) => row.kind === "direct_unknown" && row.source === null),
      JSON.stringify(read.orderSources),
    );
    assert(
      "while the unattributed order is not",
      read.orderSources.every((row) => row.kind !== null),
      JSON.stringify(read.orderSources),
    );
    // The headline and the list are built from the same rows, so they cannot
    // disagree — a total computed separately is how they drift.
    eq(
      "the total matches the breakdown it summarises",
      read.orderSources.reduce((sum, row) => sum + row.orders, 0),
      read.attributedOrders,
    );
  }

  // =====================================================================
  console.log("\n--- hosts stay as recorded, and the dominant kind leads ---\n");
  // =====================================================================
  {
    const busy = await makeStore(stamp, "busy");
    // The Facebook family, exactly as production holds it.
    await visit(busy.id, `f1-${stamp}`, "observed_referral", "facebook.com");
    await visit(busy.id, `f2-${stamp}`, "observed_referral", "facebook.com");
    await visit(busy.id, `f3-${stamp}`, "observed_referral", "m.facebook.com");
    // Direct traffic, the dominant kind here as it is in production.
    for (let i = 0; i < 5; i++) {
      await visit(busy.id, `d${i}-${stamp}`, "direct_unknown", null);
    }

    const read = await getVisitorSources(busy.id);
    eq("every visit is counted", read.totalVisits, 8);

    // NOT GROUPED. Two rows, not one row of three.
    const fb = read.sources.filter((row) => row.source.endsWith("facebook.com"));
    eq("facebook.com and m.facebook.com stay two separate sources", fb.length, 2);
    assert(
      "and neither is renamed to a platform",
      fb.every((row) => row.source === "facebook.com" || row.source === "m.facebook.com"),
      JSON.stringify(fb),
    );

    // Direct traffic has no host, so it is absent from the source list and
    // present in full in the kind breakdown. Both facts matter: the surface
    // must not let 5 unattributable visits vanish between the two lists.
    assert(
      "direct traffic appears in no source row",
      read.sources.every((row) => row.kind !== "direct_unknown"),
      JSON.stringify(read.sources),
    );
    eq(
      "the kinds still account for every visit",
      read.byKind.reduce((sum, row) => sum + row.visits, 0),
      read.totalVisits,
    );
    // Ordered by its own size, not by being named in the code.
    eq("and the dominant kind leads", read.byKind[0], { kind: "direct_unknown", visits: 5 });
  }

  // =====================================================================
  console.log("\n--- one business's traffic is not another's ---\n");
  // =====================================================================
  {
    const mine = await makeStore(stamp, "mine");
    const theirs = await makeStore(stamp, "theirs");
    await visit(mine.id, `m-${stamp}`, "observed_referral", "t.co");
    await visit(theirs.id, `t1-${stamp}`, "observed_referral", "youtube.com");
    await visit(theirs.id, `t2-${stamp}`, "direct_unknown", null);
    await order(theirs.id, `t-${stamp}`, "observed_referral", "youtube.com");

    const read = await getVisitorSources(mine.id);
    eq("only this store's visits are counted", read.totalVisits, 1);
    eq("only this store's sources are listed", read.sources, [
      { source: "t.co", kind: "observed_referral", visits: 1 },
    ]);
    eq("and another store's attributed order is not borrowed", read.attributedOrders, 0);
  }

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failures > 0) {
    console.log("\nFAILED:");
    for (const line of failed) console.log(`  ${line}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaSystem.$disconnect();
  });
