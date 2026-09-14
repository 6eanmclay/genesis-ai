import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { CONNECTOR_CATALOG } from "@/lib/integrations/catalog";
import { connectExecutable, syncExecutable } from "@/lib/execution/adapters/integrationExecutable";

// WHICH SOURCE A CONNECTOR CARD SPEAKS FROM:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-connection-status-source-browser.ts" -OutFile out.txt
//
// ============ THE CONTRACT (2026-09-13) ================================
//
//   connectionHealthOf  says what IS. It reads the integration row —
//                       status, lastError, syncFailureCount, lastSyncedAt —
//                       and is the only present-tense statement on the card.
//   ExecutionLog        says what HAPPENED. A message and a time, and no
//                       word that could be read as the current state.
//
// ExecutionStatusCard used to render `{name} — {STATUS_LABEL[log.status]}`
// from the newest CONNECT/VERIFY/SYNC log, and STATUS_LABEL mapped SUCCESS to
// "Connected". So a historical success described the present, directly beneath
// the health line that contradicted it:
//
//   Google Calendar — Needs reconnection
//   Google Calendar — Connected
//
// That is the QuickBooks case connectionHealth.ts was written about, with the
// judgment fixed upstream and the word still printed underneath.
//
// THE CONNECTOR IS MADE AVAILABLE, NOT CONNECTED. Catalog entries gate on
// configured(); without the env every card reads "Coming later" and there is
// nothing to assert. Connection state itself comes from real rows.
process.env.GOOGLE_CALENDAR_CLIENT_ID ??= "harness-client-id";
process.env.GOOGLE_CALENDAR_CLIENT_SECRET ??= "harness-client-secret";

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
  for (let i = 0; i < 6; i++) {
    await page.click('button[type="submit"]').catch(() => {});
    try {
      await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
        timeout: 12_000,
      });
      break;
    } catch {
      // pre-hydration click, lost
    }
  }
  await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
    timeout: 30_000,
  });
}

async function main() {
  const entry = CONNECTOR_CATALOG.find((e) => e.provider === "GOOGLE_CALENDAR");
  if (!entry?.connector) throw new Error("GOOGLE_CALENDAR is not in the catalog");
  const connectAction = connectExecutable(entry.connector).action;
  const syncAction = syncExecutable(entry.connector).action;

  const { startTestServer } = await import("@/scripts/lib/testServer");
  console.log("Starting a real Next server on a real Postgres. First compile takes a while.\n");
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const stamp = Date.now();
    const user = await prisma.user.create({
      data: { email: `connsrc-${stamp}@example.test`, name: "Owner", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Conn Shop", slug: `connsrc-${stamp}`, currency: "USD" },
    });
    await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: store.id } });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, user.email!);

    /** Every "<connector> — <something>" line the page renders, plus the log line. */
    const read = async () => {
      const res = await page.goto(`${server.baseUrl}/b/${store.slug}/connections`, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      assert("connections renders", (res?.status() ?? 0) === 200, `status ${res?.status()}`);
      const text = await page.locator("body").innerText();
      return {
        text,
        // EVERY occurrence. The name appears in the needs-attention panel as
        // well as on the card, and reading only the first attributes one
        // element's words to another — which it did, on the first attempt.
        titled: [...text.matchAll(new RegExp(`^${entry.name}\\s*[—-]\\s*(.+)$`, "gm"))].map((m) =>
          m[0].trim(),
        ),
        activity: (await page.locator('[data-testid="connector-last-activity"]').count())
          ? (await page.locator('[data-testid="connector-last-activity"]').first().innerText()).trim()
          : "(none)",
      };
    };

    const integration = await prisma.storeIntegration.create({
      data: {
        storeId: store.id, provider: "GOOGLE_CALENDAR", status: "CONNECTED",
        externalAccountId: `gc_${stamp}`, connectedByUserId: user.id,
        connectedAt: new Date(), lastVerifiedAt: new Date(), syncFailureCount: 0,
      },
    });
    const log = (action: string, status: string, message: string, verified: boolean) =>
      prisma.executionLog.create({
        data: {
          executionId: randomUUID(), storeId: store.id, action, status,
          verified, message, actorType: "USER", actorId: user.id,
        },
      });
    await log(connectAction, "SUCCESS", `${entry.name} connected`, true);

    // ==================================================================
    console.log("\n1. Connected, and the provider has returned nothing\n");
    // ==================================================================
    {
      const seen = await read();
      assert("the health line keeps its own distinction",
        seen.text.includes("Connected — no data received"), JSON.stringify(seen.titled));
      // THE FLATTENING. A bare "Connected" beside it erases exactly what that
      // state exists to say.
      assert("and nothing beneath it flattens that back to 'Connected'",
        !seen.titled.some((t) => /—\s*Connected$/.test(t)), JSON.stringify(seen.titled));
      assert("the last activity is still reported as history",
        /Last activity:/.test(seen.activity) && seen.activity.includes("connected"), seen.activity);
    }

    // ==================================================================
    console.log("\n2. Authenticated, but the scheduler has failed 14 times\n");
    // ==================================================================
    {
      await prisma.storeIntegration.update({
        where: { id: integration.id },
        data: { syncFailureCount: 14, lastSyncedAt: new Date("2026-08-01"), status: "CONNECTED" },
      });
      await log(syncAction, "SUCCESS", `Synced 3 record(s) from ${entry.name}`, true);

      const seen = await read();
      assert("the card says it needs reconnecting",
        seen.titled.some((t) => /Needs reconnection/.test(t)) ||
          seen.text.includes("Needs reconnection"),
        JSON.stringify(seen.titled));
      // THE ASSERTION THIS SUITE EXISTS FOR. The newest log is a SUCCESS and
      // must not be allowed to say "Connected" over the top of that.
      assert("and nothing on the page also calls it Connected",
        !seen.titled.some((t) => /—\s*Connected$/.test(t)), JSON.stringify(seen.titled));
      assert("while the successful sync is still visible as history",
        seen.activity.includes("Synced 3 record(s)"), seen.activity);
    }

    // ==================================================================
    console.log("\n3. Verification failed, with the provider's own words\n");
    // ==================================================================
    {
      await prisma.storeIntegration.update({
        where: { id: integration.id },
        data: {
          syncFailureCount: 0, status: "FAILED",
          lastError: "The refresh token was revoked by Google.",
        },
      });

      const seen = await read();
      assert("the failure is stated", seen.text.includes("Failed"), JSON.stringify(seen.titled));
      assert("  in the provider's own words, verbatim",
        seen.text.includes("The refresh token was revoked by Google."), "");
      assert("and still nothing calls it Connected",
        !seen.titled.some((t) => /—\s*Connected$/.test(t)), JSON.stringify(seen.titled));
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
