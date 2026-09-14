import bcrypt from "bcryptjs";
import { chromium, type Browser, type Page } from "playwright";

// A SCHEDULED TASK THAT IS OFF BY DECISION IS NOT AN ALARM:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-scheduler-off-browser.ts" -OutFile out.txt
//
// ============ THE CONTRACT (2026-09-14) ================================
//
// lib/scheduler/health.ts states it: "A task that is off is not a finding.
// Storage reconciliation is deliberately dark and saying so every hour would
// train somebody to ignore this." The operations page repeats it three lines
// from the code that broke it: "A task that is off is not a problem. Saying so
// plainly keeps the red text meaning something."
//
// schedulerNeedsAttention honours it — `t.enabled && t.lastOutcome ===
// "failed"` — so the banner was always right. The row's colour read the three
// alarm conditions and not `enabled`, so a task that failed and was THEN
// switched off rendered:
//
//   banner   Nothing needs attention.                    (green)
//   row      storage.reconcile … failed · 1200ms
//            off by decision                             (rose-700)
//
// The cell's own text and its colour disagreeing, under a banner contradicting
// both.
//
// THE ENABLED CASE IS ASSERTED TOO, and it is the whole reason this suite is
// not satisfied by deleting the colour: a failing task that is switched ON must
// still be red, and must still reach the banner.
//
// PLATFORM_ADMIN_EMAILS is set before the server is spawned, because the
// allowlist is read from the environment at request time and this suite starts
// its own server (run-http-suites gives every suite one — isolation by
// default). STORAGE_RECONCILE is deliberately unset, which is what makes
// storage.reconcile disabled.

const EMAIL = `schedoff-${Date.now()}@example.test`;
const PASSWORD = "harness-password-1";
process.env.PLATFORM_ADMIN_EMAILS = EMAIL;
delete process.env.STORAGE_RECONCILE;

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

async function main() {
  const { startTestServer } = await import("@/scripts/lib/testServer");
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    await prisma.user.create({
      data: { email: EMAIL, name: "Operator", password: await bcrypt.hash(PASSWORD, 10) },
    });

    const failedRun = (taskKey: string) =>
      prisma.scheduledTaskRun.create({
        data: {
          taskKey,
          outcome: "failed",
          startedAt: new Date(Date.now() - 60 * 60 * 1000),
          finishedAt: new Date(Date.now() - 59 * 60 * 1000),
          durationMs: 1200,
          detail: "blob listing timed out",
        },
      });

    // storage.reconcile is disabled (STORAGE_RECONCILE unset); queue.drain is
    // `enabled: always`. Both failed their last run.
    await failedRun("storage.reconcile");

    browser = await chromium.launch();
    const page: Page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();

    await page.goto(`${server.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    for (let i = 0; i < 5; i++) {
      await page.click('button[type="submit"]').catch(() => {});
      try {
        await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 8_000 });
        break;
      } catch { /* not hydrated yet */ }
    }
    await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 30_000 });

    const openOps = async () => {
      const res = await page.goto(`${server.baseUrl}/admin/operations`, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      });
      await page.waitForTimeout(2500);
      return res?.status() ?? 0;
    };

    /** The State cell of one task's row: its words and whether it is alarmed. */
    const stateOf = async (taskKey: string) => {
      const cell = page.locator(`tr:has-text("${taskKey}")`).first().locator("td").last();
      const cls = (await cell.getAttribute("class")) ?? "";
      return { text: (await cell.innerText()).trim(), red: cls.includes("rose-700"), cls };
    };
    const banner = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");

    // ==================================================================
    console.log("\n1. The operator surface is reachable at all\n");
    // ==================================================================
    {
      const status = await openOps();
      assert("an allowlisted operator reaches /admin/operations", status === 200, `status ${status}`);
      // LOWERCASED BEFORE MATCHING. The section headings carry Tailwind's
      // `uppercase`, so innerText returns "SCHEDULED TASKS" and a match on the
      // written capitalisation can never succeed.
      assert("  and the scheduled tasks table is on it",
        (await banner()).toLowerCase().includes("scheduled tasks"));
    }

    // ==================================================================
    console.log("\n2. Off by decision, after a failure — not an alarm\n");
    // ==================================================================
    {
      const state = await stateOf("storage.reconcile");
      assert("the row says it is off by decision", state.text === "off by decision", state.text);
      // THE ASSERTION THIS SUITE EXISTS FOR.
      assert("  and is not coloured as a problem", !state.red, state.cls);
      const body = await banner();
      assert("  while the banner says nothing needs attention",
        body.includes("Nothing needs attention"), body.slice(0, 200));
      // THE ROW'S OWN HISTORY IS STILL THERE. A fix that hid the failure would
      // be worse than colouring it: the operator still needs to know it failed.
      const rowText = (await page.locator('tr:has-text("storage.reconcile")').first().innerText()).replace(/\s+/g, " ");
      assert("  and the failed run is still visible on the row",
        /failed/.test(rowText), rowText);
    }

    // ==================================================================
    console.log("\n3. CONTROL: switched ON and failing is still an alarm\n");
    // ==================================================================
    //
    // Without this, deleting the colour entirely would satisfy section 2.
    {
      await failedRun("queue.drain");
      await openOps();
      const state = await stateOf("queue.drain");
      assert("an enabled task that failed says so", state.text === "failed last run", state.text);
      assert("  and IS coloured as a problem", state.red, state.cls);
      const body = await banner();
      assert("  and the banner now asks for a person",
        body.includes("Needs a person"), body.slice(0, 300));
      assert("  naming the task that failed",
        /queue\.drain/.test(body), body.slice(0, 400));
      // AND THE DISABLED ONE IS STILL NOT NAMED. The banner was always right
      // about this; asserting it keeps the two halves from drifting apart.
      const reasons = body.slice(body.indexOf("Needs a person"), body.indexOf("Needs a person") + 400);
      assert("  without dragging the switched-off one into it",
        !/storage\.reconcile/.test(reasons), reasons.slice(0, 300));
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
