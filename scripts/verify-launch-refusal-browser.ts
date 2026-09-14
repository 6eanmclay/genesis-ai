import bcrypt from "bcryptjs";
import { chromium, type Browser, type Page } from "playwright";
import { startTestServer } from "@/scripts/lib/testServer";

// WHAT THE OWNER IS TOLD WHEN GOING LIVE IS REFUSED:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-launch-refusal-browser.ts" -OutFile out.txt
//
// ============ THE CONTRACT (2026-09-14) ================================
//
// publishStoreExecutable refuses to publish a store with no connected payment
// provider, because lib/payments/router.ts has no platform-wide fallback any
// more and such a store is a dead end for a customer. It says why, in a
// sentence written for an owner:
//
//   "Connect Stripe or PayPal before publishing — customers won't be able to
//    check out otherwise."
//
// launchGoLive rethrows that verbatim. The OTHER route to the same executable
// — Website settings — already renders it: "Couldn't publish your store."
// above the failed log row's own message. This screen threw it away and said
// "Something went wrong going live — try again."
//
// Rendered, that produced a screen asserting two contradictory things and
// recommending a third that cannot work:
//
//   Everything's ready. … Payments are connected.
//   Something went wrong going live — try again.
//
// THE SUCCESSFUL LAUNCH IS ASSERTED TOO, and it is not a formality: a version
// that reported a refusal for every attempt would satisfy every assertion
// about refusals and never open a shop.
//
// ONBOARDING_V2_ENABLED must be "true" or /onboarding/launch redirects to
// /dashboard. It is set in .env and inherited by the harness's server.

const PASSWORD = "harness-password-1";

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

async function signIn(page: Page, baseUrl: string, email: string) {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  // The submit is a client-side next-auth call, so a click before hydration is
  // silently lost. Same handling as verify-office-browser's own sign-in.
  for (let i = 0; i < 5; i++) {
    await page.click('button[type="submit"]').catch(() => {});
    try {
      await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 8_000 });
      break;
    } catch { /* not hydrated yet — ask again */ }
  }
  await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 30_000 });
}

async function main() {
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const stamp = Date.now();
    const email = `lr-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Owner", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Copper Works", slug: `lr-${stamp}`, currency: "USD", published: false },
    });
    const integration = await prisma.storeIntegration.create({
      data: { storeId: store.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: "acct_lr" },
    });

    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
    await signIn(page, server.baseUrl, email);

    const openLaunch = async () => {
      await page.goto(`${server.baseUrl}/onboarding/launch`, { waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForTimeout(2500);
      return (await page.locator("body").innerText()).replace(/\s+/g, " ");
    };

    // ==================================================================
    console.log("\n1. A connected store reaches the go-live beat\n");
    // ==================================================================
    {
      const body = await openLaunch();
      assert("the screen says everything is ready", /Everything.s ready/.test(body), body.slice(0, 200));
      assert("  and offers Go live", body.includes("Go live"));
    }

    // ==================================================================
    console.log("\n2. The connection goes away before the button is pressed\n");
    // ==================================================================
    //
    // A revoked token, or the owner disconnecting it in another tab. The beat
    // was rendered from the earlier read, so the screen is still claiming
    // payments are connected when the refusal arrives — which is exactly why
    // the refusal has to say what it is.
    await prisma.storeIntegration.update({
      where: { id: integration.id },
      data: { status: "DISCONNECTED" },
    });
    {
      await page.click('button:has-text("Go live")');
      await page.waitForTimeout(4000);
      const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");

      // THE ASSERTION THIS SUITE EXISTS FOR.
      assert("the owner is told the actual reason",
        /Connect Stripe or PayPal before publishing/.test(body), body.slice(0, 300));
      assert("  with the friendly framing kept",
        body.includes("We couldn't take your store live"), body.slice(0, 300));
      // "TRY AGAIN" IS THE ONE INSTRUCTION THAT IS ALWAYS WRONG HERE: the
      // refusal is structural, so every retry fails identically.
      assert("  and is not told to try again",
        !/try again/i.test(body), body.slice(0, 300));

      // THE SAME SENTENCE THE OTHER ROUTE SHOWS. /website renders the failed
      // log row's message; this asserts the two paths now say one thing.
      const log = await prisma.executionLog.findFirst({
        where: { storeId: store.id, status: "FAILED" },
        orderBy: { createdAt: "desc" },
        select: { message: true },
      });
      assert("  the same message /website renders from the log row",
        !!log?.message && body.includes(log.message), log?.message ?? "(no failed log row)");

      // AND NOTHING WAS PUBLISHED. A screen that reported a refusal while the
      // store went live would be worse than the sentence it replaced.
      const after = await prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { published: true } });
      assert("  and the store is still not published", after.published === false);
    }

    // ==================================================================
    console.log("\n3. CONTROL: reconnected, the shop actually opens\n");
    // ==================================================================
    {
      await prisma.storeIntegration.update({
        where: { id: integration.id },
        data: { status: "CONNECTED" },
      });
      await openLaunch();
      await page.click('button:has-text("Go live")');
      // WAIT FOR AN OUTCOME, not for a duration. "Going live." is the in-flight
      // beat, and a fixed sleep that expires during it reports a hang that is
      // really a slow first compile of the action route.
      await page
        .waitForFunction(
          () => {
            const text = document.body.innerText;
            return /is open/.test(text) || /couldn't take your store live/i.test(text);
          },
          undefined,
          { timeout: 60_000 },
        )
        .catch(() => {});
      const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");

      assert("the store opens", /Copper Works is open/.test(body), body.slice(0, 300));
      assert("  and the owner gets the link", body.includes(`/store/${store.slug}`), body.slice(0, 300));
      assert("  with no error left on screen",
        !/We couldn't take your store live/.test(body), body.slice(0, 300));

      const after = await prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { published: true } });
      assert("  and the store really is published", after.published === true);
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
