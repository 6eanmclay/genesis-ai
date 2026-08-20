import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import type { PaypalCredentials } from "@/lib/integrations/paypal";

// The refund subscription's whole life, against a real database:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-paypal-webhook-lifecycle.ts" -OutFile out.txt
//
// §42 proves what happens when a refund arrives. This proves the store is in a
// state where one CAN arrive — which is a different question, and the one every
// store connected before refund webhooks existed gets wrong.
//
// The REAL connector runs against a real Postgres. Only PayPal's HTTP responses
// are supplied. VERCEL_PROJECT_PRODUCTION_URL is set, which is also what the
// production path uses: a durable subscription must be registered against the
// canonical domain, never whichever host the connecting request arrived on.

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

/** Everything PayPal is asked to do, in order, so silence is provable too. */
const calls: string[] = [];

interface PaypalWorld {
  /** Subscriptions PayPal believes exist, by id. */
  webhooks: Map<string, string>;
  /** Refuse to create anything — a development host, or an app without scope. */
  refuseCreate?: { status: number; body: unknown };
  /** Answer a GET of a stored id with this instead of the truth. */
  lookupOverride?: { status: number };
}

let world: PaypalWorld;
let nextWebhookId = 1;

function installPaypalStub() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (url.includes("/v1/oauth2/token")) {
      calls.push("token");
      return json({ access_token: "A-TOKEN" });
    }

    const webhookMatch = url.match(/\/v1\/notifications\/webhooks\/([^/?#]+)$/);
    if (webhookMatch) {
      const id = webhookMatch[1];
      if (method === "DELETE") {
        calls.push(`delete:${id}`);
        world.webhooks.delete(id);
        return new Response(null, { status: 204 });
      }
      calls.push(`lookup:${id}`);
      if (world.lookupOverride) return new Response(null, { status: world.lookupOverride.status });
      return world.webhooks.has(id)
        ? json({ id, url: world.webhooks.get(id) })
        : new Response(JSON.stringify({ name: "INVALID_RESOURCE_ID" }), { status: 404 });
    }

    if (url.endsWith("/v1/notifications/webhooks")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        calls.push(`create:${body.url}`);
        if (world.refuseCreate) return json(world.refuseCreate.body, world.refuseCreate.status);
        const taken = [...world.webhooks.values()].includes(body.url);
        if (taken) {
          return json({ name: "WEBHOOK_URL_ALREADY_EXISTS", message: "already there" }, 400);
        }
        const id = `WH-${nextWebhookId++}`;
        world.webhooks.set(id, body.url);
        return json({ id, url: body.url });
      }
      calls.push("list");
      return json({
        webhooks: [...world.webhooks.entries()].map(([id, u]) => ({ id, url: u })),
      });
    }

    return real(input as never, init);
  }) as typeof fetch;
}

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;
  process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  // The canonical domain. Nothing below ever reaches for a request host, which
  // is the point: connect() has one, verify() from a cron would not, and a
  // subscription registered against a preview deployment outlives the
  // deployment only in the sense that it keeps pointing at a dead hostname.
  process.env.VERCEL_PROJECT_PRODUCTION_URL = "genesis.example.test";

  installPaypalStub();

  const { paypalConnector } = await import("@/lib/integrations/paypal");
  const { prismaSystem: prisma } = await import("@/lib/prisma");
  const { decryptCredentials, encryptCredentials } = await import("@/lib/integrations/credentials");

  async function reset() {
    calls.length = 0;
    world = { webhooks: new Map() };
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
        AND tablename <> '_genesis_test_database'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
  }

  async function makeStore(slug: string) {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: `${slug} shop`, slug, tagline: "t", description: "d" },
    });
    return { store, user };
  }

  const connect = (storeId: string, userId: string) =>
    paypalConnector.connect(storeId, userId, {
      clientId: "a-client-id",
      clientSecret: "a-secret",
      environment: "sandbox",
    });

  const integrationFor = (storeId: string) =>
    prisma.storeIntegration.findUniqueOrThrow({
      where: { storeId_provider: { storeId, provider: "PAYPAL" } },
    });

  const storedCredentials = async (storeId: string) => {
    const row = await integrationFor(storeId);
    return row.credentials ? decryptCredentials<PaypalCredentials>(row.credentials) : null;
  };

  try {
    // -----------------------------------------------------------------------
    console.log("\n1. Connecting subscribes the merchant's own app to refunds");
    {
      await reset();
      const { store, user } = await makeStore("fresh");

      const result = await connect(store.id, user.id);
      check("connected", result, { kind: "connected" });

      const credentials = await storedCredentials(store.id);
      assert("a webhook id is stored", Boolean(credentials?.webhookId), String(credentials?.webhookId));
      // Nobody was asked to paste anything. The subscription was created with
      // the merchant's own credentials, which is the whole reason this shape
      // was chosen over a field on the connect form.
      check(
        "registered against the canonical domain and this store",
        world.webhooks.get(credentials!.webhookId!),
        `https://genesis.example.test/api/webhooks/paypal/${store.id}`
      );

      const row = await integrationFor(store.id);
      check("connected, with nothing to warn about", row.lastError, null);
      check("and reported as connected", row.status, "CONNECTED");
    }

    // -----------------------------------------------------------------------
    console.log("\n2. Reconnecting reuses the subscription rather than failing");
    {
      await reset();
      const { store, user } = await makeStore("reconnect");
      await connect(store.id, user.id);
      const first = (await storedCredentials(store.id))!.webhookId;

      // PayPal refuses a second subscription on a URL it already has. That is
      // the NORMAL answer on every reconnect, and treating it as a failure
      // would make rotating a secret break refunds.
      calls.length = 0;
      const again = await connect(store.id, user.id);
      check("still connected", again, { kind: "connected" });
      check("the same subscription is kept", (await storedCredentials(store.id))!.webhookId, first);
      assert("PayPal was asked, and answered from its own list", calls.includes("list"), calls.join(", "));
      check("no second subscription exists", world.webhooks.size, 1);
      check("and no warning is shown", (await integrationFor(store.id)).lastError, null);
    }

    // -----------------------------------------------------------------------
    console.log("\n3. A refused subscription still leaves a working payment rail");
    {
      await reset();
      const { store, user } = await makeStore("no-webhook-possible");
      // What every development machine gets: PayPal will not register a webhook
      // on a URL it cannot reach.
      world.refuseCreate = { status: 400, body: { name: "INVALID_PARAMETER_VALUE" } };

      const result = await connect(store.id, user.id);
      check("the merchant can still take money", result, { kind: "connected" });
      const row = await integrationFor(store.id);
      check("and is still CONNECTED", row.status, "CONNECTED");
      check("with no webhook stored", (await storedCredentials(store.id))!.webhookId, null);
      // Failing the whole connection here would trade a reporting gap for no
      // payment rail at all. Saying nothing would be worse than either.
      assert("but told what it costs them", (row.lastError ?? "").includes("refunds will not reach Genesis"), String(row.lastError));
      assert("in terms of the consequence, not the API", (row.lastError ?? "").includes("counting as revenue"), String(row.lastError));
    }

    // -----------------------------------------------------------------------
    console.log("\n4. Verify repairs a store that connected before any of this existed");
    {
      await reset();
      const { store, user } = await makeStore("legacy");
      await connect(store.id, user.id);
      // Rewind it to what a store connected last week actually looks like: real
      // credentials, no subscription, and nothing anywhere that would ever give
      // it one. Its refunds 404 forever while it shows a contented green tick.
      await prisma.storeIntegration.update({
        where: { storeId_provider: { storeId: store.id, provider: "PAYPAL" } },
        data: {
          credentials: encryptCredentials({
            schemaVersion: 1,
            clientId: "a-client-id",
            clientSecret: "a-secret",
            environment: "sandbox",
          }),
        },
      });
      world.webhooks.clear();
      check("the starting point: no subscription", (await storedCredentials(store.id))!.webhookId ?? null, null);

      const verified = await paypalConnector.verify(store.id);
      check("verify passes", verified, { ok: true });
      const repaired = (await storedCredentials(store.id))!.webhookId;
      assert("and a subscription now exists", Boolean(repaired), String(repaired));
      check("pointing at this store", world.webhooks.get(repaired!), `https://genesis.example.test/api/webhooks/paypal/${store.id}`);
      check("with nothing left to warn about", (await integrationFor(store.id)).lastError, null);
    }

    // -----------------------------------------------------------------------
    console.log("\n5. Verify notices a subscription deleted at PayPal");
    {
      await reset();
      const { store, user } = await makeStore("deleted-at-paypal");
      await connect(store.id, user.id);
      const original = (await storedCredentials(store.id))!.webhookId!;

      // The merchant tidied their PayPal dashboard. A stored id that no longer
      // resolves is worse than none at all: every delivery becomes unverifiable
      // while the integration insists it is configured.
      world.webhooks.delete(original);

      const verified = await paypalConnector.verify(store.id);
      check("verify passes", verified, { ok: true });
      const replacement = (await storedCredentials(store.id))!.webhookId;
      assert("a new subscription was created", Boolean(replacement) && replacement !== original, String(replacement));
      check("and it is real", world.webhooks.has(replacement!), true);
    }

    // -----------------------------------------------------------------------
    console.log("\n6. An inconclusive answer does not throw away a good subscription");
    {
      await reset();
      const { store, user } = await makeStore("paypal-wobbly");
      await connect(store.id, user.id);
      const original = (await storedCredentials(store.id))!.webhookId!;

      // 500 is not 404. "PayPal is having a bad minute" must not be read as
      // "this subscription is gone" — that would churn a new subscription on
      // every wobble and leave a trail of dead ones in the merchant's account.
      world.lookupOverride = { status: 500 };
      calls.length = 0;
      const verified = await paypalConnector.verify(store.id);
      check("verify still passes", verified, { ok: true });
      check("the subscription is untouched", (await storedCredentials(store.id))!.webhookId, original);
      assert("and nothing new was created", !calls.some((c) => c.startsWith("create:")), calls.join(", "));
      check("PayPal still holds exactly one", world.webhooks.size, 1);
    }

    // -----------------------------------------------------------------------
    console.log("\n7. Verify still fails when the credentials are the problem");
    {
      await reset();
      const { store, user } = await makeStore("bad-credentials");
      await connect(store.id, user.id);

      // The subscription work must not swallow the thing verify existed to
      // check. A token exchange that fails is still a failed verification.
      const real = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (url.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify({ error_description: "Client Authentication failed" }), { status: 401 });
        }
        return real(input as never, init);
      }) as typeof fetch;

      const verified = await paypalConnector.verify(store.id);
      globalThis.fetch = real;
      check("it fails", (verified as { ok: boolean }).ok, false);
      const row = await integrationFor(store.id);
      check("and says so on the integration", row.status, "FAILED");
      assert("with PayPal's own reason", (row.lastError ?? "").includes("Client Authentication failed"), String(row.lastError));
    }

    // -----------------------------------------------------------------------
    console.log("\n8. Disconnecting takes the subscription with it");
    {
      await reset();
      const { store, user } = await makeStore("disconnect");
      await connect(store.id, user.id);
      const webhookId = (await storedCredentials(store.id))!.webhookId!;
      check("PayPal holds it", world.webhooks.has(webhookId), true);

      await paypalConnector.disconnect(store.id);
      // Genesis created it in the merchant's account, so Genesis should not
      // leave it behind pointing at a store that no longer takes PayPal.
      check("it is deleted at PayPal too", world.webhooks.has(webhookId), false);
      const row = await integrationFor(store.id);
      check("the integration is disconnected", row.status, "DISCONNECTED");
      check("and the credentials are gone", row.credentials, null);
    }

    // -----------------------------------------------------------------------
    console.log("\n9. A subscription that will not delete never blocks disconnecting");
    {
      await reset();
      const { store, user } = await makeStore("stubborn");
      await connect(store.id, user.id);

      const real = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (url.includes("/v1/notifications/webhooks/")) throw new Error("PayPal is down");
        return real(input as never, init);
      }) as typeof fetch;

      // A webhook we fail to delete is noise; its events are ignored the moment
      // the credentials are gone. Somebody wanting out must always get out.
      await paypalConnector.disconnect(store.id);
      globalThis.fetch = real;
      const row = await integrationFor(store.id);
      check("disconnected anyway", row.status, "DISCONNECTED");
      check("with the credentials gone", row.credentials, null);
    }

    // -----------------------------------------------------------------------
    console.log("\n10. Two stores never share a subscription");
    {
      await reset();
      const a = await makeStore("multi-a");
      const b = await makeStore("multi-b");
      // One owner, one PayPal app, two stores — a real, ordinary case. Each
      // store's URL carries its own id, so PayPal creates two subscriptions and
      // a refund can only ever be verified for the store it belongs to.
      await connect(a.store.id, a.user.id);
      await connect(b.store.id, b.user.id);

      const wa = (await storedCredentials(a.store.id))!.webhookId!;
      const wb = (await storedCredentials(b.store.id))!.webhookId!;
      assert("two different subscriptions", wa !== wb, `${wa} / ${wb}`);
      check("each pointing at its own store", world.webhooks.get(wa), `https://genesis.example.test/api/webhooks/paypal/${a.store.id}`);
      check("and the other at its own", world.webhooks.get(wb), `https://genesis.example.test/api/webhooks/paypal/${b.store.id}`);

      // Disconnecting one leaves the other alone.
      await paypalConnector.disconnect(a.store.id);
      check("the disconnected store's subscription is gone", world.webhooks.has(wa), false);
      check("the other store still has one", world.webhooks.has(wb), true);
      check("and is still connected", (await integrationFor(b.store.id)).status, "CONNECTED");
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
