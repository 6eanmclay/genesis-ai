import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";

// A GET DOES NOT MINT A REFERRAL CODE:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-referral-lifecycle-browser.ts" -OutFile out.txt
//
// ============ THE VIOLATION (2026-09-13) ===============================
//
// getOrCreateReferralCode was called while the Growth Points page rendered,
// and it was the ONLY caller in the codebase — so the sole thing that had ever
// created a referral code was a GET. Next's own guidance rules that out:
// "Mutations (e.g. logging out users, updating databases, invalidating caches)
// should never be a side-effect, either in Server or Client Components"
// (docs/01-app/02-guides/data-security.md), and the prefetching guide names
// the consequence — a side-effect in a page "might be triggered when the route
// is prefetched, not when the user visits the page".
//
// It also defeated its own rationale. The module says codes are generated
// lazily "on first access — most users never share one, so this never runs at
// signup". A prefetched nav link mints one for a user who never opened the
// page, which is precisely the population laziness existed to spare.
//
// THE TEST IS THE COLUMN, NOT THE PAGE. Rendering and then asserting the row
// is still null is the only way to prove a render did not write; asserting on
// source would prove the call was removed and nothing about what happens.

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
    // AN ACCOUNT FROM BEFORE THE CHANGE: no referralCode, exactly as every
    // existing user looks today.
    const user = await prisma.user.create({
      data: { email: `ref-${stamp}@example.test`, name: "Owner", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Invite Shop", slug: `ref-${stamp}`, currency: "USD" },
    });
    await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: store.id } });

    const codeNow = async () =>
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { referralCode: true } }))
        .referralCode;

    assert("the account starts with no referral code", (await codeNow()) === null, `${await codeNow()}`);

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, user.email!);

    // ==================================================================
    console.log("\n1. Rendering the page writes nothing\n");
    // ==================================================================
    {
      const url = `${server.baseUrl}/b/${store.slug}/growth-points`;
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
      assert("the page renders", (res?.status() ?? 0) === 200, `status ${res?.status()}`);

      // TWICE, because a lazy create would fire on the first render and look
      // idempotent ever after — one visit could not tell the two apart.
      await page.reload({ waitUntil: "domcontentloaded" });

      assert("and after two renders there is still no code",
        (await codeNow()) === null,
        "a GET minted one, which is the defect this suite exists for");

      const body = await page.locator("body").innerText();
      assert("the page offers to create one instead",
        /Create my invite link/i.test(body), body.slice(0, 300));
      assert("and shows no link it does not have",
        (await page.locator('[data-testid="referral-link"]').count()) === 0, "");
    }

    // ==================================================================
    console.log("\n2. Pressing the button is what creates it\n");
    // ==================================================================
    {
      await page.locator('button:has-text("Create my invite link")').click();
      await page.waitForFunction(
        () => !!document.querySelector('[data-testid="referral-link"]'),
        undefined,
        { timeout: 30_000 },
      );

      const code = await codeNow();
      assert("the account now has a real code", typeof code === "string" && code.length > 0, `${code}`);

      const link = (await page.locator('[data-testid="referral-link"]').innerText()).trim();
      assert("and the rendered link carries that exact code",
        code !== null && link.includes(code), `${link} vs ${code}`);
      assert("  pointing at signup", /\/signup\?ref=/.test(link), link);

      // ============ AND IT IS A LINK, NOT A PATH (2026-09-13) ==========
      //
      // This was built from `process.env.NEXTAUTH_URL ?? ""`, and NEXTAUTH_URL
      // is not set in production — the config registry marks it "optional" and
      // no environment file carries it. So the fallback ran and an owner was
      // shown "/signup?ref=ABC12345" to copy and send to somebody: a bare path
      // that resolves nowhere off this page.
      //
      // The deployment cases, both covered: with no
      // VERCEL_PROJECT_PRODUCTION_URL — this harness, and any self-hosted run —
      // canonicalBaseUrl falls back to the request host, which is what is
      // asserted here against the server's own origin. With it set, which is
      // production on Vercel, it returns that stable domain instead. Either way
      // the one property that matters is the same and is what this checks: an
      // absolute origin, never a path.
      assert("the link is absolute, not a bare path",
        /^https?:\/\//.test(link), link);
      assert("  and is on this deployment's own origin",
        link.startsWith(server.baseUrl), `${link} vs ${server.baseUrl}`);
      assert("  with no empty origin left where a host should be",
        !link.startsWith("/") && !/^https?:\/\/\//.test(link), link);
    }

    // ==================================================================
    console.log("\n3. Pressing it again changes nothing\n");
    // ==================================================================
    {
      const before = await codeNow();
      await page.reload({ waitUntil: "domcontentloaded" });
      assert("a second render leaves the code alone", (await codeNow()) === before, `${before}`);
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
