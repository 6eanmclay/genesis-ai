import bcrypt from "bcryptjs";
import { chromium, type Browser, type Page } from "playwright";

// EXACTLY ONE STORE PER DRAFT, HOWEVER THE CONFIRMATION FAILS:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-confirm-idempotency-browser.ts" -OutFile out.txt
//
// ============ THE CONTRACT (2026-09-14) ================================
//
//   exactly one Store is produced for one draft/launch
//   its generations are promoted
//   the draft is consumed
//   activeStoreId points at that Store
//   retrying the same launch can never create a second Store
//
// ============ HOW THE FAILURES ARE INJECTED ===========================
//
// Postgres triggers on the real tables, with the function driven through the
// real "Confirm & Create Store" button and the real Launch screen. Not mocks:
// `auth` is a non-configurable getter so the function cannot be driven
// in-process, and a mocked client would prove things about the mock. Each
// trigger raises on the actual statement confirmStoreDraftCore issues, inside
// the server, and what is asserted afterwards is real persisted state.
//
// The four boundaries, which before the transaction were four different
// half-finished stores:
//
//   F0  before store.create
//   F1  after store.create, before the generations are promoted
//   F2  after promotion, before the draft is deleted
//   F3  after the draft is deleted, before activeStoreId is set
//
// Measured before the fix: F1 left a store with stranded generations, F2 left
// a store with the draft still on file, F3 left the draft gone and
// activeStoreId NULL — and on the Launch screen, which retries without
// reloading, three presses made three stores.

const PASSWORD = "harness-password-1";
const STAMP = Date.now();

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
    browser = await chromium.launch();
    const email = `cid-${STAMP}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Owner", password: await bcrypt.hash(PASSWORD, 10) },
    });

    const page: Page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    await page.goto(`${server.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PASSWORD);
    for (let i = 0; i < 5; i++) {
      await page.click('button[type="submit"]').catch(() => {});
      try {
        await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 8_000 });
        break;
      } catch { /* not hydrated yet */ }
    }
    await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 30_000 });

    const snapshot = async () => {
      const stores = await prisma.store.findMany({
        where: { userId: user.id },
        select: { id: true, slug: true, createdFromDraftId: true },
      });
      const draft = await prisma.storeDraft.findUnique({ where: { userId: user.id }, select: { id: true } });
      const u = await prisma.user.findUnique({ where: { id: user.id }, select: { activeStoreId: true } });
      const promoted = stores.length
        ? await prisma.storeGeneration.count({ where: { storeId: { in: stores.map((s) => s.id) } } })
        : 0;
      const stranded = draft ? await prisma.storeGeneration.count({ where: { storeDraftId: draft.id } }) : 0;
      return {
        stores: stores.length,
        storeId: stores[0]?.id ?? null,
        draftIds: stores.map((s) => s.createdFromDraftId),
        draft: !!draft,
        active: u?.activeStoreId ?? null,
        promoted,
        stranded,
      };
    };
    const line = (s: Awaited<ReturnType<typeof snapshot>>) =>
      `stores=${s.stores} draft=${s.draft ? "present" : "gone"} promoted=${s.promoted} stranded=${s.stranded} active=${s.active ? "set" : "NULL"}`;

    const inject = async (name: string, ddl: string) => {
      await prisma.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION ${name}_fn() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'INJECTED_${name}'; END; $$ LANGUAGE plpgsql;`,
      );
      await prisma.$executeRawUnsafe(ddl);
    };
    const drop = async (name: string, table: string) => {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "${table}";`).catch(() => {});
    };

    const seedDraft = async (tag: string) => {
      const draft = await prisma.storeDraft.create({
        data: {
          userId: user.id,
          name: `Copper ${tag}`,
          description: "Hand-wound copper things.",
          status: "ready",
          version: 1,
          inputVision: "copper rings",
          productsDraft: [],
          blueprint: {},
        },
      });
      await prisma.storeGeneration.create({
        data: { storeDraftId: draft.id, version: 1, generatedOutput: { n: tag }, milestone: "original" },
      });
      return draft;
    };
    const reset = async (tag: string) => {
      await prisma.store.deleteMany({ where: { userId: user.id } });
      await prisma.storeDraft.deleteMany({ where: { userId: user.id } });
      await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: null } });
      return seedDraft(tag);
    };

    const pressConfirm = async () => {
      await page.goto(`${server.baseUrl}/dashboard`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.waitForTimeout(1800);
      const button = page.locator('button:has-text("Confirm & Create Store")');
      if ((await button.count()) === 0) return false;
      await button.first().click();
      await page.waitForTimeout(9000);
      return true;
    };

    const BOUNDARIES: { tag: string; label: string; name: string; table: string; ddl: string }[] = [
      {
        tag: "f0", label: "F0 before store.create", name: "inj_store", table: "Store",
        ddl: `CREATE TRIGGER inj_store BEFORE INSERT ON "Store" FOR EACH ROW EXECUTE FUNCTION inj_store_fn();`,
      },
      {
        tag: "f1", label: "F1 after store.create, before promotion", name: "inj_gen", table: "StoreGeneration",
        ddl: `CREATE TRIGGER inj_gen BEFORE UPDATE ON "StoreGeneration" FOR EACH ROW EXECUTE FUNCTION inj_gen_fn();`,
      },
      {
        tag: "f2", label: "F2 after promotion, before draft delete", name: "inj_draft", table: "StoreDraft",
        ddl: `CREATE TRIGGER inj_draft BEFORE DELETE ON "StoreDraft" FOR EACH ROW EXECUTE FUNCTION inj_draft_fn();`,
      },
      {
        tag: "f3", label: "F3 after draft delete, before activeStoreId", name: "inj_active", table: "User",
        ddl: `CREATE TRIGGER inj_active BEFORE UPDATE ON "User" FOR EACH ROW
              WHEN (NEW."activeStoreId" IS DISTINCT FROM OLD."activeStoreId")
              EXECUTE FUNCTION inj_active_fn();`,
      },
    ];

    // ==================================================================
    console.log("\n1. Every boundary: all of it, or none of it\n");
    // ==================================================================
    for (const b of BOUNDARIES) {
      const draft = await reset(b.tag);
      await inject(b.name, b.ddl);
      await pressConfirm();
      const after = await snapshot();
      console.log(`    ${b.label.padEnd(42)} ${line(after)}`);

      // THE WHOLE POINT OF THE TRANSACTION. Before it, F1/F2/F3 each left a
      // different half-made business behind.
      assert(`${b.tag}: no store survives the failure`, after.stores === 0, line(after));
      assert(`  ${b.tag}: the draft is still the owner's to retry`, after.draft, line(after));
      assert(`  ${b.tag}: and nothing points at a business that was not made`,
        after.active === null, line(after));

      // AND THE RETRY, with the injection gone, completes the whole contract.
      await drop(b.name, b.table);
      await pressConfirm();
      const retried = await snapshot();
      assert(`  ${b.tag}: retrying makes exactly one store`, retried.stores === 1, line(retried));
      assert(`  ${b.tag}: which records the draft it came from`,
        retried.draftIds[0] === draft.id, `${retried.draftIds[0]} vs ${draft.id}`);
      assert(`  ${b.tag}: the draft is consumed`, !retried.draft, line(retried));
      assert(`  ${b.tag}: its generation is promoted, none stranded`,
        retried.promoted === 1 && retried.stranded === 0, line(retried));
      assert(`  ${b.tag}: and the account is pointed at it`,
        retried.active === retried.storeId, line(retried));
    }

    // ==================================================================
    console.log("\n2. A store already made from this draft is resumed, not repeated\n");
    // ==================================================================
    //
    // REACHED THROUGH A REAL DOOR, not by calling the function directly.
    //
    // /dashboard cannot get here: it renders its Confirm button only under
    // `if (!store)`, so an account with a store never sees it. The Launch
    // screen can, and the state it needs is exactly the one the old failure
    // produced — more than one store and activeStoreId NULL, so
    // resolveUserStore refuses to guess, the page reads "no store yet", and
    // offers the commitment beat over a draft that ALREADY made a store.
    //
    // It also tests the correction directly: the account legitimately owns a
    // SECOND, unrelated business here. A guard keyed on "does this user have a
    // store" would refuse a real creation; this one is keyed on the draft.
    {
      const draft = await reset("resume");
      await prisma.storeDraft.update({
        where: { id: draft.id },
        data: {
          onboardingState: {
            step: "ready_to_publish",
            selectedCandidate: {
              provider: "PRINTFUL",
              externalProductId: "71",
              name: "Copper Ring",
              description: "A hand-wound copper ring.",
              imageUrl: "https://blob.test/ring.png",
              variant: { externalVariantId: "4012", name: "Ash / 2XL" },
            },
            pricing: { retailPriceInCents: 3500, profitInCents: 2300, marginPct: 0.66 },
          },
        },
      });
      const orphan = await prisma.store.create({
        data: {
          userId: user.id,
          name: "Copper resume",
          slug: `cid-resume-${STAMP}`,
          currency: "USD",
          createdFromDraftId: draft.id,
        },
      });
      // An unrelated business the account genuinely owns.
      await prisma.store.create({
        data: { userId: user.id, name: "Another Business", slug: `cid-other-${STAMP}`, currency: "USD" },
      });

      const before = await snapshot();
      assert("the half-finished state is set up",
        before.stores === 2 && before.draft && before.active === null, line(before));

      await page.goto(`${server.baseUrl}/onboarding/launch`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.waitForTimeout(2500);
      const commit = page.locator('button:has-text("Let’s launch it")');
      assert("  the launch screen still offers to build it", (await commit.count()) > 0);
      await commit.first().click().catch(() => {});
      await page.waitForTimeout(13_000);

      const after = await snapshot();
      console.log(`    after confirming again:                    ${line(after)}`);
      // THE ASSERTION THIS SECTION EXISTS FOR. Without the key this press
      // made a third store.
      assert("confirming again does NOT make another store", after.stores === 2, line(after));
      const still = await prisma.store.findUnique({ where: { createdFromDraftId: draft.id } });
      assert("  the draft's own store is still the one it made", still?.id === orphan.id);
      assert("  the draft is now consumed", !after.draft, line(after));
      assert("  the stranded generation was promoted onto it",
        after.promoted === 1 && after.stranded === 0, line(after));
      assert("  and the account points at the store this draft made",
        after.active === orphan.id, `${after.active} vs ${orphan.id}`);
    }
    // ==================================================================
    console.log("\n3. The Launch screen's retry — where the duplicate was\n");
    // ==================================================================
    //
    // This beat retries WITHOUT reloading, so nothing re-derives between
    // presses. Measured before the fix: three presses, three stores.
    {
      const draft = await reset("launch");
      await prisma.storeDraft.update({
        where: { id: draft.id },
        data: {
          onboardingState: {
            step: "ready_to_publish",
            selectedCandidate: {
              provider: "PRINTFUL",
              externalProductId: "71",
              name: "Copper Ring",
              description: "A hand-wound copper ring.",
              imageUrl: "https://blob.test/ring.png",
              variant: { externalVariantId: "4012", name: "Ash / 2XL" },
            },
            pricing: { retailPriceInCents: 3500, profitInCents: 2300, marginPct: 0.66 },
          },
        },
      });

      await inject(
        "inj_draft2",
        `CREATE TRIGGER inj_draft2 BEFORE DELETE ON "StoreDraft" FOR EACH ROW EXECUTE FUNCTION inj_draft2_fn();`,
      );

      await page.goto(`${server.baseUrl}/onboarding/launch`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.waitForTimeout(2500);
      const launchButton = page.locator('button:has-text("Let’s launch it")');
      assert("the launch screen offers the commitment beat", (await launchButton.count()) > 0);

      for (let press = 1; press <= 3; press++) {
        await launchButton.first().click().catch(() => {});
        await page.waitForTimeout(11_000);
        const s = await snapshot();
        console.log(`    after press ${press}:                             ${line(s)}`);
        assert(`press ${press} makes no store at all`, s.stores === 0, line(s));
      }

      await drop("inj_draft2", "StoreDraft");
      await launchButton.first().click().catch(() => {});
      await page.waitForTimeout(13_000);
      const done = await snapshot();
      console.log(`    after the press that works:                ${line(done)}`);
      assert("the press that works makes exactly one store", done.stores === 1, line(done));
      assert("  the draft is consumed", !done.draft, line(done));
      assert("  and the account points at it", done.active === done.storeId, line(done));
    }

    console.log(`\n${failures} failed, ${passes} passed`);
    if (failures > 0) {
      console.log("\nFAILED:");
      for (const l of failed) console.log(`  ${l}`);
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
