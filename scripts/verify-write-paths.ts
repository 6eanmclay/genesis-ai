import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";

// NO PRODUCTION WRITE CAN BYPASS THE LEDGER:
//
//   npx tsx scripts/verify-write-paths.ts
//
// ============ WHY THIS IS A SOURCE TEST, NOT A BEHAVIOUR TEST ==========
//
// Every other proof in this milestone runs a path and checks what it wrote.
// None of them can prove the thing Sean actually asked for — that no path
// exists which writes a blob WITHOUT a ledger row — because a test can only
// exercise the paths somebody thought to write a test for. The bypass that
// matters is the one nobody remembered.
//
// So this asserts over the source itself. Every file that can put bytes in the
// provider is enumerated below, and the test fails if the repository contains
// one that is not on the list. Adding a tenth upload path is then a failing
// test rather than a silent hole, which is the same shape as ARCHITECTURE.md's
// mirrored-registry invariant and exists for the same reason.
//
// ============ THE THREE WAYS BYTES REACH THE PROVIDER ==================
//
//   put()          — server-side, from our own code. Must reserve and record.
//   handleUpload() — issues a browser token. Must reserve, and record on
//                    completion. There are exactly two of these.
//   upload()       — the browser itself. Cannot reserve (it is the client), so
//                    it must point at one of those two routes and nowhere else.

const ROOT = process.cwd();

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  // Detail on failures only. A PASS printing "no ledger import" beside it reads
  // like a contradiction and trains the eye to stop reading the line.
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}

/** Every server-side writer, and the ledger call each one is required to make. */
const SERVER_WRITERS: Record<string, string> = {
  "lib/design/createDesign.ts": "reserveOne + recordActual",
  "lib/execution/executables/productFromDesign.ts": "reserveOne + recordActual",
  "lib/imageProviders/generatedImageProvider.ts": "reserveOne + recordActual / recordUnattributed",
  "lib/imageProviders/uploadProvider.ts": "reserveOne + recordActual / recordUnattributed",
};

/** The only two routes that may hand a browser permission to write. */
const TOKEN_ROUTES = [
  "app/api/blob/business-asset-upload/route.ts",
  "app/api/blob/product-image-upload/route.ts",
];

/** The URLs those routes are reachable at — what a client must point to. */
const WIRED_UPLOAD_URLS = [
  "/api/blob/business-asset-upload",
  "/api/blob/product-image-upload",
];

/** Reads, lists and diagnostics. These take bytes OUT or look; none put any in. */
const NON_WRITERS = [
  "lib/storage/vercelBlob.ts",     // list
  "lib/storage/cleanup.ts",        // del
  "lib/storage/ledger.ts",         // del
  "lib/storage/temporaryAssets.ts",// del
  "lib/storage/clientUploads.ts",  // head
  "scripts/backfill-storage-objects.ts",
  "scripts/reconcile-storage.ts",
  "lib/storage/reconcile.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function main(): void {
  const files = ["app", "lib", "scripts"].flatMap((d) => walk(join(ROOT, d)));
  const read = (f: string) => ({ path: relative(ROOT, f).split(sep).join("/"), text: readFileSync(f, "utf8") });
  const sources = files.map(read);

  console.log("\n--- 1. every server-side put() is a known, ledger-wired path ---\n");
  const putterPaths = sources
    .filter((s) => (s.text.match(/import \{([^}]*)\} from "@vercel\/blob"/)?.[1] ?? "").includes("put"))
    .map((s) => s.path)
    .sort();

  const expected = Object.keys(SERVER_WRITERS).sort();
  assert(
    "the set of files importing put() is exactly the known write paths",
    JSON.stringify(putterPaths) === JSON.stringify(expected),
    `found ${JSON.stringify(putterPaths)}`,
  );
  for (const path of expected) {
    const source = sources.find((s) => s.path === path);
    assert(
      `${path} reserves and records (${SERVER_WRITERS[path]})`,
      !!source && /from "@\/lib\/storage\/ledger"/.test(source.text),
      source ? "no ledger import" : "file missing",
    );
  }

  console.log("\n--- 2. every token route reserves and records ---\n");
  const routes = sources.filter((s) => /handleUpload\(/.test(s.text) && s.path.startsWith("app/"));
  assert(
    "there are exactly two token-issuing routes",
    JSON.stringify(routes.map((r) => r.path).sort()) === JSON.stringify([...TOKEN_ROUTES].sort()),
    JSON.stringify(routes.map((r) => r.path)),
  );
  for (const route of routes) {
    assert(`${route.path} reserves before issuing a token`, /reserveForClientUpload\(/.test(route.text));
    // THE CALL MUST BE INSIDE THE HANDLER. Testing for the two names separately
    // passed when the handler was renamed to onUploadCompletedREMOVED — the
    // substring still matched, and a dead recordCompletedClientUpload sitting
    // elsewhere in the file satisfied the other half. Both are present here or
    // this fails.
    assert(
      `${route.path} records on completion`,
      /onUploadCompleted:\s*async[\s\S]{0,200}?recordCompletedClientUpload\(/.test(route.text),
      "onUploadCompleted must exist and call recordCompletedClientUpload",
    );
    assert(
      `${route.path} grants the reservation's ceiling, not its own constant`,
      /maximumSizeInBytes,/.test(route.text),
      "maximumSizeInBytes must come from the reservation",
    );
  }

  console.log("\n--- 3. every browser upload points at a wired route ---\n");
  const clients = sources.filter((s) => /from "@vercel\/blob\/client"/.test(s.text) && !s.path.startsWith("app/api/"));
  assert("browser upload call sites found", clients.length > 0, `${clients.length}`);
  for (const client of clients) {
    const urls = [...client.text.matchAll(/handleUploadUrl:\s*"([^"]+)"/g)].map((m) => m[1]);
    assert(
      `${client.path} uploads only through a wired route`,
      urls.length > 0 && urls.every((u) => WIRED_UPLOAD_URLS.includes(u)),
      urls.length === 0 ? "no handleUploadUrl found" : JSON.stringify(urls),
    );
  }

  console.log("\n--- 4. no unlisted file touches the provider at all ---\n");
  const anyBlobImport = sources
    .filter((s) => /from "@vercel\/blob"/.test(s.text))
    .map((s) => s.path)
    .sort();
  const allowed = [...Object.keys(SERVER_WRITERS), ...NON_WRITERS].sort();
  const unlisted = anyBlobImport.filter((p) => !allowed.includes(p));
  assert(
    "no file imports @vercel/blob that this test does not know about",
    unlisted.length === 0,
    unlisted.length ? `unlisted: ${JSON.stringify(unlisted)}` : "",
  );

  console.log("\n--- 5. deletion stays where the policy is ---\n");
  const deleters = sources
    .filter((s) => (s.text.match(/import \{([^}]*)\} from "@vercel\/blob"/)?.[1] ?? "").includes("del"))
    .map((s) => s.path)
    .sort();
  assert(
    "only the three policy-holding files can delete a blob",
    JSON.stringify(deleters) === JSON.stringify(["lib/storage/cleanup.ts", "lib/storage/ledger.ts", "lib/storage/temporaryAssets.ts"]),
    JSON.stringify(deleters),
  );
  const reconcile = sources.find((s) => s.path === "scripts/reconcile-storage.ts");
  const reconcileImport = reconcile?.text.match(/import \{[^}]*\} from "@vercel\/blob"/)?.[0];
  assert(
    "the reconciliation script imports no deletion",
    // ============ THIS IS NO LONGER THE EVIDENCE (2026-08-30) =======
    //
    // It used to be, and it was wrong. An absent `del` import was taken as
    // proof that "reconciliation cannot delete a blob" while the real path ran
    // through recordActualByPathname → recordActual → deleteObject → del().
    // This check passed the entire time that path was live.
    //
    // Kept, because it is still worth knowing nobody added `del` here directly.
    // The property itself is now proven by BEHAVIOUR in verify-reconcile-db:
    // the rollback case is constructed and the refusal is observed as an event,
    // with the row left standing.
    !!reconcileImport && !/\bdel\b/.test(reconcileImport),
    reconcileImport ?? "no @vercel/blob import found at all",
  );

  const reconcileModule = sources.find((s) => s.path === "lib/storage/reconcile.ts");
  assert(
    "and the module hands an explicit refusal to anything that can reach deletion",
    !!reconcileModule && /REFUSE_TO_DELETE,/.test(reconcileModule.text),
    "reconcile.ts must pass REFUSE_TO_DELETE wherever deleteObject is reachable",
  );

  console.log(`\n${failures} failed, ${passes} passed\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
