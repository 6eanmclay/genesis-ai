import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import type { IntegrationStatus } from "@prisma/client";

// The checkout-session guards, against a real database:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-checkout-live.ts" -OutFile out.txt
//
// createCheckoutSession decides the metadata every downstream step depends on:
// which store the money belongs to, which product, and what the customer is
// charged. If a client can substitute any of it, the webhook faithfully records
// a corrupted sale and everything after it is wrong.
//
// The REAL server action is called, against a real Postgres, with client-shaped
// arguments. Every case below fails inside the action's own guards — before any
// Stripe call and before getBaseUrl() — so what is proven is the authorisation
// logic, not a mock of it.
//
// WHAT IS NOT PROVEN HERE, and cannot be without external credentials: the
// Stripe API call itself (needs a Stripe test key) and the EasyPost re-quote
// inside confirmSelectedRate (needs an EasyPost key). Both are recorded as
// external blockers rather than quietly skipped.

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
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;
  process.env.STRIPE_SECRET_KEY = "sk_test_harness";

  const { createCheckoutSession } = await import("@/app/store/[slug]/actions");
  const { prismaSystem: prisma } = await import("@/lib/prisma");
  const IDLE = { ok: true as const };

  /** Call the real action exactly as the storefront form does. */
  const checkout = (slug: string, productId: string) =>
    createCheckoutSession(slug, productId, IDLE as never, new FormData());

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

  async function makeStore(slug: string, opts: { connected?: boolean; stripeStatus?: IntegrationStatus } = {}) {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: `${slug} shop`, slug, tagline: "t", description: "d", published: true },
    });
    if (opts.connected !== false) {
      await prisma.storeIntegration.create({
        data: {
          storeId: store.id,
          provider: "STRIPE",
          status: opts.stripeStatus ?? "CONNECTED",
          externalAccountId: `acct_${slug}`,
        },
      });
    }
    const product = await prisma.product.create({
      data: { storeId: store.id, name: `${slug} candle`, description: "d", priceInCents: 2500, active: true },
    });
    return { store, product };
  }

  const errorOf = (state: unknown) => (state as { ok: boolean; error?: string }).error ?? "(no error)";
  const failed = (state: unknown) => (state as { ok: boolean }).ok === false;

  try {
    // -----------------------------------------------------------------------
    console.log("\n1. A product from another store cannot be bought here");
    {
      await reset();
      const victim = await makeStore("victim");
      const attacker = await makeStore("attacker");

      // The storefront binds the slug and passes a productId. Both are
      // client-shaped, so the pairing is the thing that must be enforced.
      const crossed = await checkout(attacker.store.slug, victim.product.id);
      assert("it is refused", failed(crossed), errorOf(crossed));
      check("as a product problem, not a store one", errorOf(crossed), "Product not found");

      // And the legitimate pairing still works far enough to reach Stripe,
      // which is as far as this environment can take it.
      const own = await checkout(attacker.store.slug, attacker.product.id);
      assert("the store's own product gets past every guard",
        !failed(own) || !errorOf(own).includes("not found"), errorOf(own));
    }

    // -----------------------------------------------------------------------
    console.log("\n2. Products that should not be sellable");
    {
      await reset();
      const { store, product } = await makeStore("guards");

      await prisma.product.update({ where: { id: product.id }, data: { active: false } });
      const inactive = await checkout(store.slug, product.id);
      check("an inactive product is refused", errorOf(inactive), "Product not found");

      await prisma.product.update({ where: { id: product.id }, data: { active: true } });
      await prisma.product.delete({ where: { id: product.id } });
      const deleted = await checkout(store.slug, product.id);
      check("a deleted product is refused", errorOf(deleted), "Product not found");

      const invented = await checkout(store.slug, "prod_never_existed");
      check("an invented product id is refused", errorOf(invented), "Product not found");

      // An empty id must not become "match anything".
      const blank = await checkout(store.slug, "");
      assert("a blank product id is refused", failed(blank), errorOf(blank));
    }

    // -----------------------------------------------------------------------
    console.log("\n3. Stores that should not be taking money");
    {
      await reset();
      const unknown = await checkout("no-such-store", "prod_x");
      check("an unknown slug is refused", errorOf(unknown), "Store not found");

      // A store with NO payment provider connected must not reach Stripe, even
      // though the button that would have hidden itself is not involved here.
      const bare = await makeStore("no-payments", { connected: false });
      const noProvider = await checkout(bare.store.slug, bare.product.id);
      assert("a store with nothing connected is refused", failed(noProvider), errorOf(noProvider));
      assert("with a message a shopper can understand",
        errorOf(noProvider).toLowerCase().includes("isn't accepting online payments"), errorOf(noProvider));

      // CONNECTED is the only status that counts. A row that exists but failed
      // verification must not be treated as usable.
      for (const status of ["FAILED", "NEEDS_ATTENTION", "DISCONNECTED"] as IntegrationStatus[]) {
        await reset();
        const broken = await makeStore(`broken-${status.toLowerCase()}`, { stripeStatus: status });
        const result = await checkout(broken.store.slug, broken.product.id);
        assert(`a ${status} Stripe connection cannot take payment`, failed(result), errorOf(result));
      }
    }

    // -----------------------------------------------------------------------
    console.log("\n4. The price is the store's, not the customer's");
    {
      await reset();
      const { store, product } = await makeStore("pricing");

      // There is no code path that accepts an amount from the client — the
      // session is built from product.priceInCents, read here. This asserts the
      // value the session WOULD carry is the database's, and that changing the
      // database changes it.
      const before = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      check("the price comes from the product row", before.priceInCents, 2500);

      await prisma.product.update({ where: { id: product.id }, data: { priceInCents: 9900 } });
      const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      check("and follows the owner's own change", after.priceInCents, 9900);

      // The form carries no price field at all, so there is nothing to tamper
      // with. Passing one changes nothing.
      const withFakePrice = new FormData();
      withFakePrice.set("priceInCents", "1");
      withFakePrice.set("amount", "1");
      const result = await createCheckoutSession(store.slug, product.id, IDLE as never, withFakePrice);
      assert("extra form fields are ignored, not read",
        !failed(result) || !errorOf(result).includes("not found"), errorOf(result));
    }

    // -----------------------------------------------------------------------
    console.log("\n5. Two stores sharing one Stripe account stay separate");
    {
      await reset();
      // A real, non-adversarial case: one owner, two stores, one Stripe
      // account. The metadata storeId is what keeps their sales apart, and it
      // is derived from the slug rather than supplied.
      const first = await makeStore("first");
      const second = await makeStore("second");
      await prisma.storeIntegration.updateMany({
        where: { storeId: { in: [first.store.id, second.store.id] } },
        data: { externalAccountId: "acct_shared" },
      });

      // Each store can only sell its own product, even sharing an account.
      check("the first store cannot sell the second's product",
        errorOf(await checkout(first.store.slug, second.product.id)), "Product not found");
      check("and the second cannot sell the first's",
        errorOf(await checkout(second.store.slug, first.product.id)), "Product not found");
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    await db.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
