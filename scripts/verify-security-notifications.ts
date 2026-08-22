import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  NOTIFIABLE_EVENTS,
  isNotifiable,
  buildSecurityEmail,
  notifyOfSecurityEvent,
} from "@/lib/security/notifications";
import { SECURITY_EVENTS, SECURITY_EVENT_LABEL, type SecurityEventKind } from "@/lib/security/events";

// TELLING AN OWNER SOMETHING HAPPENED TO THEIR ACCOUNT:
//
//   npx tsx scripts/run-db-suites.ts security-notifications
//
// Step 8, and the one the contract predicted would land externally blocked.
// SENDING IS BLOCKED and stays so: there is no RESEND_API_KEY here, and this
// project's standing rule is that a real dependency is never mocked.
//
// But the SENDER IS INJECTABLE, exactly as sendOrderConfirmation's is, so every
// DECISION is provable without a provider existing: whether to notify, about
// what, to whom, and what it says. That is the half that can be wrong in a way
// nobody notices — a provider that is merely absent announces itself.
//
// WHAT IS WORTH AN EMAIL IS NOT WHAT IS WORTH A LOG LINE, and §1 is about that
// judgement rather than about plumbing. Mailing every successful sign-in would
// train an owner to ignore exactly the messages this exists to send.

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

async function main() {
  await requireTestDatabase(prismaSystem);

  const priorKey = process.env.RESEND_API_KEY;
  const priorFrom = process.env.EMAIL_FROM_ADDRESS;

  const owner = await prisma.user.create({
    data: { email: `notify-${Math.random().toString(36).slice(2)}@test.local`, name: "Owner" },
  });

  try {
    // ========================================================================
    console.log("\n=== 1. Only what is worth interrupting somebody about ===\n");
    // ========================================================================
    assert("2FA being turned off is worth a mail", isNotifiable(SECURITY_EVENTS.twoFactorDisabled));
    assert("so is a password change", isNotifiable(SECURITY_EVENTS.passwordChanged));
    assert("so is a recovery code being used", isNotifiable(SECURITY_EVENTS.recoveryCodeUsed));
    assert("and the throttle firing", isNotifiable(SECURITY_EVENTS.signInBlocked));

    // THE JUDGEMENT, not the plumbing. These are the two that would make every
    // other message worthless.
    assert(
      "an ordinary successful sign-in is NOT",
      !isNotifiable(SECURITY_EVENTS.signedIn),
      "mailing the most common event on the account trains the owner to ignore the rest"
    );
    assert(
      "and neither is a single mistyped password",
      !isNotifiable(SECURITY_EVENTS.signInFailed),
      "people mistype their own passwords constantly; the throttle firing is the pattern worth sending"
    );

    // Every notifiable kind is a real kind.
    const allKinds = Object.values(SECURITY_EVENTS) as SecurityEventKind[];
    assert("every notifiable event is a real event",
      NOTIFIABLE_EVENTS.every((k) => allKinds.includes(k)),
      NOTIFIABLE_EVENTS.filter((k) => !allKinds.includes(k)).join(", "));

    // ========================================================================
    console.log("\n=== 2. What it says ===\n");
    // ========================================================================
    const at = new Date("2026-08-22T18:30:00.000Z");
    const email = buildSecurityEmail({
      kind: SECURITY_EVENTS.twoFactorDisabled,
      to: owner.email,
      device: "Windows · Chrome",
      at,
    });
    check("it goes to the account it happened to", email.to, owner.email);
    assert("the subject says what happened",
      email.subject.toLowerCase().includes("two-factor"), email.subject);
    assert("the body names the device", email.html.includes("Windows · Chrome"), email.html);
    assert("and when", email.html.includes("2026"), email.html);
    assert("it tells them what to do if it was not them",
      email.html.includes("change your password"), email.html);

    // NO LINK, DELIBERATELY. A security email that trains people to click
    // links is the thing an attacker imitates next week.
    assert(
      "and it contains no link to click",
      !email.html.includes("<a ") && !email.html.includes("http"),
      "a security mail that teaches people to click links is a liability"
    );

    // An event with no device says nothing rather than guessing.
    const noDevice = buildSecurityEmail({
      kind: SECURITY_EVENTS.passwordChanged,
      to: owner.email,
      device: null,
      at,
    });
    assert("with no device known, no device line is invented",
      !noDevice.html.includes("Device:"), noDevice.html);

    // Every notifiable kind produces a readable subject — no raw identifiers.
    for (const kind of NOTIFIABLE_EVENTS) {
      const built = buildSecurityEmail({ kind, to: owner.email, device: null, at });
      assert(`"${kind}" reads as a sentence`,
        !built.subject.includes("_") && !built.subject.includes("."),
        built.subject);
      assert(`and matches its own label`,
        built.subject.toLowerCase().includes(SECURITY_EVENT_LABEL[kind].toLowerCase().slice(0, 12)),
        built.subject);
    }

    // ========================================================================
    console.log("\n=== 3. The decision, with the provider genuinely absent ===\n");
    // ========================================================================
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM_ADDRESS;

    check("an unconfigured platform reports itself, once and clearly",
      await notifyOfSecurityEvent({ userId: owner.id, kind: SECURITY_EVENTS.twoFactorDisabled }),
      { sent: false, reason: "email_not_configured" });
    check("and an event nobody needs mailing is refused before any of that",
      await notifyOfSecurityEvent({ userId: owner.id, kind: SECURITY_EVENTS.signedIn }),
      { sent: false, reason: "not_notifiable" });

    // ========================================================================
    console.log("\n=== 4. And with an injected sender, the whole decision ===\n");
    // ========================================================================
    process.env.RESEND_API_KEY = "test-key-never-used";
    process.env.EMAIL_FROM_ADDRESS = "genesis@test.local";

    const sent: { to: string; subject: string }[] = [];
    const sender = async (input: { to: string; subject: string; html: string }) => {
      sent.push({ to: input.to, subject: input.subject });
    };

    const outcome = await notifyOfSecurityEvent(
      { userId: owner.id, kind: SECURITY_EVENTS.twoFactorDisabled, device: "Mac · Safari" },
      sender
    );
    check("a notifiable event sends", outcome, { sent: true });
    check("exactly one mail", sent.length, 1);
    check("to the owner", sent[0]?.to, owner.email);

    // Still refused for the ordinary case, even with a working provider.
    await notifyOfSecurityEvent({ userId: owner.id, kind: SECURITY_EVENTS.signedIn }, sender);
    check("and a successful sign-in still sends nothing", sent.length, 1);

    // A provider failure is reported, never thrown — recording and notifying
    // are bookkeeping around an act the owner asked for, and neither may fail
    // it. An owner must not be blocked from turning 2FA off because a mail
    // would not send.
    const failed = await notifyOfSecurityEvent(
      { userId: owner.id, kind: SECURITY_EVENTS.passwordChanged },
      async () => {
        throw new Error("the provider refused it");
      }
    );
    assert("a provider failure is reported, not thrown",
      failed.sent === false && failed.reason === "send_failed", JSON.stringify(failed));
    assert("carrying the real reason",
      failed.sent === false && failed.reason === "send_failed" && failed.detail.includes("provider refused"),
      JSON.stringify(failed));

    // ========================================================================
    console.log("\n=== 5. Nothing sent contains a secret ===\n");
    // ========================================================================
    const serialised = JSON.stringify(sent);
    for (const forbidden of ["password", "secret", "token", "hash"]) {
      assert(`no mail contains "${forbidden}"`, !serialised.toLowerCase().includes(forbidden), forbidden);
    }
  } finally {
    if (priorKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = priorKey;
    if (priorFrom === undefined) delete process.env.EMAIL_FROM_ADDRESS;
    else process.env.EMAIL_FROM_ADDRESS = priorFrom;
    await prisma.user.delete({ where: { id: owner.id } }).catch(() => {});
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
