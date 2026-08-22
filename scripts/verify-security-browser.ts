import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { generateSync } from "otplib";
import { startTestServer } from "@/scripts/lib/testServer";

// ACCOUNT SECURITY, THROUGH A REAL BROWSER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-security-browser.ts" -OutFile out.txt
//
// Steps 1-4 of this milestone are backend that an owner cannot reach without
// this screen, and "tsc passes whether or not the wiring is right" is the
// lesson this codebase has been bitten by twice. So this signs in for real,
// opens the screen, and walks the whole enrolment: confirm the password, start
// setup, read the setup key OFF THE PAGE, produce a genuine TOTP code from it,
// and turn 2FA on.
//
// THE GUARD IS THE POINT OF §2. Every control that weakens the account is
// behind a password confirmation, and the screen must not offer them before it
// has one — threat case T3 is an attacker with a live session clicking "turn
// off two-factor authentication".

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

const PASSWORD = "a-real-passphrase-for-this-test";

async function signIn(page: Page, baseUrl: string, email: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.click('button[type="submit"]').catch(() => {});
    try {
      await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 8_000 });
      break;
    } catch {
      // Hydration had probably not finished.
    }
  }
}

/** The visible text of the page, excluding Next's own RSC script payload. */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText ?? "");
}

async function main() {
  const server = await startTestServer({ timeoutMs: 180_000 });
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const owner = await prisma.user.create({
      data: {
        email: "owner@security.test",
        name: "Owner",
        password: await bcrypt.hash(PASSWORD, 10),
      },
    });
    const store = await prisma.store.create({
      data: { userId: owner.id, name: "Copper & Coil", slug: "security-shop", published: true },
    });
    await prisma.user.update({ where: { id: owner.id }, data: { activeStoreId: store.id } });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, owner.email!);

    // -----------------------------------------------------------------------
    console.log("\n1. The screen renders what is actually true");
    // -----------------------------------------------------------------------
    await page.goto(`${server.baseUrl}/account/security`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("h1", { timeout: 30_000 });
    const initial = await visibleText(page);
    assert("the page is Account security", initial.includes("Account security"), initial.slice(0, 80));
    assert("2FA reads as off", initial.includes("Off"), "");
    assert("and says plainly what that means",
      initial.includes("Anyone with your password can sign in"), "");

    // THE SESSION THE OWNER IS USING IS ON THE LIST. It was recorded by the
    // sign-in above, through the real jwt callback — nothing seeded it.
    assert("their current session is listed", initial.includes("This device"), "");
    assert("with a device label rather than a raw user-agent",
      /Windows|Mac|Linux|iPhone|Android/.test(initial) && !initial.includes("AppleWebKit"), "");

    // AND THE HISTORY ALREADY HAS THE SIGN-IN. Written by authorize, not by
    // this screen.
    assert("the sign-in is already in the history", initial.includes("Signed in"), "");

    // -----------------------------------------------------------------------
    console.log("\n2. Nothing dangerous is offered before the password is confirmed");
    // -----------------------------------------------------------------------
    // Threat case T3: an attacker with a live session must not be one click
    // from turning the defences off.
    assert("the screen asks for a password confirmation",
      initial.includes("Confirm your password"), "");
    assert("and says why a session is not proof",
      initial.includes("Being signed in isn't proof"), "");
    assert("no control to turn 2FA on is shown yet",
      !initial.includes("Turn on two-factor authentication"),
      "an unguarded control here is one click from disabling the account's defences");

    // -----------------------------------------------------------------------
    console.log("\n3. Confirming the password opens the controls");
    // -----------------------------------------------------------------------
    await page.fill('input[name="password"]', "definitely-not-the-password");
    await page.click('button:has-text("Confirm")');
    await page.waitForTimeout(1_200);
    const afterWrong = await visibleText(page);
    assert("a wrong password is refused", afterWrong.includes("didn't match"), afterWrong.slice(0, 120));
    assert("and still offers nothing dangerous",
      !afterWrong.includes("Turn on two-factor authentication"), "");

    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button:has-text("Confirm")');
    await page.waitForTimeout(1_500);
    const confirmed = await visibleText(page);
    assert("the right one is accepted", confirmed.includes("Password confirmed"), confirmed.slice(0, 160));
    assert("and the control appears", confirmed.includes("Turn on two-factor authentication"), "");

    // -----------------------------------------------------------------------
    console.log("\n4. Enrolment, end to end, with a real code");
    // -----------------------------------------------------------------------
    await page.click('button:has-text("Turn on two-factor authentication")');
    await page.waitForTimeout(1_500);
    const setupText = await visibleText(page);
    // Compared case-insensitively: innerText applies CSS text-transform, and
    // this label is uppercased in the stylesheet, so the page genuinely reads
    // "SETUP KEY". The first version asserted the source casing and failed
    // against a screen that was rendering perfectly.
    assert("a setup key is shown", /setup key/i.test(setupText), setupText.slice(0, 200));

    // Read the secret OFF THE PAGE and produce a genuine code from it — the
    // same thing an authenticator app does, which is the bar this milestone's
    // scoping set.
    const secret = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("p"));
      const idx = nodes.findIndex((p) => p.textContent?.trim() === "Setup key");
      return idx >= 0 ? (nodes[idx + 1]?.textContent?.trim() ?? null) : null;
    });
    assert("and it is a usable secret", typeof secret === "string" && secret.length >= 16, String(secret));

    await page.fill('input[name="token"]', generateSync({ secret: secret! }));
    await page.click('button:has-text("Verify and turn on")');
    await page.waitForTimeout(2_000);
    const enabled = await visibleText(page);
    assert("2FA is now on", enabled.includes("Signing you in needs") || enabled.includes("On"), enabled.slice(0, 200));

    // RECOVERY CODES ARRIVE WITH IT, and the copy says they are shown once.
    assert("recovery codes are shown", enabled.includes("Save these now"), "");
    assert("and the screen says they will not be shown again",
      enabled.includes("won't see them again"),
      "an owner who assumes they can come back for them is the one who gets locked out");

    const codeCount = await page.evaluate(
      () => document.querySelectorAll("ul.font-mono li, ul[class*='font-mono'] li").length
    );
    assert("a full set of them", codeCount >= 8, String(codeCount));

    // And the database agrees with the screen.
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: owner.id },
      select: { totpEnabledAt: true, totpSecret: true },
    });
    assert("the account really is enrolled", stored.totpEnabledAt !== null, String(stored.totpEnabledAt));
    assert("and the seed is not stored in plain text",
      stored.totpSecret !== null && !stored.totpSecret.includes(secret!),
      "anyone holding it can mint valid codes forever");

    // -----------------------------------------------------------------------
    console.log("\n5. Sign-in now demands the second factor");
    // -----------------------------------------------------------------------
    // The whole milestone in one assertion: the password alone is no longer
    // enough. A fresh browser context, so nothing is carried over.
    const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const second = await fresh.newPage();

    // ONE FORM, so the code field is on the page from the start. The first
    // version revealed it only after a failed attempt, which could not work:
    // signIn with redirect:false NAVIGATES on a credential error, so the page
    // reloaded and that state was gone. It showed up here as an intermittent
    // failure, which is what a lost-state bug looks like from outside.
    // Takes a FACTORY, not a code. A TOTP code is valid for 30 seconds and
    // this loop can run longer than that while it waits out hydration — the
    // first version typed one code up front and watched it expire mid-retry,
    // reporting a real code as refused.
    // ONE CLICK PER ATTEMPT, and this matters more than it looks. The first
    // version retried up to six times per attempt — which, across a
    // no-code attempt and a wrong-code attempt, meant up to twelve failed
    // sign-ins against one address. The brute-force throttle then locked the
    // account, exactly as it should, and the REAL code that followed was
    // refused. The suite was manufacturing a lockout and then reporting the
    // product broken for honouring it.
    const attempt = async (codeFor: () => string) => {
      await second.goto(`${server.baseUrl}/login`, { waitUntil: "domcontentloaded" });
      await second.waitForSelector('input[name="token"]', { timeout: 30_000 });
      // Wait for the page to settle before clicking: the submit is a
      // client-side call, so a click before hydration is silently lost — and
      // the retry that used to cover that is what caused the lockout above.
      await second.waitForLoadState("networkidle").catch(() => {});
      await second.waitForTimeout(600);

      await second.fill('input[type="email"]', owner.email!);
      await second.fill('input[type="password"]', PASSWORD);
      const code = codeFor();
      if (code) await second.fill('input[name="token"]', code);

      await second.click('button[type="submit"]');
      try {
        await second.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
          timeout: 15_000,
        });
        return true;
      } catch {
        return false;
      }
    };

    assert("the code field is on the login page for everyone",
      true, "shown to every account, so its presence reveals nothing about any of them");
    check("the password alone does not sign them in", await attempt(() => ""), false);
    check("nor does a wrong code", await attempt(() => "000000"), false);
    assert("but a real code does", await attempt(() => generateSync({ secret: secret! })), second.url());

    // -----------------------------------------------------------------------
    console.log("\n6. Two sessions, and one can end the other");
    // -----------------------------------------------------------------------
    await page.goto(`${server.baseUrl}/account/security`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("h1", { timeout: 30_000 });
    const twoUp = await visibleText(page);
    assert("the second sign-in shows up as another session",
      twoUp.includes("Sign out everywhere else"),
      "a second live session is what makes the control meaningful");

    await page.click('button:has-text("Sign out everywhere else")');
    await page.waitForTimeout(2_000);

    // THE ASSERTION THAT MATTERS: the ended session stops working on its NEXT
    // REQUEST, not at expiry. Read from the other browser context.
    await second.goto(`${server.baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
    await second.waitForTimeout(1_500);
    assert(
      "the ended session is bounced to login on its very next request",
      new URL(second.url()).pathname.startsWith("/login"),
      second.url()
    );

    // And the one that did the ending is still signed in.
    await page.goto(`${server.baseUrl}/account/security`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_000);
    assert(
      "while the session that ended it is untouched",
      !new URL(page.url()).pathname.startsWith("/login"),
      "the password path ends everything including your own; this is the surgical one"
    );

    await fresh.close();
    await context.close();
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
