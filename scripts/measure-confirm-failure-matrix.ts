import bcrypt from "bcryptjs";
import { chromium, type Browser, type Page } from "playwright";

// THE CURRENT FAILURE BEHAVIOUR OF confirmStoreDraftCore.
//
// INVESTIGATION ONLY. This changes no production code and asserts nothing about
// what SHOULD happen — it records what does.
//
// ============ HOW THE FAILURES ARE INJECTED ===========================
//
// Not by mocking the function, and not by mocking Prisma: `auth` is exported as
// a non-configurable getter, so the function cannot be driven in-process at
// all, and a mocked client would prove something about the mock.
//
// So the injector is a POSTGRES TRIGGER on the real table, in the real test
// database, and the function is driven through the real "Confirm & Create
// Store" button on /dashboard. Every write boundary below is the actual
// statement confirmStoreDraftCore issues; when the trigger raises, the failure
// happens exactly where a real one would, inside the server process, and what
// is left behind is real persisted state.
//
// The three uncaught write boundaries after store.create, in order:
//
//   storeGeneration.updateMany   promote the draft's generations
//   storeDraft.delete            the commit point
//   user.update(activeStoreId)   adoptNewBusiness, AFTER the draft is gone
//
// Everything between store.create and the first of those is already wrapped in
// try/catch by the function itself and cannot fail the operation — recordOwner
// Facts, stateFact, the fulfillment registration and recordGeneratedAsset all
// log and continue, deliberately: "the storefront is already live at this
// point, and losing a record of what the owner said must not undo a launch."

const PASSWORD = "harness-password-1";
const STAMP = Date.now();

interface Snapshot {
  stores: number;
  storeSlugs: string[];
  draftExists: boolean;
  generationsOnDraft: number;
  generationsOnStore: number;
  activeStoreId: string | null;
}

async function main() {
  const { startTestServer } = await import("@/scripts/lib/testServer");
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  const rows: string[] = [];

  try {
    browser = await chromium.launch();

    const signIn = async (page: Page, email: string) => {
      await page.goto(`${server.baseUrl}/login`, { waitUntil: "domcontentloaded" });
      await page.fill('input[type="email"]', email);
      await page.fill('input[type="password"]', PASSWORD);
      for (let i = 0; i < 5; i++) {
        await page.click('button[type="submit"]').catch(() => {});
        try {
          await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 8_000 });
          break;
        } catch { /* hydration */ }
      }
      await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 30_000 });
    };

    const snapshot = async (userId: string): Promise<Snapshot> => {
      const stores = await prisma.store.findMany({ where: { userId }, select: { id: true, slug: true } });
      const draft = await prisma.storeDraft.findUnique({ where: { userId }, select: { id: true } });
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { activeStoreId: true } });
      const onDraft = draft
        ? await prisma.storeGeneration.count({ where: { storeDraftId: draft.id } })
        : 0;
      const onStore = stores.length
        ? await prisma.storeGeneration.count({ where: { storeId: { in: stores.map((s) => s.id) } } })
        : 0;
      return {
        stores: stores.length,
        storeSlugs: stores.map((s) => s.slug),
        draftExists: !!draft,
        generationsOnDraft: onDraft,
        generationsOnStore: onStore,
        activeStoreId: user?.activeStoreId ?? null,
      };
    };

    const show = (label: string, s: Snapshot) =>
      console.log(
        `    ${label.padEnd(18)} stores=${s.stores}${s.stores > 1 ? " <<< DUPLICATE" : ""} draft=${s.draftExists ? "present" : "gone"} ` +
          `gen(draft)=${s.generationsOnDraft} gen(store)=${s.generationsOnStore} active=${s.activeStoreId ? "set" : "NULL"}`,
      );

    /** A trigger that raises when the named statement runs. Dropped by name later. */
    const injectTrigger = async (name: string, sql: string) => {
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION ${name}_fn() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'INJECTED_FAILURE_${name}'; END;
        $$ LANGUAGE plpgsql;`);
      await prisma.$executeRawUnsafe(sql);
    };
    const dropTrigger = async (name: string, table: string) => {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "${table}";`).catch(() => {});
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}_fn();`).catch(() => {});
    };

    /** The draft state the Confirm button expects, for the one signed-in user. */
    const seedDraft = async (userId: string, tag: string) => {
      const draft = await prisma.storeDraft.create({
        data: {
          userId,
          name: `Copper ${tag}`,
          description: "Hand-wound copper things.",
          tagline: "Wound by hand.",
          status: "ready",
          version: 1,
          inputVision: "copper rings",
          // NULL rather than a hand-made object: the page does
          // `(draft.theme as Theme | null) ?? DEFAULT_THEME`, and a partial
          // theme reaches themeCssVars as a malformed one.
          theme: undefined,
          productsDraft: [],
          blueprint: {},
        },
      });
      await prisma.storeGeneration.create({
        data: { storeDraftId: draft.id, version: 1, generatedOutput: { name: `Copper ${tag}` }, milestone: "original" },
      });
      return draft;
    };

    /** Back to "one ready draft, no store" without signing in again. */
    const resetUser = async (userId: string, tag: string) => {
      await prisma.store.deleteMany({ where: { userId } });
      await prisma.storeDraft.deleteMany({ where: { userId } });
      await prisma.user.update({ where: { id: userId }, data: { activeStoreId: null } });
      return seedDraft(userId, tag);
    };

    const clickConfirm = async (page: Page): Promise<string> => {
      await page.goto(`${server.baseUrl}/dashboard`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.waitForTimeout(2000);
      const button = page.locator('button:has-text("Confirm & Create Store")');
      if ((await button.count()) === 0) {
        const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
        return `NO CONFIRM BUTTON at ${page.url().replace(server.baseUrl, "")} :: ${body.slice(0, 160)}`;
      }
      await button.first().click();
      await page.waitForTimeout(9000);
      const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      return `${page.url().replace(server.baseUrl, "")} :: ${body.slice(0, 90)}`;
    };

    const experiments: { tag: string; label: string; trigger: null | { name: string; table: string; sql: string } }[] = [
      { tag: "f0", label: "F0 CONTROL — no injection", trigger: null },
      {
        tag: "f1",
        label: "F1 — storeGeneration.updateMany raises",
        trigger: {
          name: "inj_gen", table: "StoreGeneration",
          sql: `CREATE TRIGGER inj_gen BEFORE UPDATE ON "StoreGeneration" FOR EACH ROW EXECUTE FUNCTION inj_gen_fn();`,
        },
      },
      {
        tag: "f2",
        label: "F2 — storeDraft.delete raises (the commit point)",
        trigger: {
          name: "inj_draft", table: "StoreDraft",
          sql: `CREATE TRIGGER inj_draft BEFORE DELETE ON "StoreDraft" FOR EACH ROW EXECUTE FUNCTION inj_draft_fn();`,
        },
      },
      {
        tag: "f3",
        label: "F3 — adoptNewBusiness raises (AFTER the draft is deleted)",
        trigger: {
          name: "inj_active", table: "User",
          sql: `CREATE TRIGGER inj_active BEFORE UPDATE ON "User" FOR EACH ROW
                WHEN (NEW."activeStoreId" IS DISTINCT FROM OLD."activeStoreId")
                EXECUTE FUNCTION inj_active_fn();`,
        },
      },
    ];

    // ONE ACCOUNT, ONE SIGN-IN. There is a per-IP sign-in throttle beside the
    // per-account one, so a harness that authenticates once per experiment ends
    // up measuring the throttle. State is reset between experiments instead.
    const email = `cfm-${STAMP}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Owner", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    await signIn(page, email);

    for (const exp of experiments) {
      console.log(`\n================ ${exp.label} ================\n`);
      await resetUser(user.id, exp.tag);

      show("before", await snapshot(user.id));

      if (exp.trigger) await injectTrigger(exp.trigger.name, exp.trigger.sql);
      const firstOutcome = await clickConfirm(page);
      console.log(`    owner sees:        ${firstOutcome}`);
      const afterFirst = await snapshot(user.id);
      show("after attempt 1", afterFirst);

      // THE RETRY, with the injected failure REMOVED — the operator/owner
      // pressing again after whatever went wrong has passed.
      if (exp.trigger) await dropTrigger(exp.trigger.name, exp.trigger.table);
      const retryOutcome = await clickConfirm(page);
      console.log(`    retry:             ${retryOutcome}`);
      const afterRetry = await snapshot(user.id);
      show("after retry", afterRetry);

      rows.push(
        `${exp.label.padEnd(58)} | stores ${afterFirst.stores}->${afterRetry.stores} | draft ${afterFirst.draftExists ? "kept" : "gone"} | active ${afterRetry.activeStoreId ? "set" : "NULL"}`,
      );

    }

    // ==================================================================
    console.log(`\n================ E1 — confirmation with a store ALREADY present ================\n`);
    // ==================================================================
    {
      await resetUser(user.id, "e1");
      // A store this account already owns, plus the unfinished draft. This is
      // exactly the state F1 and F2 leave behind, reconstructed directly.
      await prisma.store.create({
        data: { userId: user.id, name: "Already Here", slug: `already-${STAMP}`, currency: "USD" },
      });
      show("before", await snapshot(user.id));
      const outcome = await clickConfirm(page);
      console.log(`    owner sees:        ${outcome}`);
      const after = await snapshot(user.id);
      show("after confirm", after);
      rows.push(
        `E1 — confirm while a store already exists${" ".repeat(18)} | stores 1->${after.stores} | draft ${after.draftExists ? "kept" : "gone"} | active ${after.activeStoreId ? "set" : "NULL"}`,
      );

    }

    console.log("\n\n================ MATRIX ================\n");
    for (const r of rows) console.log("  " + r);
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
