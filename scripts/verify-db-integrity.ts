import { startTestDatabase } from "@/scripts/lib/testDatabase";
import { withTenantIsolation } from "@/lib/tenantIsolation";

// The things that could previously only be verified by READING. Needs no
// database of your own — it starts a real Postgres in-process:
//
//   npx tsx scripts/verify-db-integrity.ts
//
// Every other suite in this repo is pure, because every other suite could be.
// These properties cannot: order idempotency is a unique constraint, the tenant
// guard is a Prisma client extension, and the ledger's real behaviour is a
// transaction. Reading them is not evidence that they work.
//
// The database here is PGlite running the REAL migration files. It cannot reach
// production — the connection string is built from a port this process opened.

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


async function main() {
  const db = await startTestDatabase();
  const raw = db.prisma;

  // Deliberate failures go through the harness, which heals the connection —
  // PGlite closes it on any Postgres-level error. See testDatabase.ts.
  const refuses = async (label: string, fn: () => Promise<unknown>) =>
    assert(label, await db.expectRejected(fn));
  // The same guard the app runs behind, applied to the same client.
  const guarded = withTenantIsolation(raw);

  async function makeStore(slug: string, email: string) {
    const user = await raw.user.create({ data: { email } });
    return raw.store.create({
      data: { userId: user.id, name: slug, slug, description: "", tagline: "" },
    });
  }

  // -------------------------------------------------------------------------
  console.log("\n1. Every migration applies to an empty database");
  {
    // startTestDatabase ran `prisma migrate deploy` against a database created
    // seconds ago. Reaching this line at all means all of them applied in order
    // — which is the one property a migration has that cannot be code-reviewed.
    const applied = await raw.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*)::bigint AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    assert("all migrations applied cleanly from scratch", Number(applied[0].count) > 0, `${applied[0].count} migrations`);

    // The two added during this audit, confirmed present rather than assumed.
    const cols = await raw.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'passwordChangedAt'`;
    check("passwordChangedAt exists", cols.length, 1);
    const authAttempt = await raw.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_name = 'AuthAttempt'`;
    check("AuthAttempt exists", authAttempt.length, 1);
  }

  // -------------------------------------------------------------------------
  console.log("\n2. The tenant guard actually blocks a real query");
  {
    await db.reset();
    const mine = await makeStore("mine", "mine@example.com");
    const theirs = await makeStore("theirs", "theirs@example.com");
    await raw.order.create({
      data: {
        storeId: theirs.id, productName: "Their candle", amountInCents: 4200,
        buyerEmail: "buyer@example.com", status: "paid",
        paymentProvider: "STRIPE", externalOrderId: "cs_theirs_1",
      },
    });

    // The whole point of the extension: an unscoped collection read is refused
    // at the client, before it ever reaches Postgres.
    await refuses("an unscoped findMany is refused", () => guarded.order.findMany({}));
    await refuses("so is an unscoped count", () => guarded.order.count({}));
    await refuses("and a filter that scopes nothing", () => guarded.order.findMany({ where: { status: "paid" } }));

    // The two bypasses, against the REAL client this time — the pure test
    // proved the predicate; this proves the extension uses it.
    await refuses("a negated storeId is refused", () => guarded.order.findMany({ where: { storeId: { not: mine.id } } }));
    await refuses("a store filter naming no store is refused", () => guarded.order.findMany({ where: { store: { published: true } } }));

    // And a properly scoped read still works, returning only that store's rows.
    const scoped = await guarded.order.findMany({ where: { storeId: theirs.id } });
    check("a scoped read works", scoped.length, 1);
    const mineOnly = await guarded.order.findMany({ where: { storeId: mine.id } });
    check("and returns nothing for a store with no orders", mineOnly.length, 0);

    // A mutation aimed at another store's row cannot be written unscoped.
    await refuses("an unscoped updateMany is refused",
      () => guarded.order.updateMany({ where: { status: "paid" }, data: { status: "refunded" } }));
  }

  // -------------------------------------------------------------------------
  console.log("\n3. One payment cannot become two orders");
  {
    await db.reset();
    const store = await makeStore("shop", "shop@example.com");
    const session = "cs_test_replay";

    const create = () =>
      raw.order.create({
        data: {
          storeId: store.id, productName: "Candle", amountInCents: 2500,
          buyerEmail: "buyer@example.com", status: "paid",
          paymentProvider: "STRIPE", externalOrderId: session,
        },
      });

    await create();
    // Stripe redelivers. The webhook checks for an existing row inside the same
    // transaction as the write, but the constraint underneath it is what makes
    // that check load-bearing rather than advisory.
    await refuses("a replayed session cannot create a second order", create);
    check("exactly one order exists", await raw.order.count({ where: { storeId: store.id } }), 1);

    // The uniqueness is per PROVIDER, not global — a PayPal order id that
    // happened to collide with a Stripe session id must not be rejected.
    await raw.order.create({
      data: {
        storeId: store.id, productName: "Candle", amountInCents: 2500,
        buyerEmail: "buyer@example.com", status: "paid",
        paymentProvider: "PAYPAL", externalOrderId: session,
      },
    });
    check("the same id under a different provider is a separate order",
      await raw.order.count({ where: { storeId: store.id } }), 2);
  }

  // -------------------------------------------------------------------------
  console.log("\n4. A Growth Point purchase cannot be credited twice");
  {
    await db.reset();
    const store = await makeStore("points", "points@example.com");
    const sessionId = "cs_points_1";

    const credit = () =>
      raw.growthPointTransaction.create({
        data: {
          storeId: store.id, type: "PURCHASE", amount: 500, balanceAfter: 500,
          externalRef: sessionId, description: "Purchased 500 Growth Points",
        },
      });

    await credit();
    // The unique externalRef is what makes creditGrowthPointsFromPurchase's
    // in-transaction existence check safe against a concurrent redelivery
    // rather than merely usually-correct.
    await refuses("a redelivered purchase event cannot credit twice", credit);
    check("exactly one purchase row", await raw.growthPointTransaction.count({ where: { storeId: store.id } }), 1);

    // Deduction rows legitimately carry no externalRef, and many of them must
    // coexist — a unique constraint that rejected repeated NULLs would break
    // every store after its second action.
    for (let i = 0; i < 3; i++) {
      await raw.growthPointTransaction.create({
        data: { storeId: store.id, type: "DEDUCTION", amount: -10, balanceAfter: 490 - i * 10, description: "Invested" },
      });
    }
    check("many deductions with no externalRef coexist",
      await raw.growthPointTransaction.count({ where: { storeId: store.id, type: "DEDUCTION" } }), 3);
  }

  // -------------------------------------------------------------------------
  console.log("\n5. A store's data dies with the store");
  {
    await db.reset();
    const store = await makeStore("closing", "closing@example.com");
    await raw.order.create({
      data: {
        storeId: store.id, productName: "Candle", amountInCents: 1000,
        buyerEmail: "b@example.com", status: "paid",
        paymentProvider: "STRIPE", externalOrderId: "cs_cascade",
      },
    });
    await raw.growthPointTransaction.create({
      data: { storeId: store.id, type: "PURCHASE", amount: 100, balanceAfter: 100, description: "x" },
    });

    await raw.store.delete({ where: { id: store.id } });

    // Orphaned rows carrying a deleted store's customer emails and money
    // history would be a real data-retention problem, not just untidiness.
    check("orders are gone", await raw.order.count({ where: { storeId: store.id } }), 0);
    check("ledger rows are gone", await raw.growthPointTransaction.count({ where: { storeId: store.id } }), 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n6. Auth throttle rows behave as the limiter assumes");
  {
    await db.reset();
    const bucket = "a".repeat(64);
    for (let i = 0; i < 3; i++) {
      await raw.authAttempt.create({ data: { bucket } });
    }
    // The limiter counts rows in a bucket within a window. Repeated identical
    // buckets MUST be allowed — a unique constraint here would silently cap
    // every attacker at one attempt and every real user at one mistake.
    check("repeated attempts in one bucket all record",
      await raw.authAttempt.count({ where: { bucket } }), 3);

    const old = new Date(Date.now() - 60 * 60 * 1000);
    await raw.authAttempt.create({ data: { bucket, occurredAt: old } });
    const recent = await raw.authAttempt.count({
      where: { bucket, occurredAt: { gte: new Date(Date.now() - 15 * 60 * 1000) } },
    });
    check("and an expired one falls out of the window", recent, 3);
  }

  await db.close();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
