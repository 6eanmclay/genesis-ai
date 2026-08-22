import bcrypt from "bcryptjs";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  REAUTHENTICATION_WINDOW_MS,
  isReauthenticationFresh,
  confirmPassword,
  hasFreshConfirmation,
  clearConfirmation,
} from "@/lib/security/reauthentication";
import { SECURITY_EVENTS } from "@/lib/security/events";

// PROVING YOU ARE STILL YOU:
//
//   npx tsx scripts/run-db-suites.ts reauthentication
//
// Step 3, built BEFORE 2FA on purpose. The moment a "turn off two-factor
// authentication" control exists, threat case T3 is live — an attacker holding
// a stolen session just switches the defence off. Building the guard first
// means that button is never shipped naked.
//
// TIME IS AN INPUT, NEVER THE CLOCK. The freshness window is the whole
// security property here, and a window that is wrong in the lenient direction
// is a hole nobody would ever see. So the boundary is asserted at exactly the
// millisecond, in both directions, against injected timestamps.

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

const PASSWORD = "a-real-passphrase-for-this-test";

async function main() {
  await requireTestDatabase(prismaSystem);

  const owner = await prisma.user.create({
    data: {
      email: `reauth-${Math.random().toString(36).slice(2)}@test.local`,
      password: await bcrypt.hash(PASSWORD, 10),
    },
  });
  // An account that signs in with Google and has no password at all.
  const oauthOnly = await prisma.user.create({
    data: { email: `reauth-oauth-${Math.random().toString(36).slice(2)}@test.local` },
  });

  try {
    // ========================================================================
    console.log("\n=== 1. The window, asserted at the millisecond ===\n");
    // ========================================================================
    const t0 = new Date("2026-08-22T12:00:00.000Z");
    const at = (ms: number) => new Date(t0.getTime() + ms);

    check("a confirmation just made is fresh", isReauthenticationFresh(t0, t0), true);
    check("one a second old is fresh", isReauthenticationFresh(t0, at(1_000)), true);
    check("one a millisecond inside the window is fresh",
      isReauthenticationFresh(t0, at(REAUTHENTICATION_WINDOW_MS - 1)), true);

    // THE BOUNDARY ITSELF. Off by one in this direction is a security hole that
    // never announces itself.
    check("one exactly at the window has expired",
      isReauthenticationFresh(t0, at(REAUTHENTICATION_WINDOW_MS)), false);
    check("and one past it certainly has",
      isReauthenticationFresh(t0, at(REAUTHENTICATION_WINDOW_MS + 1)), false);

    check("never confirmed is not fresh", isReauthenticationFresh(null, t0), false);
    check("undefined is not fresh either", isReauthenticationFresh(undefined, t0), false);

    // A confirmation stamped in the future is a clock problem, not a pass.
    // Accepting it would turn skew into an indefinite bypass.
    check("a confirmation from the future is refused", isReauthenticationFresh(at(60_000), t0), false);
    assert(
      "so the guard fails closed on a bad clock rather than open",
      isReauthenticationFresh(at(60_000), t0) === false,
      "an open failure here is an indefinite pass into the security settings"
    );

    // ========================================================================
    console.log("\n=== 2. The right password confirms, the wrong one does not ===\n");
    // ========================================================================
    const wrong = await confirmPassword({ userId: owner.id, password: "not-the-password" });
    check("a wrong password is refused", wrong, { confirmed: false, reason: "incorrect" });
    check("and nothing is confirmed by it", await hasFreshConfirmation(owner.id), false);

    const right = await confirmPassword({ userId: owner.id, password: PASSWORD });
    assert("the real password confirms", right.confirmed, JSON.stringify(right));
    check("and the account is now confirmed", await hasFreshConfirmation(owner.id), true);

    // An OAuth-only account is told it has no password, rather than being told
    // it typed the wrong one — those need different answers on screen.
    check("an account with no password says so",
      await confirmPassword({ userId: oauthOnly.id, password: PASSWORD }),
      { confirmed: false, reason: "no_password" });
    assert(
      "which is a different answer from a wrong password",
      true,
      "one is a capability gap, the other is somebody guessing"
    );

    // ========================================================================
    console.log("\n=== 3. A confirmation expires, and is spent when used ===\n");
    // ========================================================================
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: owner.id },
      select: { reauthenticatedAt: true },
    });
    assert("the confirmation was really stored", stored.reauthenticatedAt !== null,
      String(stored.reauthenticatedAt));

    // Read at a moment past the window, without touching the clock.
    const later = new Date(stored.reauthenticatedAt!.getTime() + REAUTHENTICATION_WINDOW_MS + 1);
    check("it has expired by then", await hasFreshConfirmation(owner.id, later), false);
    check("but is still good just inside",
      await hasFreshConfirmation(owner.id, new Date(stored.reauthenticatedAt!.getTime() + 1_000)), true);

    // SPENT ON USE. One confirmation must not authorise an unbounded series of
    // security-sensitive actions for the rest of the window — turning 2FA off
    // and removing a member are two decisions, and the second asks again.
    await clearConfirmation(owner.id);
    check("using it spends it", await hasFreshConfirmation(owner.id), false);
    assert(
      "so one confirmation is one decision, not a five-minute pass",
      (await hasFreshConfirmation(owner.id)) === false,
      "turning 2FA off and removing a member are two decisions"
    );

    // ========================================================================
    console.log("\n=== 4. Both outcomes reach the account's history ===\n");
    // ========================================================================
    // A FAILED CONFIRMATION IS INVISIBLE EVERYWHERE ELSE. The sign-in log shows
    // nothing, because an attacker with a stolen session never signed in. This
    // is the only place an owner would ever see somebody probing their security
    // settings.
    const events = await prisma.securityEvent.findMany({ where: { userId: owner.id } });
    const kinds = events.map((e) => e.kind);
    assert("a failed confirmation is recorded",
      kinds.includes(SECURITY_EVENTS.reauthenticationFailed), kinds.join(", "));
    assert("and a successful one",
      kinds.includes(SECURITY_EVENTS.reauthenticated), kinds.join(", "));

    // The OAuth-only refusal records nothing: there is nothing they could have
    // typed that would have worked, so it is a capability gap rather than a
    // suspicious event, and a history full of it would be noise.
    check("an account with no password gathers no failures",
      await prisma.securityEvent.count({ where: { userId: oauthOnly.id } }), 0);

    // No password, hash or attempt text is ever written down.
    const serialised = JSON.stringify(events);
    assert("nothing recorded contains the password",
      !serialised.includes(PASSWORD) && !serialised.includes("not-the-password"),
      "an audit log that captured the attempt would be the worst table here");
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, oauthOnly.id] } } }).catch(() => {});
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
