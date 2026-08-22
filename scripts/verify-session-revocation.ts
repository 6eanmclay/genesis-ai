import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  standingOf,
  standingFor,
  touchSession,
  listSessions,
  revokeSession,
  revokeOtherSessions,
} from "@/lib/security/sessions";
import { SECURITY_EVENTS } from "@/lib/security/events";

// A SESSION AN OWNER CAN SEE AND END:
//
//   npx tsx scripts/run-db-suites.ts session-revocation
//
// Step 2 of Security & Trust, and the spine of the milestone. Before it, an
// owner who discovered somebody in their account had exactly one lever — change
// the password — which ends EVERY session including their own. That is threat
// case T2, and it is why 2FA alone would have been worth much less.
//
// D1, approved: sessions stay JWTs. auth.ts already refuses a token whose `iat`
// predates User.passwordChangedAt, which kills it on its NEXT REQUEST rather
// than at expiry; this extends that rather than rewriting authentication onto
// database sessions. A UserSession row is therefore a RECORD of a session, not
// the session.
//
// THE ASSERTION THAT WOULD HAVE CAUSED AN OUTAGE is §1's `unknown`. Every token
// minted before this table existed carries a sessionInstanceId with no row
// behind it. Treating "no row" as "revoked" would have signed out every user on
// the platform the moment this deployed — a self-inflicted outage delivered by
// a security feature. Three states, not a boolean, exactly for that.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, detail: "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}
function assert(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const id = () => `sess-${Math.random().toString(36).slice(2)}`;

async function main() {
  await requireTestDatabase(prismaSystem);

  const owner = await prisma.user.create({
    data: { email: `sess-${Math.random().toString(36).slice(2)}@test.local`, name: "Owner" },
  });
  const stranger = await prisma.user.create({
    data: { email: `sess-x-${Math.random().toString(36).slice(2)}@test.local`, name: "Someone Else" },
  });

  try {
    // ========================================================================
    console.log("\n=== 1. Three standings, because a boolean would have caused an outage ===\n");
    // ========================================================================
    check("a live session is live", standingOf({ revokedAt: null }), "live");
    check("an ended one is revoked", standingOf({ revokedAt: new Date() }), "revoked");
    check("and one we have no record of is UNKNOWN", standingOf(null), "unknown");
    assert(
      "so a token minted before this table existed is not treated as revoked",
      standingOf(null) !== "revoked",
      "every pre-existing user would have been signed out on deploy"
    );
    check("an absent instance id is unknown too", await standingFor(null), "unknown");
    check("and an id with no row", await standingFor("never-existed"), "unknown");

    // ========================================================================
    console.log("\n=== 2. A sign-in is recorded, and staying signed in updates it ===\n");
    // ========================================================================
    const laptop = id();
    await touchSession({ userId: owner.id, sessionInstanceId: laptop, device: "Mac · Safari" });
    const first = await prisma.userSession.findUniqueOrThrow({ where: { sessionInstanceId: laptop } });
    check("the session is recorded", first.userId, owner.id);
    check("with the device it signed in from", first.device, "Mac · Safari");
    check("and it is live", standingOf(first), "live");

    // The refresh branch has no request, so it carries no device. Overwriting
    // the real label with null would erase the only thing that makes a session
    // recognisable to the person deciding whether to end it.
    await new Promise((r) => setTimeout(r, 15));
    await touchSession({ userId: owner.id, sessionInstanceId: laptop });
    const refreshed = await prisma.userSession.findUniqueOrThrow({ where: { sessionInstanceId: laptop } });
    check("a refresh does not erase the device", refreshed.device, "Mac · Safari");
    assert("but does move last-seen forward", refreshed.lastSeenAt > first.lastSeenAt,
      `${refreshed.lastSeenAt.toISOString()} vs ${first.lastSeenAt.toISOString()}`);
    check("and does not create a second row", await prisma.userSession.count({ where: { userId: owner.id } }), 1);

    // ========================================================================
    console.log("\n=== 3. Ending one device ends that one ===\n");
    // ========================================================================
    const phone = id();
    await touchSession({ userId: owner.id, sessionInstanceId: phone, device: "iPhone · Safari" });

    const ended = await revokeSession({
      userId: owner.id,
      sessionInstanceId: phone,
      currentSessionInstanceId: laptop,
    });
    check("the phone is ended", ended, { revoked: true, count: 1 });
    check("and reads as revoked", await standingFor(phone), "revoked");
    check("while the laptop is untouched", await standingFor(laptop), "live");
    assert(
      "so ending one device is not ending them all",
      (await standingFor(phone)) === "revoked" && (await standingFor(laptop)) === "live",
      "the password path already ends everything; this is the surgical one"
    );

    // Ending it again is not found, rather than a second success. A screen that
    // reported two endings for one device would be describing something that
    // did not happen.
    check("ending it twice reports not found",
      await revokeSession({ userId: owner.id, sessionInstanceId: phone, currentSessionInstanceId: laptop }),
      { revoked: false, reason: "not_found" });

    // THE TENANT BOUNDARY. A session id is not a capability.
    const theirs = id();
    await touchSession({ userId: stranger.id, sessionInstanceId: theirs, device: "Windows · Edge" });
    check("another account's session cannot be ended by id",
      await revokeSession({ userId: owner.id, sessionInstanceId: theirs, currentSessionInstanceId: laptop }),
      { revoked: false, reason: "not_found" });
    check("and it is still live", await standingFor(theirs), "live");
    assert(
      "so guessing an id reaches nothing",
      (await standingFor(theirs)) === "live",
      "userId is in the where clause, not checked after the read"
    );

    // AND A SESSION CANNOT END ITSELF HERE. Signing out is a different act.
    check("the current session is refused",
      await revokeSession({ userId: owner.id, sessionInstanceId: laptop, currentSessionInstanceId: laptop }),
      { revoked: false, reason: "is_current" });
    check("and is still live afterwards", await standingFor(laptop), "live");

    // ========================================================================
    console.log("\n=== 4. Ending everything else keeps the one you are using ===\n");
    // ========================================================================
    // THE GAP THIS CLOSES. A password change evicts everything through
    // passwordChangedAt, the owner's own session included — correct, but it
    // means the one tool for "somebody is in my account" also throws the owner
    // out mid-way through securing it.
    const tablet = id();
    const desktop = id();
    await touchSession({ userId: owner.id, sessionInstanceId: tablet, device: "iPad · Safari" });
    await touchSession({ userId: owner.id, sessionInstanceId: desktop, device: "Windows · Chrome" });

    const swept = await revokeOtherSessions({ userId: owner.id, currentSessionInstanceId: laptop });
    check("both others end", swept.count, 2);
    check("the tablet is out", await standingFor(tablet), "revoked");
    check("the desktop is out", await standingFor(desktop), "revoked");
    check("and the one asking is still live", await standingFor(laptop), "live");
    assert(
      "so an owner can evict an intruder without evicting themselves",
      (await standingFor(laptop)) === "live",
      "which the password path cannot do"
    );

    // Another account's sessions are never swept up by it.
    check("a stranger's session survives someone else's sweep", await standingFor(theirs), "live");

    // ========================================================================
    console.log("\n=== 5. The list is what is signed in now ===\n");
    // ========================================================================
    const listed = await listSessions(owner.id, laptop);
    assert("the list is available", listed.available);
    check("and holds only what is still live", listed.sessions.length, 1);
    check("which is the current session", listed.sessions[0]?.sessionInstanceId, laptop);
    check("marked as current, so it is never offered as another device",
      listed.sessions[0]?.current, true);
    check("carrying its device", listed.sessions[0]?.device, "Mac · Safari");

    // Revoked rows stay in the table — a deleted row could not be told apart
    // from a session that never existed, and the history refers to them.
    assert("ended sessions are kept, not deleted",
      (await prisma.userSession.count({ where: { userId: owner.id } })) > listed.sessions.length,
      "a deleted row cannot be told from one that never existed");

    // ========================================================================
    console.log("\n=== 6. Every ending is written to the account's history ===\n");
    // ========================================================================
    const history = await prisma.securityEvent.findMany({ where: { userId: owner.id } });
    const kinds = history.map((h) => h.kind);
    assert("ending one device is recorded", kinds.includes(SECURITY_EVENTS.sessionRevoked), kinds.join(", "));
    assert("so is ending all the others", kinds.includes(SECURITY_EVENTS.allSessionsRevoked), kinds.join(", "));

    // Recorded even when it ended nothing: "I signed out of all other devices
    // and there were none" is a real thing an owner did, and a history that
    // only showed it when it changed something would be missing the checks.
    const before = await prisma.securityEvent.count({ where: { userId: owner.id } });
    const none = await revokeOtherSessions({ userId: owner.id, currentSessionInstanceId: laptop });
    check("a sweep that ends nothing reports zero", none.count, 0);
    check("and is still recorded",
      await prisma.securityEvent.count({ where: { userId: owner.id } }), before + 1);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } }).catch(() => {});
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
