// A REAL AES-256 KEY FOR THIS PROCESS, before anything imports the credential
// helper — the 2FA section enrols a real seed, exactly as verify-two-factor.ts does.
process.env.INTEGRATION_ENCRYPTION_KEY =
  process.env.INTEGRATION_ENCRYPTION_KEY ?? Buffer.alloc(32, 11).toString("base64");

import bcrypt from "bcryptjs";
import { generateSync } from "otplib";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  MOBILE_IDLE_LIMIT_MS,
  bearerKey,
  hashMobileKey,
  mobileStandingOf,
  mobileAuthFailure,
} from "@/lib/auth/mobileSession";
import { verifyCredentialSignIn } from "@/lib/auth/credentialSignIn";
import { PER_IDENTIFIER_LIMIT } from "@/lib/auth/attemptThrottle";
import { listSessions, revokeSession, revokeOtherSessions, touchSession } from "@/lib/security/sessions";
import { beginTwoFactorSetup, enableTwoFactor } from "@/lib/security/twoFactor";
import { SECURITY_EVENTS } from "@/lib/security/events";
import { POST as signIn } from "@/app/api/mobile/v1/auth/sign-in/route";
import { POST as signOut } from "@/app/api/mobile/v1/auth/sign-out/route";
import { GET as me } from "@/app/api/mobile/v1/me/route";

// SIGNING IN TO J4 ON THE PHONE:
//
//   npx tsx scripts/run-db-suites.ts mobile-auth
//
// MOBILE_SIGN_IN_CONTRACT.md, approved 2026-09-27. The contract's promise is that
// the phone inherits EVERY protection the website's sign-in has, by calling the
// same code — so most of this suite is the website's own guarantees, asserted
// again through the phone's door:
//
//   the same lockout, sharing the website's buckets
//   the same second factor, with the same single refusal
//   a session the owner can see in the list they already have, and end there
//   a password change that evicts the phone on its next request
//
// Plus the two things only a phone has: the key is never stored, and ninety
// days of not using J4 signs it out.
//
// The routes are called as functions with real Request objects: the same
// handlers Next serves, against a real database, with nothing stubbed.

const results: { name: string; ok: boolean }[] = [];
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}
function assert(name: string, ok: boolean, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const PHONE_AGENT = "J4/1.0.0 (iPhone; iOS 26.5)";
const REFUSAL = "That didn't work. Check your email, password, and code if you use one.";
const rand = () => Math.random().toString(36).slice(2);

let addressCounter = 0;
/** A fresh documentation-range address per call, so sections never share an IP bucket by accident. */
const freshAddress = () => `203.0.113.${++addressCounter}`;

function signInRequest(body: unknown, address = freshAddress()): Request {
  return new Request("http://localhost/api/mobile/v1/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": PHONE_AGENT, "x-forwarded-for": address },
    body: JSON.stringify(body),
  });
}

function withKey(path: string, key: string | null, method = "GET"): Request {
  const headers: Record<string, string> = { "user-agent": PHONE_AGENT };
  if (key) headers.authorization = `Bearer ${key}`;
  return new Request(`http://localhost${path}`, { method, headers });
}

async function signInAs(email: string, password: string, code?: string) {
  const response = await signIn(signInRequest({ email, password, ...(code !== undefined ? { code } : {}) }));
  return { status: response.status, body: await response.json() };
}

async function meStatus(key: string | null): Promise<number> {
  return (await me(withKey("/api/mobile/v1/me", key))).status;
}

async function main() {
  await requireTestDatabase(prismaSystem);

  const password = "correct horse battery staple";
  const passwordHash = await bcrypt.hash(password, 4);
  const owner = await prisma.user.create({
    data: { email: `mobile-${rand()}@test.local`, name: "Phone Owner", password: passwordHash },
  });
  const stranger = await prisma.user.create({
    data: { email: `mobile-x-${rand()}@test.local`, name: "Someone Else", password: passwordHash },
  });

  try {
    // ========================================================================
    console.log("\n=== 1. When a key stops working — the pure rule ===\n");
    // ========================================================================
    const now = new Date("2026-09-27T12:00:00Z");
    const created = new Date("2026-09-01T12:00:00Z");
    const live = { revokedAt: null, lastSeenAt: now, createdAt: created };

    check("no row is not found", mobileStandingOf(null, null, now), "not_found");
    check("a fresh session is live", mobileStandingOf(live, null, now), "live");
    check("an ended one is revoked", mobileStandingOf({ ...live, revokedAt: now }, null, now), "revoked");

    // D2's boundary, both sides of it. Wrong in the lenient direction is a
    // security hole nobody would ever see.
    const seenAt = (ms: number) => ({ ...live, lastSeenAt: new Date(now.getTime() - ms) });
    check("one millisecond short of ninety days is still live",
      mobileStandingOf(seenAt(MOBILE_IDLE_LIMIT_MS - 1), null, now), "live");
    check("ninety days unused is signed out", mobileStandingOf(seenAt(MOBILE_IDLE_LIMIT_MS), null, now), "idle");
    check("and the limit really is ninety days", MOBILE_IDLE_LIMIT_MS, 90 * 24 * 60 * 60 * 1000);

    // The same eviction the website applies to every browser.
    check("a password changed after sign-in evicts the phone",
      mobileStandingOf(live, new Date(created.getTime() + 1), now), "password_changed");
    check("one changed before sign-in does not — that sign-in used the new password",
      mobileStandingOf(live, new Date(created.getTime() - 1), now), "live");

    // ========================================================================
    console.log("\n=== 2. Only a well-formed bearer key is read ===\n");
    // ========================================================================
    const h = (value?: string) => new Headers(value ? { authorization: value } : {});
    check("no header, no key", bearerKey(h()), null);
    check("another scheme is not a key", bearerKey(h("Basic abcdefghijklmnopqrstu")), null);
    check("a too-short value is not a key", bearerKey(h("Bearer abc")), null);
    check("a real one is read", bearerKey(h("Bearer abcdefghijklmnopqrstuvwxyz_-0123")), "abcdefghijklmnopqrstuvwxyz_-0123");

    // 401 means "forget your key", 503 means "keep it and try again". Collapsing
    // them would sign every phone out whenever the database hiccupped.
    check("a dead key tells the phone to sign out", mobileAuthFailure({ ok: false, reason: "signed_out" }).status, 401);
    check("an outage tells it to keep the key", mobileAuthFailure({ ok: false, reason: "unavailable" }).status, 503);

    // ========================================================================
    console.log("\n=== 3. Signing in, and what is kept ===\n");
    // ========================================================================
    const wrong = await signInAs(owner.email, "not the password");
    check("a wrong password is refused", wrong.status, 401);
    check("with the website's one message", wrong.body.error, REFUSAL);
    check("and no key", wrong.body.token, undefined);

    const unknown = await signInAs(`nobody-${rand()}@test.local`, password);
    check("an address with no account gets the identical answer", [unknown.status, unknown.body], [401, { error: REFUSAL }]);

    // Different capitalisation, because the website's normalizeEmail is the one in use.
    const good = await signInAs(owner.email.toUpperCase(), password);
    check("the right password signs in, whatever the capitals", good.status, 200);
    const key: string = good.body.token;
    assert("and returns a long random key", typeof key === "string" && key.length >= 40, String(key?.length));
    check("with only the name and address beside it", good.body.user, { name: "Phone Owner", email: owner.email });
    assert("never the password hash", !JSON.stringify(good.body).includes(passwordHash));

    const row = await prisma.userSession.findUnique({ where: { tokenHash: hashMobileKey(key) } });
    assert("the session is a UserSession row", row?.userId === owner.id);
    check("marked as the phone's", row?.kind, "mobile");
    check("labelled the way the owner will recognise it", row?.device, "iPhone · J4");
    const stored = await prisma.userSession.findMany({ where: { userId: owner.id } });
    assert(
      "and the key itself is stored nowhere — only its hash",
      stored.every((s) => s.tokenHash !== key && s.sessionInstanceId !== key && s.device !== key),
      "a database leak alone must not be a way in"
    );

    const history = await prisma.securityEvent.findMany({ where: { userId: owner.id }, orderBy: { createdAt: "asc" } });
    assert("the failed attempt is in the owner's history",
      history.some((e) => e.kind === SECURITY_EVENTS.signInFailed));
    assert("and so is the sign-in, from the phone",
      history.some((e) => e.kind === SECURITY_EVENTS.signedIn && e.device === "iPhone · J4"),
      history.map((e) => `${e.kind}@${e.device}`).join(", "));

    // ========================================================================
    console.log("\n=== 4. The key opens this account and nothing else ===\n");
    // ========================================================================
    const who = await me(withKey("/api/mobile/v1/me", key));
    check("the phone can ask who it is", who.status, 200);
    check("and gets its own account", (await who.json()).user, { name: "Phone Owner", email: owner.email });
    check("no key is signed out", await meStatus(null), 401);
    check("an invented key is signed out", await meStatus("x".repeat(43)), 401);

    // A website row has no tokenHash, so no key can ever reach it — asserted
    // rather than assumed, since the two kinds now share one table.
    const laptop = `laptop-${rand()}`;
    await touchSession({ userId: owner.id, sessionInstanceId: laptop, device: "Mac · Safari" });
    check("the hash of a website session's id opens nothing", await meStatus(laptop), 401);

    const theirs = await signInAs(stranger.email, password);
    const theirWho = await (await me(withKey("/api/mobile/v1/me", theirs.body.token))).json();
    check("another account's key reads that account, not this one", theirWho.user.email, stranger.email);

    // Using J4 is what keeps it signed in (D2).
    await prisma.userSession.update({ where: { tokenHash: hashMobileKey(key) }, data: { lastSeenAt: new Date(Date.now() - 60_000) } });
    const before = (await prisma.userSession.findUniqueOrThrow({ where: { tokenHash: hashMobileKey(key) } })).lastSeenAt;
    await meStatus(key);
    const after = (await prisma.userSession.findUniqueOrThrow({ where: { tokenHash: hashMobileKey(key) } })).lastSeenAt;
    assert("every use moves last-seen forward", after > before, `${before.toISOString()} → ${after.toISOString()}`);

    // ========================================================================
    console.log("\n=== 5. The owner sees the phone, and can end it from the website ===\n");
    // ========================================================================
    const listed = await listSessions(owner.id, laptop);
    const phoneRow = listed.sessions.find((s) => s.device === "iPhone · J4");
    assert("the phone appears in the website's sessions list", Boolean(phoneRow));
    check("as another device, not the one looking", phoneRow?.current, false);

    const ended = await revokeSession({ userId: owner.id, sessionInstanceId: phoneRow!.sessionInstanceId, currentSessionInstanceId: laptop });
    check("'End session' on the website ends it", ended, { revoked: true, count: 1 });
    check("and the phone is signed out on its very next request", await meStatus(key), 401);

    const second = (await signInAs(owner.email, password)).body.token as string;
    check("signing in again works", await meStatus(second), 200);
    await revokeOtherSessions({ userId: owner.id, currentSessionInstanceId: laptop });
    check("'Sign out of all other devices' ends the phone too", await meStatus(second), 401);
    check("while the stranger's phone is untouched", await meStatus(theirs.body.token), 200);

    // ========================================================================
    console.log("\n=== 6. A password change evicts the phone ===\n");
    // ========================================================================
    const beforeChange = (await signInAs(owner.email, password)).body.token as string;
    check("signed in", await meStatus(beforeChange), 200);
    await new Promise((r) => setTimeout(r, 5));
    await prisma.user.update({ where: { id: owner.id }, data: { passwordChangedAt: new Date() } });
    check("after the password changes, that phone is signed out", await meStatus(beforeChange), 401);
    await new Promise((r) => setTimeout(r, 5));
    const afterChange = (await signInAs(owner.email, password)).body.token as string;
    check("and a sign-in after the change works", await meStatus(afterChange), 200);

    // ========================================================================
    console.log("\n=== 7. Ninety days unused signs it out ===\n");
    // ========================================================================
    await prisma.userSession.update({
      where: { tokenHash: hashMobileKey(afterChange) },
      data: { lastSeenAt: new Date(Date.now() - MOBILE_IDLE_LIMIT_MS - 60_000) },
    });
    check("a phone untouched for ninety days is signed out", await meStatus(afterChange), 401);

    // ========================================================================
    console.log("\n=== 8. Signing out on the phone ===\n");
    // ========================================================================
    const toSignOut = (await signInAs(owner.email, password)).body.token as string;
    check("signing out answers 204", (await signOut(withKey("/api/mobile/v1/auth/sign-out", toSignOut, "POST"))).status, 204);
    check("and the key is dead", await meStatus(toSignOut), 401);
    const endedRow = await prisma.userSession.findUniqueOrThrow({ where: { tokenHash: hashMobileKey(toSignOut) } });
    assert("revoked rather than deleted, so a surviving copy of the key is still dead", endedRow.revokedAt !== null);
    check("signing out twice is still 204", (await signOut(withKey("/api/mobile/v1/auth/sign-out", toSignOut, "POST"))).status, 204);
    check("as is signing out with no key at all", (await signOut(withKey("/api/mobile/v1/auth/sign-out", null, "POST"))).status, 204);

    // ========================================================================
    console.log("\n=== 9. The second factor, through the phone's door ===\n");
    // ========================================================================
    const setup = await beginTwoFactorSetup({ userId: owner.id, accountEmail: owner.email });
    await enableTwoFactor({ userId: owner.id, token: generateSync({ secret: setup.secret }) });

    const noCode = await signInAs(owner.email, password);
    check("with 2FA on, the right password alone is refused", noCode.status, 401);
    check("with the same message as a wrong password", noCode.body.error, REFUSAL);
    const badCode = await signInAs(owner.email, password, "000000");
    check("a wrong code is refused the same way", [badCode.status, badCode.body.error], [401, REFUSAL]);
    const withCode = await signInAs(owner.email, password, generateSync({ secret: setup.secret }));
    check("the right code signs in", withCode.status, 200);
    check("and the key works", await meStatus(withCode.body.token), 200);

    await prisma.user.update({ where: { id: owner.id }, data: { totpSecret: null, totpEnabledAt: null } });
    await prisma.recoveryCode.deleteMany({ where: { userId: owner.id } });

    // ========================================================================
    console.log("\n=== 10. The lockout is the website's, not a second allowance ===\n");
    // ========================================================================
    // Every failure from a different address, so only the per-account bucket
    // can be what trips — the one the website's login counts against too.
    for (let i = 0; i < PER_IDENTIFIER_LIMIT; i++) {
      await signIn(signInRequest({ email: owner.email, password: "wrong" }));
    }
    const lockedOut = await signInAs(owner.email, password);
    check("after the limit, even the right password is refused on the phone", lockedOut.status, 401);
    check("with the same message, so the lockout is not an oracle", lockedOut.body.error, REFUSAL);
    const websiteSignIn = await verifyCredentialSignIn({ email: owner.email, password, token: "" }, new Headers());
    check("and the website's own sign-in is locked out by the phone's failures", websiteSignIn, null);
    const events = await prisma.securityEvent.findMany({ where: { userId: owner.id } });
    assert("the lockout is in the owner's history", events.some((e) => e.kind === SECURITY_EVENTS.signInBlocked));
  } finally {
    await prisma.authAttempt.deleteMany({}).catch(() => {});
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
