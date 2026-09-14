import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";

// WHAT ACCOUNT SECURITY OFFERS AN ACCOUNT THAT CANNOT TAKE IT:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-account-security-browser.ts" -OutFile out.txt
//
// ============ THE DEFECT (2026-09-13) ==================================
//
// User.password is nullable and a Google-only account has none — the
// credentials provider guards `!user.password`, and confirmPassword already
// answers such an account with `no_password`. Every security change on this
// page is gated behind confirming that password, so for those accounts the
// gate can never open and Genesis two-factor is permanently unreachable.
//
// The page said otherwise three times over: it led with a password form, told
// the owner "Confirm your password above to change this" under the two-factor
// switch, and described the risk as "Anyone with your password can sign in to
// your business" — to someone who has no password for anyone to have.
//
// NOTHING ABOUT WHO MAY DO WHAT CHANGED. No new capability, no Google
// re-authentication, no second confirmation route: those are real features and
// a real product decision. This is the surface stopping asking for something
// that does not exist.
//
// BOTH ACCOUNT KINDS, because a fix that tells the truth to Google accounts by
// breaking the password path would pass every assertion about the first one.

const PASSWORD = "a-real-passphrase-for-this-test";

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
    const hash = await bcrypt.hash(PASSWORD, 10);

    // A PASSWORD ACCOUNT, which must keep every control it has.
    const withPassword = await prisma.user.create({
      data: { email: `sec-pw-${stamp}@example.test`, name: "Wren Ashby", password: hash },
    });
    await prisma.store.create({
      data: { userId: withPassword.id, name: "Pw Shop", slug: `sec-pw-${stamp}`, currency: "USD" },
    });

    browser = await chromium.launch();
    // ONE CONTEXT, ONE SIGN-IN. The second sign-in this suite used to do trips
    // the credentials throttle that auth.ts deliberately applies per account,
    // and a test is not a reason to work around a brute-force guard. It is
    // also the truer shape: the same owner, the same live session, with the
    // account's password state changed underneath them.
    const context = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, withPassword.email!);

    const read = async (page: Page) => {
      const res = await page.goto(`${server.baseUrl}/account/security`, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      assert("account security renders", (res?.status() ?? 0) === 200, `status ${res?.status()}`);
      return {
        body: await page.locator("body").innerText(),
        state: (await page.locator('[data-testid="two-factor-state"]').innerText()).trim(),
        passwordInputs: await page.locator('input[type="password"]').count(),
      };
    };

    // ==================================================================
    console.log("\n1. An account that has a password keeps everything\n");
    // ==================================================================
    {
      const seen = await read(page);

      assert("it is asked to confirm its password",
        /Confirm your password/i.test(seen.body), seen.body.slice(0, 300));
      assert("  with a real password field to do it in",
        seen.passwordInputs === 1, `${seen.passwordInputs} password inputs`);
      assert("two-factor reads Off, not Unavailable",
        seen.state.toLowerCase() === "off", seen.state);
      assert("  and the risk is described in terms of the password it has",
        /Anyone with your password can sign in/i.test(seen.body), "");
      assert("  and it is told how to change it",
        /Confirm your password above to change this/i.test(seen.body), "");
    }

    // ==================================================================
    console.log("\n2. A Google account is not offered what it cannot use\n");
    // ==================================================================
    {
      // THE STATE, REACHED THE ONLY WAY A SUITE CAN. A Google-only account has
      // password null and a live session; it cannot be signed in through the
      // credentials form by definition, and driving Google's real OAuth from a
      // test is not something to fake. So the password is removed from the
      // account already signed in, which leaves the page reading exactly what
      // it reads for a Google account: password null, session live.
      await prisma.user.update({
        where: { id: withPassword.id },
        data: { password: null },
      });
      const seen = await read(page);

      // THE THREE STATEMENTS THAT WERE UNTRUE.
      assert("no password form is offered",
        seen.passwordInputs === 0, `${seen.passwordInputs} password inputs`);
      assert("  it is told plainly why",
        /no Genesis password on this account/i.test(seen.body), seen.body.slice(0, 400));
      assert("the risk sentence does not mention a password it does not have",
        !/Anyone with your password can sign in/i.test(seen.body), "");
      assert("  and it is not told to confirm one",
        !/Confirm your password above to change this/i.test(seen.body), "");

      // AND THE STATE IS NAMED HONESTLY. "Off" implies it could be On.
      assert("two-factor reads Unavailable rather than Off",
        seen.state.toLowerCase() === "unavailable", seen.state);
      assert("  with no control offering to turn it on",
        (await page.locator('button:has-text("Turn on two-factor")').count()) === 0, "");

      // THE REST OF THE PAGE IS UNTOUCHED — this was never about sessions.
      assert("sessions are still shown", /Where you.{0,3}re signed in/i.test(seen.body), "");
      assert("and so is security history", /Recent security activity/i.test(seen.body), "");
      await context.close();
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
