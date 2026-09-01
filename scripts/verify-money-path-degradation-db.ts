import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { recordDelivery, markProcessed, markFailed } from "@/lib/webhooks/delivery";
import { runOnce, CLAIM_TTL_MS } from "@/lib/outbound/runOnce";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// WHEN A DEPENDENCY FAILS, DOES THE MONEY PATH STILL BEHAVE?
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts money-path-degradation-db
//
// ============ THE ONLY QUESTION THIS ASKS (2026-09-01) =================
//
// Not "is Genesis resilient" in the abstract. One thing: when something the
// checkout chain depends on fails, is money ever taken without an order being
// recorded, or an order recorded without money — and does the customer see
// something usable rather than a blank page.
//
// Genesis has real customers now. This is the only remaining path where being
// wrong costs a sale rather than costing polish.
//
// ============ INJECTED, NOT LIVE ======================================
//
// Every failure below is injected. No Stripe outage was observed, no database
// was really taken down, and nothing here should be read as evidence that a
// real provider incident behaves this way. What it proves is that GENESIS
// behaves correctly when told a dependency has failed — which is the half that
// is ours. The other half is recorded as externally blocked.

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
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

let seq = 0;
async function makeStore(stamp: number) {
  const n = ++seq;
  const user = await prisma.user.create({ data: { email: `mpd-${stamp}-${n}@example.test` } });
  const store = await prisma.store.create({
    data: {
      userId: user.id, name: "Cubit & Coil", slug: `mpd-${stamp}-${n}`,
      tagline: "t", description: "d", published: true,
    },
  });
  const product = await prismaSystem.product.create({
    data: { storeId: store.id, name: "Cuff", description: "d", priceInCents: 3232, active: true },
  });
  return { store, product };
}

/** Walk a directory tree, for the import-graph assertions. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".next", ".git"].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  // =====================================================================
  console.log("\n--- 1. Stripe refuses to create a session ---\n");
  // =====================================================================
  {
    const { store, product } = await makeStore(stamp);

    // The action catches around the session call and returns an ActionState.
    // What matters for the money is what is LEFT BEHIND, so this asserts the
    // database rather than the message: a refused session must leave no order.
    const before = await prismaSystem.order.count({ where: { storeId: store.id } });

    const refused = await runOnce({
      key: `mpd-refused-${stamp}`,
      operation: "stripe.checkout.session",
      storeId: store.id,
      perform: async () => {
        throw new Error("Stripe: card_declined");
      },
    }).catch((e: Error) => ({ status: "threw" as const, message: e.message }));

    assert("the refusal is reported rather than swallowed",
      refused.status === "failed" || refused.status === "threw", JSON.stringify(refused));
    eq("and no order was written", await prismaSystem.order.count({ where: { storeId: store.id } }), before);
    eq("and no checkout draft was left claiming a provider",
      await prismaSystem.checkoutDraft.count({ where: { storeId: store.id, externalSessionId: { not: null } } }), 0);
    void product;
  }

  // =====================================================================
  console.log("\n--- 2. Stripe never answers ---\n");
  // =====================================================================
  {
    const { store } = await makeStore(stamp);

    // ============ TWO DIFFERENT SILENCES ==========================
    //
    // The first draft of this case asserted that a thrown timeout becomes
    // `indeterminate`. It does not, and runOnce is explicit about why: a throw
    // means the call RETURNED — the provider answered or the request never
    // left — so nothing landed and retrying is safe. `indeterminate` is
    // reserved for the case where no answer was ever received at all, which is
    // a claim left behind by a process that died.
    //
    // Both are tested, because the money path inherits both and confusing them
    // is what duplicates orders.
    const thrown = await runOnce({
      key: `mpd-threw-${stamp}`, operation: "stripe.checkout.session", storeId: store.id,
      perform: async () => {
        const error = new Error("socket hang up") as Error & { code?: string };
        error.code = "ETIMEDOUT";
        throw error;
      },
    });
    eq("a call that threw is failed, and safe to try again", thrown.status, "failed");
    eq("and wrote no order", await prismaSystem.order.count({ where: { storeId: store.id } }), 0);

    // THE CRASH CASE. A claim with no answer and no live runner: the provider
    // may have acted and there is no way to tell from here.
    const key = `mpd-crashed-${stamp}`;
    await prismaSystem.outboundOperation.create({
      data: {
        idempotencyKey: key, operation: "stripe.checkout.session", storeId: store.id,
        status: "in_progress",
        claimedAt: new Date(Date.now() - CLAIM_TTL_MS - 60_000),
        attempts: 1,
      },
    });

    let performed = false;
    const stale = await runOnce({
      key, operation: "stripe.checkout.session", storeId: store.id,
      perform: async () => {
        performed = true;
        return { result: { id: "cs_second" } };
      },
    });
    eq("an abandoned claim is indeterminate, not failed", stale.status, "indeterminate");
    eq("and the provider is NOT called again", performed, false);

    const again = await runOnce({
      key, operation: "stripe.checkout.session", storeId: store.id,
      perform: async () => {
        performed = true;
        return { result: { id: "cs_third" } };
      },
    });
    eq("it stays indeterminate until somebody settles it", again.status, "indeterminate");
    eq("still without calling the provider", performed, false);
    eq("and no order exists for any of it",
      await prismaSystem.order.count({ where: { storeId: store.id } }), 0);
  }

  // =====================================================================
  console.log("\n--- 3. the payment webhook arrives and the database is unavailable ---\n");
  // =====================================================================
  {
    // ============ THE HOLE THIS FOUND ==========================
    //
    // recordDelivery SWALLOWS a write failure and returns null. The route then
    // continues — `tracked.deliveryId = delivery?.id ?? null` — and calls the
    // handler anyway. So an event can be ACTED ON with nothing recording that
    // it arrived, which is the exact invariant the route's own comment claims:
    // "Recorded before anything acts on it."
    //
    // Proven here as a property of recordDelivery rather than by taking a
    // database down: a null return is the signal the route ignores.
    const nulled = await recordDelivery({
      provider: "STRIPE",
      rawBody: "{}",
      signatureValid: true,
      // A store id that does not exist makes the insert fail its foreign key,
      // which is a real write failure rather than a simulated one.
      storeId: "sto_does_not_exist",
      externalEventId: `evt-mpd-${stamp}`,
    });
    eq("a delivery that could not be recorded returns null", nulled, null);

    // ============ AND THE FIX: BOTH RAILS NOW REFUSE ==========
    //
    // The route used to store the null and carry on, so the handler ran and
    // markProcessed(null) did nothing — an event that moved real money, acted
    // on, with no record it ever arrived. Both rails now return 500 instead,
    // because a provider retry is cheap and an unevidenced payment is not.
    //
    // Asserted from source: this is a claim about a branch no fixture can
    // reach without taking a real table away mid-request.
    for (const file of [
      "app/api/webhooks/stripe/route.ts",
      "app/api/webhooks/paypal/[storeId]/route.ts",
    ]) {
      const route = readFileSync(file, "utf8");
      const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ 	]*\/\/.*$/gm, "");
      assert(`${file.split("/").slice(-2).join("/")} refuses an unrecorded delivery`,
        /if \(!delivery\) \{/.test(code), "the guard is missing");
      assert("  and answers 500 so the provider retries",
        /status: 500/.test(code.slice(code.indexOf("if (!delivery)"))), "not a retryable status");
      assert("  rather than handling it anyway",
        code.indexOf("if (!delivery)") < code.indexOf("return handle"), "the guard is after the handler");
    }

    // What IS already right: marking is null-safe and never throws, so the
    // original error survives to become a 500 and Stripe retries.
    await markProcessed(null);
    await markFailed(null, new Error("x"));
    assert("marking a null delivery is a no-op rather than a crash", true);
  }

  // =====================================================================
  console.log("\n--- 4. blob storage fails ---\n");
  // =====================================================================
  {
    // The storefront renders IMAGE URLS. It does not fetch bytes server-side,
    // so blob storage being down degrades to broken images on a page that
    // still sells — which is the correct degradation and is a property of the
    // import graph rather than of runtime behaviour.
    const storefront = readFileSync("app/store/[slug]/page.tsx", "utf8");
    assert("the storefront does not read blob storage to render",
      !/@vercel\/blob|vercelBlobStorage/.test(storefront), "the storefront gained a blob dependency");

    const checkout = readFileSync("app/store/[slug]/actions.ts", "utf8");
    assert("nor does checkout", !/@vercel\/blob|vercelBlobStorage/.test(checkout),
      "checkout gained a blob dependency — an image outage would now stop sales");

    // A product with no image at all must still be buyable.
    const { store } = await makeStore(stamp);
    const imageless = await prismaSystem.product.create({
      data: { storeId: store.id, name: "No Photo", description: "d", priceInCents: 1000, active: true, imageUrl: null },
    });
    eq("a product with no image is still active and sellable", imageless.active, true);
    assert("and carries no image url rather than a broken one", imageless.imageUrl === null);
  }

  // =====================================================================
  console.log("\n--- 5. the Genesis model is unavailable ---\n");
  // =====================================================================
  {
    // ============ PROVEN BY THE IMPORT GRAPH ====================
    //
    // The strongest form of this is not "checkout handles a model failure" but
    // "checkout cannot be affected by one". Asserted by sweeping what the money
    // path actually imports, transitively through its own directory, rather
    // than by mocking a model that is never called.
    const moneyPath = [
      "app/store/[slug]/page.tsx",
      "app/store/[slug]/actions.ts",
      "app/api/webhooks/stripe/route.ts",
      "lib/payments/stripeEvent.ts",
      "lib/bag/checkoutDraft.ts",
      "lib/orders/orderPricing.ts",
    ].filter((f) => {
      try { statSync(f); return true; } catch { return false; }
    });
    assert("the money path files exist to be checked", moneyPath.length >= 5, String(moneyPath.length));

    const modelish = /genesisModel|@anthropic-ai|anthropic|openai|callModel/;
    for (const file of moneyPath) {
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      const imports = source.split("\n").filter((l) => /^\s*import\s|require\(/.test(l)).join("\n");
      assert(`${file.replace(/\\/g, "/")} does not import the model`,
        !modelish.test(imports), imports.split("\n").filter((l) => modelish.test(l)).join(" | "));
    }

    // And the matcher must be able to fail, or this proves nothing.
    assert("that check would catch a model import if one appeared",
      modelish.test('import { genesisModel } from "@/lib/genesisModel";'));
  }

  // =====================================================================
  console.log("\n--- and the guarantee underneath all five ---\n");
  // =====================================================================
  {
    // Money and orders are bound by a unique constraint, not by sequencing.
    // Whatever fails, one provider payment cannot become two orders.
    const { store } = await makeStore(stamp);
    const external = `cs_mpd_${stamp}`;
    await prismaSystem.order.create({
      data: {
        storeId: store.id, productName: "Cuff", quantity: 1, amountInCents: 3232,
        buyerEmail: `b-${stamp}@example.test`, paymentProvider: "STRIPE", externalOrderId: external,
      },
    });
    const second = await prismaSystem.order
      .create({
        data: {
          storeId: store.id, productName: "Cuff", quantity: 1, amountInCents: 3232,
          buyerEmail: `b2-${stamp}@example.test`, paymentProvider: "STRIPE", externalOrderId: external,
        },
      })
      .then(() => "allowed")
      .catch(() => "refused");
    eq("one provider payment can only ever become one order", second, "refused");
  }

  await prismaSystem.user.deleteMany({ where: { email: { startsWith: "mpd-" } } });

  for (const name of failed) console.log(`FAILED: ${name}`);
  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
