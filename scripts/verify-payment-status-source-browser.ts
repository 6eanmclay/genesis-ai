import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { startTestServer } from "@/scripts/lib/testServer";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";

// WHICH SOURCE THE PAYMENTS CARD SPEAKS FROM:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-payment-status-source-browser.ts" -OutFile out.txt
//
// ============ THE CONTRACT (2026-09-13) ================================
//
//   StoreIntegration  is the CURRENT state. The badge, the message and the
//                     date all come from it.
//   ExecutionLog      is HISTORY. It may say when something last happened and
//                     may report a failed attempt while nothing is connected.
//                     It may never describe the present.
//
// The page used to read the latest CONNECT/VERIFY log and fall back to the row
// only when no log existed — which, since connecting always writes one, never
// happens for a connected store. Two consequences, both rendered below.
//
// A stale success spoke over a live problem: with the row at NEEDS_ATTENTION
// the card said "Needs attention", "This store can't take payments through
// Stripe right now", and "Stripe verified · verified" at the same time.
//
// And lastError was invisible: Stripe's verify sets CONNECTED when charges are
// enabled while recording that payouts to the owner's bank are not — "money
// will sit in Stripe until its requirements are met" — and a healthy account
// and a payouts-blocked one rendered identically.
//
// THIS SUITE DOES NOT ASSERT A NEW PRESENTATION. The payouts-blocked state
// still reads Connected, because the store genuinely can still sell; whether
// it deserves a presentation of its own is a separate decision that needs
// Stripe's `requirements`, which verify does not fetch. What is asserted is
// only that the sentence the product already wrote reaches the owner.

const PASSWORD = "a-real-passphrase-for-this-test";

const PAYOUT_NOTE =
  "Stripe can accept payments, but payouts to your bank are not enabled yet — money will sit in Stripe until its requirements are met.";

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${label}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  — ${detail}` : ""}`);
}

async function signIn(page: Page, baseUrl: string, email: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.click('button[type="submit"]').catch(() => {});
    try {
      await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
        timeout: 12_000,
      });
      break;
    } catch {
      // a submit clicked before hydration is lost
    }
  }
  await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
    timeout: 30_000,
  });
}

async function main() {
  console.log("Starting a real Next server on a real Postgres. First compile takes a while.\n");
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const stamp = Date.now();
    const user = await prisma.user.create({
      data: { email: `paysrc-${stamp}@example.test`, name: "Owner", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Rail Shop", slug: `paysrc-${stamp}`, currency: "USD", published: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: store.id } });

    const integration = await prisma.storeIntegration.create({
      data: {
        storeId: store.id, provider: "STRIPE", status: "CONNECTED",
        externalAccountId: `acct_${stamp}`, connectedByUserId: user.id,
        connectedAt: new Date(), lastVerifiedAt: new Date(),
      },
    });

    const log = (action: string, status: string, message: string, verified: boolean) =>
      prisma.executionLog.create({
        data: {
          executionId: randomUUID(), storeId: store.id, action, status,
          verified, message, actorType: "USER", actorId: user.id,
        },
      });

    // The log every connected store has, and the reason the old fallback was
    // unreachable for exactly the population that matters.
    await log(EXECUTION_ACTIONS.INTEGRATION_STRIPE_CONNECT, "SUCCESS", "Stripe connected", true);

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, user.email!);

    const card = async () => {
      const res = await page.goto(`${server.baseUrl}/b/${store.slug}/payments`, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      assert("payments renders", (res?.status() ?? 0) === 200, `status ${res?.status()}`);
      const body = await page.locator("body").innerText();
      const statusLine = await page.locator('[data-testid="stripe-status"]').count();
      return {
        body,
        status: statusLine > 0 ? (await page.locator('[data-testid="stripe-status"]').innerText()).trim() : "(none)",
      };
    };

    // ==================================================================
    console.log("\n1. Currently connected and healthy\n");
    // ==================================================================
    {
      const seen = await card();
      assert("the badge reads Connected", /✓\s*Connected/.test(seen.body), "");
      assert("and the line describes the connection", /Stripe connected/.test(seen.status), seen.status);
      assert("  saying it is verified", /verified/.test(seen.status), seen.status);
      assert("no payout warning, because there is none to give",
        !seen.body.includes("payouts to your bank"), "");
    }

    // ==================================================================
    console.log("\n2. Connected, but payouts to the bank are blocked\n");
    // ==================================================================
    {
      // EXACTLY WHAT stripe.ts WRITES: CONNECTED, because charges are enabled
      // and the store really can sell, with the payout problem in lastError.
      await prisma.storeIntegration.update({
        where: { id: integration.id },
        data: { status: "CONNECTED", lastError: PAYOUT_NOTE },
      });
      await log(EXECUTION_ACTIONS.INTEGRATION_STRIPE_VERIFY, "SUCCESS", "Stripe verified", true);

      const seen = await card();
      // THE BADGE IS UNCHANGED ON PURPOSE. They can still take payments; this
      // commit does not invent a third presentation.
      assert("the badge still reads Connected, because the store can still sell",
        /✓\s*Connected/.test(seen.body), "");
      assert("but the owner is finally told their money is not reaching the bank",
        seen.body.includes("payouts to your bank are not enabled yet"), seen.status);
      assert("  and it is not the log's 'Stripe verified' instead",
        !/^Stripe verified/.test(seen.status), seen.status);
    }

    // ==================================================================
    console.log("\n3. Currently failed, with a stale successful verify behind it\n");
    // ==================================================================
    {
      await prisma.storeIntegration.update({
        where: { id: integration.id },
        data: { status: "NEEDS_ATTENTION", lastError: "Charges are not yet enabled on this Stripe account" },
      });

      const seen = await card();
      assert("the badge reads Needs attention", /Needs attention/.test(seen.body), "");
      assert("and the line reports the CURRENT problem",
        seen.status.includes("Charges are not yet enabled"), seen.status);
      // THE CONTRADICTION THIS COMMIT EXISTS TO END. The newest log is still a
      // successful verify; it must not speak.
      assert("  not the stale success that is still the newest log",
        !seen.status.includes("Stripe verified"), seen.status);
      assert("  and nothing on the card claims it is verified",
        !/·\s*verified/.test(seen.status), seen.status);
    }

    // ==================================================================
    console.log("\n4. A historical failure, but currently healthy\n");
    // ==================================================================
    {
      await prisma.storeIntegration.update({
        where: { id: integration.id },
        data: { status: "CONNECTED", lastError: null, lastVerifiedAt: new Date() },
      });
      await log(EXECUTION_ACTIONS.INTEGRATION_STRIPE_VERIFY, "FAILED", "Verification failed: network error", false);

      const seen = await card();
      assert("the badge reads Connected", /✓\s*Connected/.test(seen.body), "");
      assert("the line describes the healthy connection", /Stripe connected/.test(seen.status), seen.status);
      // HISTORY MAY NOT OVERRIDE THE PRESENT. Under the old preference this
      // card read "Verification failed: network error" beside a green badge.
      assert("  and the failed attempt does not describe the present",
        !seen.status.includes("Verification failed"), seen.status);
      assert("  nor is it shown as a last-attempt failure, which is for when nothing is connected",
        !seen.body.includes("Last attempt failed"), "");
    }

    console.log(`\n${failures} failed, ${passes} passed`);
    if (failures > 0) {
      console.log("\nFAILED:");
      for (const line of failed) console.log(`  ${line}`);
      process.exitCode = 1;
    }
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
