import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { readFileSync } from "node:fs";

// WHEN A LOOKUP IS MISTAKEN FOR AN AUTHORIZATION DECISION:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts fetch-then-authorize-db
//
// ============ THE PATTERN THAT IS SAFE, AND THE ONE THAT IS NOT ========
//
// Most of this codebase fetches a record by bare id and then authorizes
// against whatever business it turns out to belong to. That is deliberate,
// documented in ARCHITECTURE.md, and correct: the authorization lands on the
// store that owns the record being acted upon, which is the resource in
// question. lib/tenantIsolation.ts leaves findUnique and findFirst unguarded
// for exactly that reason.
//
// It is correct because something authorizes AFTERWARDS. Where nothing does,
// the same shape is a bare read of anybody's row — and the sweep on
// 2026-08-31 found one place where nothing did: a public page.
//
// ============ AND THE PROTECTION THAT HAD QUIETLY STOPPED COVERING =====
//
// The isolation guard keeps a map of tenant-scoped models. The schema had
// moved seven models ahead of it. Nothing was leaking — but nothing would ever
// have reported it either, which is the part this file fixes: the map is now
// checked against schema.prisma on every run.

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Store-scoped models, read from the schema rather than listed. */
function storeScopedModels(): string[] {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const out: string[] = [];
  for (const match of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    if (/^\s+storeId\s/m.test(match[2])) out.push(match[1][0].toLowerCase() + match[1].slice(1));
  }
  return out;
}

/** The models the isolation guard actually knows about. */
function guardedModels(): string[] {
  const source = readFileSync("lib/tenantIsolation.ts", "utf8");
  const start = source.indexOf("const TENANT_SCOPED_MODELS");
  const block = source.slice(start, source.indexOf("\n};", start));
  return [...block.matchAll(/^ {2}(\w+):\s*\[/gm)].map((m) => m[1]);
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  console.log("\n--- the isolation guard covers every store-scoped model in the schema ---\n");
  {
    // ============ THE CROSS-CHECK THAT DID NOT EXIST ===============
    //
    // The map mirrors the schema and nothing compared them, so it fell seven
    // models behind without a single failing test. Derived here, so the next
    // store-scoped model added is covered or the suite says which one is not.
    const scoped = storeScopedModels();
    const guarded = new Set(guardedModels());
    assert("the schema sweep found the store-scoped models", scoped.length > 35, String(scoped.length));

    const uncovered = scoped.filter((m) => !guarded.has(m));
    eq("every store-scoped model is in the guard's map", uncovered, []);

    // And in the other direction: an entry naming a model that no longer has a
    // storeId is a rule protecting nothing, which reads as coverage.
    const stale = guardedModels().filter((m) => !scoped.includes(m));
    eq("and the map names nothing that is no longer store-scoped", stale, []);
  }

  console.log("\n--- the guard actually refuses an unscoped write on a newly covered model ---\n");
  {
    // Executed, not asserted from source: the map entry only means something if
    // the guard genuinely throws on one of the seven models just added.
    const user = await prisma.user.create({ data: { email: `fta-${stamp}-1@example.test` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "FTA", slug: `fta-${stamp}-1`, tagline: "t", description: "d" },
    });
    await prismaSystem.storageObject.create({
      data: { storeId: store.id, pathname: `p/${stamp}`, prefix: "products", source: "upload", lifecycle: "PERMANENT", declaredBytes: 10 },
    });

    const unscoped = await prisma.storageObject
      .updateMany({ where: { lifecycle: "PERMANENT" }, data: { touchedAt: new Date() } })
      .then(() => "allowed")
      .catch(() => "refused");
    eq("an updateMany with no business in its filter is refused", unscoped, "refused");

    const scopedWrite = await prisma.storageObject
      .updateMany({ where: { storeId: store.id, lifecycle: "PERMANENT" }, data: { touchedAt: new Date() } })
      .then(() => "allowed")
      .catch((e) => `refused: ${e}`);
    eq("and the same write scoped to a business is allowed", scopedWrite, "allowed");

    const unscopedRead = await prisma.temporaryAsset
      .findMany({ where: { promotedAt: null } })
      .then(() => "allowed")
      .catch(() => "refused");
    eq("a collection read on temporaryAsset is refused unscoped", unscopedRead, "refused");

    // ============ AND THE REAL CALL SITE STILL RUNS ================
    //
    // Adding storageObject to the map turned every unscoped updateMany in the
    // ledger into a runtime failure, and one of them was unscoped: the batch
    // touch in recordActual filtered by batchId alone. Exercised here rather
    // than asserted from source, because the first version of this suite
    // proved nothing about it — the sabotage run reverted that filter and the
    // suite stayed green, which meant the fix was untested rather than safe.
    const { recordActual } = await import("@/lib/storage/ledger");
    const batch = `batch-${stamp}`;
    const reserved = await prismaSystem.storageObject.create({
      data: {
        storeId: store.id, pathname: `p/${stamp}-batch`, prefix: "products",
        source: "upload", lifecycle: "PERMANENT", declaredBytes: 10, batchId: batch,
      },
    });
    const recorded = await recordActual({
      id: reserved.id, storeId: store.id, url: "https://example.test/a.png", sizeInBytes: 10,
    }).then((r) => (r.ok ? "recorded" : "refused")).catch((e) => `threw: ${e}`);
    eq("recording an upload in a batch still succeeds under the guard", recorded, "recorded");
    eq("and the upload was actually written",
      (await prismaSystem.storageObject.findUnique({ where: { id: reserved.id } }))?.sizeInBytes, 10);

    // ============ AND THEY ARE CLEARED AGAIN =======================
    //
    // StorageObject is read by a PLATFORM-WIDE report, so rows planted here
    // are rows verify-ledger-report-db counts. It passed alone and failed in
    // the full lane until this existed — the suites share one database, and a
    // cross-tenant report is exactly where that stops being harmless.
    await prismaSystem.storageObject.deleteMany({ where: { storeId: store.id } });
  }

  console.log("\n--- a public receipt only shows an order belonging to the shop in the URL ---\n");
  {
    // ============ THE ONE REAL GAP THE SWEEP FOUND =================
    //
    // /store/[slug]/success takes order_id from the query string with no
    // authentication of any kind. Looked up by id alone it returned any order
    // on the platform and printed the product and the amount.
    //
    // Proven at the database layer against the exact filter the page now uses.
    // The page itself is a React Server Component with no HTTP lane, so this
    // asserts the query, and the source assertion below holds the page to it.
    const a = await prisma.user.create({ data: { email: `fta-${stamp}-a@example.test` } });
    const b = await prisma.user.create({ data: { email: `fta-${stamp}-b@example.test` } });
    const shopA = await prisma.store.create({
      data: { userId: a.id, name: "A", slug: `fta-a-${stamp}`, tagline: "t", description: "d" },
    });
    const shopB = await prisma.store.create({
      data: { userId: b.id, name: "B", slug: `fta-b-${stamp}`, tagline: "t", description: "d" },
    });
    const orderInB = await prismaSystem.order.create({
      data: {
        storeId: shopB.id, productName: "A Very Private Purchase", amountInCents: 129900,
        buyerEmail: `someone-${stamp}@example.test`, paymentProvider: "PAYPAL",
        externalOrderId: `ext-fta-${stamp}`,
      },
    });

    // The old query: id alone. Kept as the demonstration that the fix is not
    // decorative — this is what the page used to run.
    const unscoped = await prismaSystem.order.findUnique({ where: { id: orderInB.id } });
    eq("by id alone, another shop's order is returned", unscoped?.productName, "A Very Private Purchase");

    // The query the page runs now, with the slug's store applied.
    const throughA = await prismaSystem.order.findFirst({
      where: { id: orderInB.id, storeId: shopA.id },
    });
    eq("scoped to the shop in the URL, it is not", throughA, null);

    const throughB = await prismaSystem.order.findFirst({
      where: { id: orderInB.id, storeId: shopB.id },
    });
    eq("and the real buyer's own receipt still resolves", throughB?.amountInCents, 129900);
  }

  console.log("\n--- the page holds to that filter ---\n");
  {
    // Source-asserted deliberately, and separated from the execution evidence
    // above: this is a statement about what one file may never go back to,
    // which no runtime test of a server component can make here.
    const page = readFileSync("app/store/[slug]/success/page.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    assert("the receipt page scopes its order lookup to the store",
      /order\.findFirst\(\{\s*where:\s*\{\s*id:\s*orderId,\s*storeId:\s*store\.id\s*\}/.test(page),
      page.slice(page.indexOf("order."), page.indexOf("order.") + 120));
    assert("and no longer looks an order up by id alone",
      !/order\.findUnique\(\{\s*where:\s*\{\s*id:\s*orderId\s*\}\s*\}\)/.test(page));
    // The matcher must be able to fail.
    assert("that check would catch the old query if it came back",
      /order\.findUnique\(\{\s*where:\s*\{\s*id:\s*orderId\s*\}\s*\}\)/.test(
        "const order = await prisma.order.findUnique({ where: { id: orderId } });"));
  }

  console.log("\n--- the confirmed-safe pattern is left alone ---\n");
  {
    // ============ NOT EVERY UNSCOPED LOOKUP IS A DEFECT ============
    //
    // Sean: "Do not rewrite code that already reaches the correct
    // authorization decision." The dashboard's product and order actions fetch
    // by bare id ON PURPOSE — the lookup exists to learn which business owns
    // the record so execute() can re-verify the caller against THAT business.
    // This asserts they were not "fixed", because a sweep that tidied them
    // would have removed a documented, correct pattern.
    const actions = readFileSync("app/dashboard/actions.ts", "utf8");
    assert("editProduct still authorizes against the fetched product's store",
      /storeId:\s*product\.storeId/.test(actions));
    assert("and the order actions still do the same",
      /storeId:\s*order\.storeId/.test(actions));

    // What makes that safe is execute(): every executable declares a
    // permission, so none can take the unauthorized branch.
    const executables = readFileSync("lib/execution/executable.ts", "utf8");
    assert("an executable must declare a permission or an explicit null",
      /requiredPermission:\s*Permission\s*\|\s*null/.test(executables));
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
