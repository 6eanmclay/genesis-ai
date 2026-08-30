import { compareToProvider, type LedgerRow, type ProviderObject } from "@/lib/storage/drift";

// THE LEDGER-VERSUS-PROVIDER COMPARISON, EXHAUSTIVELY:
//
//   npx tsx scripts/verify-storage-drift.ts
//
// ============ WHY THIS IS WORTH ITS OWN SUITE (2026-08-30) =============
//
// The comparison runs against a production ledger that is currently in perfect
// agreement with the provider, so every real run reports nothing — and
// "nothing" is exactly what a comparison that cannot see also reports. The
// reconcile script's --selftest plants three faults to prove it is not blind,
// which is good evidence and only three cases.
//
// The function is pure, so the rest of the cases cost nothing to write: the
// ones production cannot currently produce, and the ones that would be
// expensive to discover for the first time in front of a customer's files.
//
// Every case below is a table of two lists and an expected classification.
// There is no database and no provider.

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

const NOW = new Date("2026-08-30T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function blob(pathname: string, size: number): ProviderObject {
  return { pathname, url: `https://blob.test/${pathname}`, size };
}

function row(over: Partial<LedgerRow> & { pathname: string }): LedgerRow {
  return {
    id: `id-${over.pathname}`,
    storeId: "store-1",
    attribution: "owner",
    lifecycle: "permanent",
    prefix: over.pathname.slice(0, over.pathname.indexOf("/") + 1),
    sizeInBytes: 100,
    declaredBytes: null,
    uploadedAt: NOW,
    touchedAt: NOW,
    ...over,
  };
}

function main(): void {
  console.log("\n--- agreement ---\n");
  {
    const d = compareToProvider(
      [blob("assets/a.png", 100), blob("products/b.png", 250)],
      [row({ pathname: "assets/a.png" }), row({ pathname: "products/b.png", sizeInBytes: 250 })],
      NOW,
    );
    assert("a ledger that matches the provider is in sync", d.inSync);
    eq("and the byte totals agree", [d.provider.bytes, d.ledger.bytes], [350, 350]);
    eq("nothing is classified", [d.orphanBlobs.length, d.missingBlobs.length, d.sizeDisagreements.length, d.landedReservations.length], [0, 0, 0, 0]);
  }

  console.log("\n--- a blob nobody claimed ---\n");
  {
    const d = compareToProvider([blob("assets/a.png", 100), blob("mockups/loose.png", 7)], [row({ pathname: "assets/a.png" })], NOW);
    eq("it is one orphan", d.orphanBlobs.map((o) => o.pathname), ["mockups/loose.png"]);
    eq("carrying its prefix, so a lifecycle can be looked up", d.orphanBlobs[0].prefix, "mockups/");
    assert("and the ledger is not in sync", !d.inSync);
    eq("it is NOT also reported as missing", d.missingBlobs.length, 0);
  }

  console.log("\n--- a row whose blob is gone ---\n");
  {
    const d = compareToProvider([], [row({ pathname: "assets/a.png", sizeInBytes: 100 })], NOW);
    eq("it is one missing blob", d.missingBlobs.map((m) => m.pathname), ["assets/a.png"]);
    eq("its recorded size travels with it", d.missingBlobs[0].sizeInBytes, 100);
    eq("its owner travels with it, so an event can name the store", d.missingBlobs[0].storeId, "store-1");
    eq("age is measured from uploadedAt", d.missingBlobs[0].ageMs, 0);
  }
  {
    // THE GRACE PERIOD IS THE CALLER'S DECISION, but the age it decides on
    // comes from here — so an age measured from the wrong column would silently
    // delete rows for uploads that are minutes old.
    const old = new Date(NOW.getTime() - 3 * HOUR);
    const d = compareToProvider([], [row({ pathname: "assets/a.png", uploadedAt: old, touchedAt: old })], NOW);
    eq("an older row reports a real age", d.missingBlobs[0].ageMs, 3 * HOUR);
  }

  console.log("\n--- a live reservation is not a fault ---\n");
  {
    const d = compareToProvider([], [row({ pathname: "assets/pending.png", uploadedAt: null, declaredBytes: 5000, sizeInBytes: null })], NOW);
    eq("a reservation with no blob is NOT missing", d.missingBlobs.length, 0);
    eq("nor is it a landed reservation", d.landedReservations.length, 0);
    assert("so an in-flight upload leaves the ledger in sync", d.inSync);
    eq("it is counted as a reservation, not as an object", [d.ledger.landed, d.ledger.reservations], [0, 1]);
    eq("and its declared bytes are NOT added to the ledger total", d.ledger.bytes, 0);
  }

  console.log("\n--- a reservation whose upload landed ---\n");
  {
    const d = compareToProvider(
      [blob("assets/pending.png", 4321)],
      [row({ pathname: "assets/pending.png", uploadedAt: null, declaredBytes: 5000, sizeInBytes: null })],
      NOW,
    );
    eq("it is one landed reservation", d.landedReservations.map((l) => l.pathname), ["assets/pending.png"]);
    eq("carrying what was reserved and what actually arrived", [d.landedReservations[0].declaredBytes, d.landedReservations[0].actual], [5000, 4321]);
    // THE BUG THIS CASE EXISTS FOR. Classifying orphans against landed rows
    // only would report this blob as an orphan AND as a landed reservation —
    // one blob presented as two different problems, and a caller that acted on
    // the first would create a duplicate row for it.
    eq("it is NOT also an orphan blob", d.orphanBlobs.length, 0);
    assert("and it is a genuine disagreement", !d.inSync);
  }

  console.log("\n--- sizes ---\n");
  {
    const d = compareToProvider([blob("assets/a.png", 999)], [row({ pathname: "assets/a.png", sizeInBytes: 100 })], NOW);
    eq("a disagreement is reported with both figures", d.sizeDisagreements, [{ pathname: "assets/a.png", recorded: 100, actual: 999 }]);
  }
  {
    // A landed row with a null size is not "agreeing by omission". It has to be
    // a disagreement, or an upload recorded without its size would be invisible.
    const d = compareToProvider([blob("assets/a.png", 42)], [row({ pathname: "assets/a.png", sizeInBytes: null })], NOW);
    eq("a landed row with no size disagrees with a real blob", d.sizeDisagreements, [{ pathname: "assets/a.png", recorded: null, actual: 42 }]);
  }
  {
    const d = compareToProvider([blob("assets/empty.png", 0)], [row({ pathname: "assets/empty.png", sizeInBytes: 0 })], NOW);
    assert("a genuinely zero-byte object agrees at zero", d.inSync, JSON.stringify(d.sizeDisagreements));
  }

  console.log("\n--- the totals ---\n");
  {
    const d = compareToProvider(
      [blob("assets/a.png", 100)],
      [
        row({ pathname: "assets/a.png" }),
        row({ pathname: "assets/held.png", uploadedAt: null, declaredBytes: 900, sizeInBytes: null }),
      ],
      NOW,
    );
    eq("objects counts every row", d.ledger.objects, 2);
    eq("but bytes counts only what landed", d.ledger.bytes, 100);
    eq("so a reservation never inflates the figure compared to the provider", d.provider.bytes - d.ledger.bytes, 0);
  }

  console.log("\n--- empty on both sides ---\n");
  {
    const d = compareToProvider([], [], NOW);
    assert("an empty platform is in sync rather than broken", d.inSync);
    eq("with honest zeroes", [d.provider.objects, d.ledger.objects, d.provider.bytes, d.ledger.bytes], [0, 0, 0, 0]);
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
