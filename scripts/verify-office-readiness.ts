import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";
import { waitForAppReady, waitForOfficeIntelligence } from "@/scripts/lib/appReadiness";

// THE READINESS CONTRACT ITSELF, NOT THE OFFICE'S CONTENT:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-office-readiness.ts" -OutFile out.txt
//
// verify-office-browser proves the Office shows the right records. It proves
// the contract only INCIDENTALLY - by passing - and a signal that is only ever
// exercised on the happy path is a signal nobody has checked.
//
// The failure this guards against is specific and was live for a day: a state
// that never settles makes every waiter hang forever, and a state that settles
// too eagerly makes every waiter read the loading view. Both look like the
// suite's fault rather than the signal's.
//
// Sean's rule, which is what these five sections encode: "readiness should mean
// the load has resolved, not 'the content happens to contain this string'. It
// should be stable whether the result is populated or legitimately empty."

const PASSWORD = "a-real-passphrase-for-this-test";
const OFFICE_DOOR = '[data-testid="j4-office"]';

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function intelligenceState(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      document.querySelector("[data-office-intelligence]")?.getAttribute("data-office-intelligence") ??
      "(no element)",
  );
}

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
      // The submit is a client call; it does nothing until React has attached.
    }
  }
  await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 30_000 });
}

async function openOfficeAndShow(page: Page, view: string): Promise<void> {
  await page.click(OFFICE_DOOR);
  await page.waitForFunction(
    () => document.querySelector("[data-j4-presentation='office']")?.getAttribute("aria-hidden") === "false",
    undefined,
    { timeout: 15_000 },
  );
  await page.click(`button:text-is("${view}")`);
}

async function main(): Promise<void> {
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const stamp = Date.now();
    const email = `office-ready-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Owner", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const make = (slug: string, name: string) =>
      prisma.store.create({
        data: { userId: user.id, name, slug, currency: "GBP", published: true, description: "A real business." },
      });
    // Two businesses, deliberately: one with a record in the intelligence tier
    // and one with none, so "populated" and "legitimately empty" are both real
    // states of the real product rather than two readings of one fixture.
    const full = await make(`ready-full-${stamp}`, "Copper & Coil");
    const empty = await make(`ready-empty-${stamp}`, "Empty Bench");
    await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: full.id } });
    await prisma.task.create({
      data: {
        storeId: full.id,
        dedupeKey: "office.readiness.task",
        source: "manual",
        title: "ZZREADYTASK",
        summary: "A real open task.",
        context: {},
        priority: "WARNING",
        status: "OPEN",
      },
    });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, email);

    // ------------------------------------------------------------------
    console.log("\n1. A product page does not ask for the intelligence tier");
    // ------------------------------------------------------------------
    // The layer renders on EVERY dashboard page. Sean: "don't accidentally make
    // every dashboard page load the entire J4 intelligence progressively if
    // that intelligence isn't needed there." This is that rule, asserted.
    await page.goto(`${server.baseUrl}/b/${full.slug}/products`, { waitUntil: "domcontentloaded" });
    await waitForAppReady(page);
    assert("a product page reports not-needed", (await intelligenceState(page)) === "not-needed",
      await intelligenceState(page));

    // ------------------------------------------------------------------
    console.log("\n2. Opening the Office on Conversation still does not ask for it");
    // ------------------------------------------------------------------
    await openOfficeAndShow(page, "Conversation");
    await page.waitForTimeout(1200);
    assert("the conversation view reports not-needed", (await intelligenceState(page)) === "not-needed",
      await intelligenceState(page));
    // And a waiter must RETURN on it rather than hanging - the bug that made
    // this state unanswerable when it was called "idle".
    const settledOnConversation = await waitForOfficeIntelligence(page, { timeoutMs: 8_000 })
      .then(() => true)
      .catch(() => false);
    assert("and a waiter settles rather than hanging there", settledOnConversation,
      "not-needed must satisfy 'is this still pending?'");

    // ------------------------------------------------------------------
    console.log("\n3. Opening an intelligence view DOES ask for it, and reaches ready");
    // ------------------------------------------------------------------
    await page.click(`button:text-is("Tasks")`);
    await waitForOfficeIntelligence(page);
    assert("a populated store reaches ready", (await intelligenceState(page)) === "ready",
      await intelligenceState(page));
    const populated = await page.evaluate(
      () => document.querySelector("[data-j4-presentation]")?.textContent ?? "",
    );
    assert("and the records are actually there once it says so",
      populated.includes("ZZREADYTASK"), populated.replace(/\s+/g, " ").slice(0, 160));

    // ------------------------------------------------------------------
    console.log("\n4. A legitimately empty result reaches ready too");
    // ------------------------------------------------------------------
    // The whole point of the contract: readiness is about the LOAD, not about
    // whether any rows came back. A signal that only settles when content
    // appears is a test waiting for a fixture.
    await page.goto(`${server.baseUrl}/b/${empty.slug}`, { waitUntil: "domcontentloaded" });
    await waitForAppReady(page);
    // IDEAS, NOT TASKS. A brand-new business is not task-free: Genesis raises
    // real state issues for it ("Add your first product"), so the Tasks view of
    // a fresh store has three rows in it. Asserting emptiness there would have
    // been asserting something about the fixture rather than about the load.
    // Ideas is opportunity observations, and a store nothing has looked at yet
    // genuinely has none.
    await openOfficeAndShow(page, "Ideas");
    await waitForOfficeIntelligence(page);
    assert("an empty collection reaches ready", (await intelligenceState(page)) === "ready",
      await intelligenceState(page));
    const emptyText = await page.evaluate(
      () => document.querySelector("[data-j4-presentation]")?.textContent ?? "",
    );
    assert("and it is showing its empty state, not a spinner",
      /Nothing in Ideas right now/i.test(emptyText), emptyText.replace(/\s+/g, " ").slice(0, 200));

    // ------------------------------------------------------------------
    console.log("\n5. A FAILED load reaches ready as well");
    // ------------------------------------------------------------------
    // Injected at the network, not in the product: every server action from
    // this page is aborted, so loadOfficeIntelligence rejects for real. If the
    // settle path were inside .then() rather than .finally(), the state would
    // stick on "loading" forever and every waiter in the suite would hang on a
    // failure instead of reporting one.
    const failing = await context.newPage();
    await failing.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"]) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await failing.goto(`${server.baseUrl}/b/${full.slug}`, { waitUntil: "domcontentloaded" });
    await waitForAppReady(failing);
    await openOfficeAndShow(failing, "Tasks");
    const reachedReady = await waitForOfficeIntelligence(failing, { timeoutMs: 20_000 })
      .then(() => true)
      .catch(() => false);
    assert("a rejected load still reaches ready", reachedReady, await intelligenceState(failing));
    assert("and it is not stuck reporting loading", (await intelligenceState(failing)) !== "loading",
      await intelligenceState(failing));
    await failing.close();

    await context.close();
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
