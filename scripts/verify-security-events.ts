import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  SECURITY_EVENTS,
  SECURITY_EVENT_LABEL,
  NOTEWORTHY_EVENTS,
  describeDevice,
  recordSecurityEvent,
  getSecurityHistory,
  type SecurityEventKind,
} from "@/lib/security/events";

// THE ACCOUNT'S OWN HISTORY:
//
//   npx tsx scripts/run-db-suites.ts
//
// Step 1 of Security & Trust, and the foundation the rest of the milestone
// emits into. Three properties are worth more than the rest:
//
// IT NEVER BREAKS WHAT IT RECORDS. A failure to write an audit row must not
// fail the sign-in it is describing. Locking somebody out of their own business
// because an INSERT failed is a denial of service delivered by the security
// feature itself, so recordSecurityEvent swallows and reports rather than
// throwing — and §5 proves that against a genuinely broken write.
//
// AN EMPTY HISTORY AND A BROKEN ONE ARE DIFFERENT ANSWERS. `available` exists
// so a screen can say "we cannot show your history" instead of rendering a
// clean bill of health for an account nobody can see into. Same discipline as
// Commerce's lead: two silences are not the same silence.
//
// NO SECRETS, EVER. §4 sweeps the recorded rows for anything that looks like a
// credential. An audit log that captured what it was auditing would be the
// single worst table in the database.

const results: { name: string; ok: boolean; detail: string }[] = [];

/** An equality assertion, reporting both sides when it fails. */
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, detail: ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

/** A boolean assertion, for the properties that are not equalities. */
function assert(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({
    data: { email: `sec-${Math.random().toString(36).slice(2)}@test.local`, name: "Owner" },
  });
  const other = await prisma.user.create({
    data: { email: `sec-other-${Math.random().toString(36).slice(2)}@test.local`, name: "Someone Else" },
  });

  try {
    // ========================================================================
    console.log("\n=== 1. Every event kind can be read by the person it happened to ===\n");
    // ========================================================================
    // A kind with no label renders as a raw identifier like
    // "two_factor.recovery_codes_regenerated" on a security screen. Asserted in
    // BOTH directions, because the two lists are hand-maintained spellings of
    // one vocabulary — see ARCHITECTURE.md's mirrored-registry invariant.
    const kinds = Object.values(SECURITY_EVENTS) as SecurityEventKind[];
    assert("there are real event kinds", kinds.length > 0, String(kinds.length));
    for (const kind of kinds) {
      const label = SECURITY_EVENT_LABEL[kind];
      assert(`"${kind}" has an owner-facing label`, typeof label === "string" && label.length > 0, String(label));
      assert(`and "${kind}" does not leak its identifier into it`, !label?.includes("_") && !label?.includes("."), String(label));
    }
    const labelled = Object.keys(SECURITY_EVENT_LABEL);
    assert("and no label describes an event that cannot happen",
      labelled.every((k) => kinds.includes(k as SecurityEventKind)),
      labelled.filter((k) => !kinds.includes(k as SecurityEventKind)).join(", "));

    // Noteworthy is a subset of the vocabulary, not a second copy of it.
    assert("every noteworthy kind is a real kind",
      NOTEWORTHY_EVENTS.every((k) => kinds.includes(k)),
      NOTEWORTHY_EVENTS.filter((k) => !kinds.includes(k)).join(", "));
    assert("a successful sign-in is not flagged as noteworthy",
      !NOTEWORTHY_EVENTS.includes(SECURITY_EVENTS.signedIn),
      "flagging the ordinary case makes the flag meaningless");
    assert("a failed one is", NOTEWORTHY_EVENTS.includes(SECURITY_EVENTS.signInFailed));

    // ========================================================================
    console.log("\n=== 2. The device is recognisable, and is not a fingerprint ===\n");
    // ========================================================================
    // D4, approved: device and last-seen only. What an owner needs is enough to
    // recognise their own session, not a dossier on themselves.
    const CHROME_WIN =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const SAFARI_IPHONE =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    const EDGE =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    const FIREFOX_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0";

    check("a Windows Chrome reads as one", describeDevice(CHROME_WIN), "Windows · Chrome");
    check("an iPhone Safari reads as one", describeDevice(SAFARI_IPHONE), "iPhone · Safari");
    check("and a Mac Firefox", describeDevice(FIREFOX_MAC), "Mac · Firefox");

    // THE ASSERTION THAT CATCHES THE COMMON BUG. Edge and Opera both claim
    // "Chrome" in their user-agent, and Chrome claims "Safari" — a naive
    // check labels every one of them wrong, and an owner scanning for a
    // session they do not recognise is looking at the wrong browser name.
    check("Edge is not mislabelled as the Chrome it impersonates", describeDevice(EDGE), "Windows · Edge");

    // Absent is its own answer, distinct from unrecognised.
    check("no user-agent is null, not a guess", describeDevice(null), null);
    check("an empty one too", describeDevice("   "), null);
    check("and something unrecognisable is null rather than mislabelled", describeDevice("curl/8.4.0"), null);

    // The raw agent is never what gets stored.
    assert("the label is short enough to read at a glance",
      (describeDevice(CHROME_WIN) ?? "").length < 40, String(describeDevice(CHROME_WIN)?.length));

    // ========================================================================
    console.log("\n=== 3. History belongs to one account, newest first ===\n");
    // ========================================================================
    await recordSecurityEvent({ userId: user.id, kind: SECURITY_EVENTS.signedIn, userAgent: CHROME_WIN });
    await recordSecurityEvent({ userId: user.id, kind: SECURITY_EVENTS.signInFailed, userAgent: SAFARI_IPHONE });
    await recordSecurityEvent({ userId: other.id, kind: SECURITY_EVENTS.signedIn, userAgent: EDGE });

    const mine = await getSecurityHistory(user.id);
    assert("the history is available", mine.available, JSON.stringify(mine.available));
    check("and holds only this account's events", mine.entries.length, 2);
    check("newest first", mine.entries[0]?.kind, SECURITY_EVENTS.signInFailed);
    check("carrying the device it happened on", mine.entries[0]?.device, "iPhone · Safari");
    check("and a readable label", mine.entries[0]?.label, "Failed sign-in attempt");
    check("with the noteworthy one flagged", mine.entries[0]?.noteworthy, true);
    check("and the ordinary one not", mine.entries[1]?.noteworthy, false);

    const theirs = await getSecurityHistory(other.id);
    check("another account sees only its own", theirs.entries.length, 1);
    assert(
      "so one owner's history is never another's",
      theirs.entries.every((e) => e.kind === SECURITY_EVENTS.signedIn) && mine.entries.length === 2,
      "an account with three businesses still has ONE sign-in history"
    );

    // A brand-new account: genuinely empty, and available.
    const fresh = await prisma.user.create({
      data: { email: `sec-fresh-${Math.random().toString(36).slice(2)}@test.local` },
    });
    const nothing = await getSecurityHistory(fresh.id);
    check("an account with no history reports none", nothing.entries.length, 0);
    check("and says so is AVAILABLE, not broken", nothing.available, true);
    await prisma.user.delete({ where: { id: fresh.id } }).catch(() => {});

    // ========================================================================
    console.log("\n=== 4. Nothing recorded is a secret ===\n");
    // ========================================================================
    // An audit log that captured what it was auditing would be the worst table
    // in the database. detail is free-form JSON, so this is the guard on it.
    await recordSecurityEvent({
      userId: user.id,
      kind: SECURITY_EVENTS.twoFactorEnabled,
      detail: { method: "totp" },
    });
    const rows = await prisma.securityEvent.findMany({ where: { userId: user.id } });
    const serialised = JSON.stringify(rows);
    for (const forbidden of ["password", "secret", "token", "code", "hash", "seed"]) {
      assert(`no recorded row contains "${forbidden}"`, !serialised.toLowerCase().includes(forbidden), forbidden);
    }
    assert(
      "and the device is a label rather than the raw agent",
      !serialised.includes("AppleWebKit"),
      "the raw user-agent is a fingerprint; the label is what an owner reads"
    );

    // ========================================================================
    console.log("\n=== 5. Recording never breaks the thing it records ===\n");
    // ========================================================================
    // THE ASSERTION THAT MATTERS MOST IN THIS FILE. If this write can throw,
    // then an audit failure becomes a failed sign-in — the security feature
    // denying service to the account it protects.
    //
    // Broken for real: a userId with no such User violates the foreign key, so
    // the INSERT genuinely fails at the database rather than being intercepted.
    const threw = await recordSecurityEvent({
      userId: "user-that-does-not-exist",
      kind: SECURITY_EVENTS.signedIn,
    }).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e))
    );
    check("a failed write is swallowed, not thrown", threw, null);

    // And a failed READ is reported as unavailable rather than as an empty
    // history — the difference between "nothing happened to your account" and
    // "we cannot tell you what happened to your account".
    //
    // Broken through the INJECTED READER, which is the only honest way to do
    // this. Two earlier versions tried to provoke a real database failure with
    // an invalid `take` — first -1, which Prisma reads as "from the end", then
    // 1.5, which it coerces. Both queries succeeded, so the assertion reported
    // the most important property in this file as proved while testing nothing.
    const broken = await getSecurityHistory(user.id, 50, async () => {
      throw new Error("the database is not answering");
    });
    check("a failed read reports itself unavailable", broken.available, false);
    check("and returns no entries rather than inventing them", broken.entries.length, 0);
    assert(
      "so a screen can never show a clean bill of health for a log it cannot read",
      broken.available === false && nothing.available === true,
      "two silences are not the same silence"
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } }).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
