import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";

// WHO CAN REACH THIS BUSINESS, AND AS WHAT — IN A REAL BROWSER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-access-roster-browser.ts" -OutFile out.txt
//
// ============ THE DEFECT (2026-09-13) ==================================
//
// The roster's role badge was gated on `isOwner` — the account that owns the
// business, derived from Store.userId — and not on `role`. The add form on
// this very screen offers "Owner" as a choice, so a member granted it rendered
// with no role at all: same row as an employee, while holding every owner
// capability including removing other people, changing billing, and deciding
// what J4 may do without asking.
//
// `role` was on MemberRow the whole time — fetched, typed, and used only to
// choose between the button labels "Make owner" and "Make employee". An owner
// reviewing access had to infer a person's power from the action offered
// against them.
//
// THREE PEOPLE, BECAUSE THE MODEL HAS THREE KINDS AND THE SCREEN SHOWED TWO.
// The interesting one is the third: a StoreMember whose role is OWNER but who
// is not the account that owns the business.
//
// AND THE NAMES ARE DELIBERATELY NEUTRAL. An earlier reading of this screen
// used fixtures called "Ada Employee" and "Bo Coowner", which made the render
// look like it named roles when the words were coming from the names. Nobody
// here is called after their role.

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
      // A submit clicked before hydration is simply lost.
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
    const holder = await prisma.user.create({
      data: { email: `roster-a-${stamp}@example.test`, name: "Wren Ashby", password: hash },
    });
    const staff = await prisma.user.create({
      data: { email: `roster-b-${stamp}@example.test`, name: "Tam Okonjo", password: hash },
    });
    const second = await prisma.user.create({
      data: { email: `roster-c-${stamp}@example.test`, name: "Juno Fields", password: hash },
    });

    const alone = await prisma.store.create({
      data: { userId: holder.id, name: "Alone Shop", slug: `roster-alone-${stamp}`, currency: "USD" },
    });
    const shared = await prisma.store.create({
      data: { userId: holder.id, name: "Shared Shop", slug: `roster-shared-${stamp}`, currency: "USD" },
    });
    await prisma.storeMember.create({ data: { storeId: shared.id, userId: staff.id, role: "EMPLOYEE" } });
    await prisma.storeMember.create({ data: { storeId: shared.id, userId: second.id, role: "OWNER" } });
    await prisma.user.update({ where: { id: holder.id }, data: { activeStoreId: alone.id } });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, holder.email!);

    /** Each roster row as { email, role } straight out of the rendered DOM. */
    const roster = async (slug: string) => {
      const res = await page.goto(`${server.baseUrl}/b/${slug}/access`, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      assert(`/b/${slug}/access renders`, (res?.status() ?? 0) === 200, `status ${res?.status()}`);
      return page.evaluate(() =>
        [...document.querySelectorAll("li")]
          .filter((li) => li.querySelector('[data-testid="member-role"]'))
          .map((li) => ({
            text: (li as HTMLElement).innerText,
            role: li.querySelector('[data-testid="member-role"]')?.textContent?.trim() ?? "",
          })),
      );
    };

    // ==================================================================
    console.log("\n1. A business with only its owner\n");
    // ==================================================================
    {
      const rows = await roster(alone.slug);
      assert("one person on the roster", rows.length === 1, `${rows.length} rows`);
      assert("and they are named as the Owner", rows[0]?.role === "Owner", rows[0]?.role ?? "(no role)");
    }

    // ==================================================================
    console.log("\n2. Three people, and the second owner is visible as one\n");
    // ==================================================================
    {
      const rows = await roster(shared.slug);
      assert("three people on the roster", rows.length === 3, `${rows.length} rows`);

      const roleFor = (email: string) =>
        rows.find((r) => r.text.includes(email))?.role ?? "(missing)";

      assert("the account that owns the business reads Owner",
        roleFor(holder.email!) === "Owner", roleFor(holder.email!));
      assert("the employee reads Employee",
        roleFor(staff.email!) === "Employee", roleFor(staff.email!));
      // THE ASSERTION THIS SUITE EXISTS FOR. This row rendered no role at all
      // before 2026-09-13 while holding every owner capability.
      assert("and the member granted the Owner role reads Owner, not nothing",
        roleFor(second.email!) === "Owner", roleFor(second.email!));

      // EVERY ROW, NOT JUST THE ONES NAMED ABOVE — a badge that renders for
      // two of three people is the defect in a smaller shape.
      assert("no row is left without a role",
        rows.every((r) => r.role === "Owner" || r.role === "Employee"),
        JSON.stringify(rows.map((r) => r.role)));

      // AND IT MUST NOT SIMPLY SAY "Owner" EVERYWHERE, which would pass every
      // assertion above except this one.
      assert("the roles are not all the same word",
        new Set(rows.map((r) => r.role)).size === 2,
        JSON.stringify(rows.map((r) => r.role)));
    }

    // ==================================================================
    console.log("\n3. The roster and the capabilities table agree\n");
    // ==================================================================
    {
      // The table below the roster explains what Owner and Employee may each
      // do. It is only a reference if it uses the same words the rows do —
      // both now read them from ROLE_LABEL.
      const body = await page.locator("body").innerText();
      assert("the capabilities table names Owner", /\bOwner\b/.test(body), "");
      assert("and names Employee", /\bEmployee\b/.test(body), "");
      assert("and still explains a real capability",
        body.includes("Give and remove other people's access"),
        "the table is generated from the permission rows hasPermission enforces");
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
