import { createHash } from "crypto";
import { prisma, prismaSystem } from "@/lib/prisma";
import { recordSignal, SIGNAL_KINDS } from "@/lib/security/signals";
import { reportIssue } from "@/lib/observability/reportIssue";

// CLOSING AN ACCOUNT WITHOUT DESTROYING A BUSINESS'S RECORDS.
//
// ============ WHAT prisma.user.delete() WOULD DO (2026-08-30) ==========
//
// User cascades to Store, and Store cascades to Order. So deleting the row
// would delete every business this person owns and every order inside them —
// every payment, every refund, every dispute, every customer's transaction.
// That is the schema's behaviour today and it is why this file exists rather
// than a one-line delete.
//
// Sean, 2026-08-30: "Do not erase the financial/order record wholesale.
// Anonymize personal/customer information while retaining the minimum
// transaction record Genesis legitimately needs for accounting, tax, refunds,
// disputes, reconciliation."
//
// ============ SO THE ROW SURVIVES, EMPTIED ============================
//
// Every foreign key pointing at the user still resolves. What changes is that
// the person is no longer identifiable through it: the email becomes a
// non-reversible placeholder, the name and image go, and every credential is
// deleted outright rather than anonymised — an OAuth token or a recovery code
// has no anonymised form, it is either present or gone.
//
// ============ AND SOMEBODY ELSE'S DATA IS NOT TOUCHED =================
//
// An order carries a CUSTOMER's email and address. That is a different person's
// data held by the business as its own record, and an owner closing their
// Genesis account is not a reason to erase it — the business still needs it for
// the refund, the dispute and the tax return. A customer's own erasure request
// is a separate operation against a separate person, and is not this.
//
// ============ WHAT THIS DELIBERATELY DOES NOT DECIDE ==================
//
// How long the retained record must be kept. That is an accounting and legal
// question, recorded in EXTERNAL_BLOCKERS.md rather than answered here — the
// same discipline the retention policy applies to the execution log.

/** What closing an account did, or would do. */
export interface ClosureResult {
  userId: string;
  /** True when this call performed the closure. False when it was already closed. */
  closed: boolean;
  /** Present when nothing was done. */
  alreadyClosedAt?: Date;
  /** Counts of what was removed, for the audit record and the caller. */
  removed: {
    oauthAccounts: number;
    sessions: number;
    userSessions: number;
    recoveryCodes: number;
    passwordResetTokens: number;
  };
  /** What was kept, and why it had to be. */
  retained: {
    businesses: number;
    orders: number;
    reason: string;
  };
}

/**
 * The placeholder an email becomes.
 *
 * A one-way hash of the original, not a random id. Two things need to stay
 * true: the address must not be recoverable, and the column is `@unique` so
 * every closed account still needs a distinct value. A hash gives both, and it
 * also means closing the same account twice would produce the same string —
 * which is what makes the operation idempotent rather than merely repeatable.
 */
export function closedEmailFor(userId: string): string {
  const digest = createHash("sha256").update(`closed:${userId}`).digest("hex").slice(0, 32);
  return `closed-${digest}@account.closed`;
}

/**
 * Close an account: anonymise the person, keep the business.
 *
 * IDEMPOTENT. A second call sees `closedAt` and returns without writing, which
 * matters because this is the kind of operation somebody retries when they are
 * not sure it worked, and because the queue may run it twice.
 *
 * The whole thing is one transaction. A closure that deleted the sessions and
 * then failed before anonymising would leave somebody locked out of an account
 * that still carries their name and address.
 */
export async function closeAccount(input: {
  userId: string;
  /** Recorded verbatim. "requested by the owner", "support request", etc. */
  reason: string;
  /** Who asked. The owner themselves, or an operator acting for them. */
  actorId: string;
}): Promise<ClosureResult> {
  const { userId, reason, actorId } = input;

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, closedAt: true },
  });
  if (!existing) throw new Error("No such account.");

  if (existing.closedAt) {
    // ============ ALREADY DONE IS A SUCCESS ==================
    //
    // Not an error. A retry, a double-click and a redelivered job all land
    // here, and every one of them wants "yes, that account is closed" rather
    // than a failure that invites somebody to try harder.
    return {
      userId,
      closed: false,
      alreadyClosedAt: existing.closedAt,
      removed: { oauthAccounts: 0, sessions: 0, userSessions: 0, recoveryCodes: 0, passwordResetTokens: 0 },
      retained: { businesses: 0, orders: 0, reason: "already closed" },
    };
  }

  const businesses = await prisma.store.count({ where: { userId } });
  const orders = await prismaSystem.order.count({ where: { store: { userId } } });

  const removed = await prisma.$transaction(async (tx) => {
    // ---- credentials: deleted, never anonymised ------------------------
    //
    // A token has no anonymised form. Leaving a hashed password or an OAuth
    // refresh token on a closed account is leaving a way in.
    const oauthAccounts = (await tx.account.deleteMany({ where: { userId } })).count;
    const sessions = (await tx.session.deleteMany({ where: { userId } })).count;
    const userSessions = (await tx.userSession.deleteMany({ where: { userId } })).count;
    const recoveryCodes = (await tx.recoveryCode.deleteMany({ where: { userId } })).count;
    const passwordResetTokens = (await tx.passwordResetToken.deleteMany({ where: { userId } })).count;

    // ---- the person: overwritten in place ------------------------------
    await tx.user.update({
      where: { id: userId },
      data: {
        email: closedEmailFor(userId),
        name: null,
        image: null,
        password: null,
        // Two-factor state is a credential too.
        totpSecret: null,
        totpEnabledAt: null,
        emailVerified: null,
        // A referral code is a public handle somebody could look the person up
        // by. Released rather than kept.
        referralCode: null,
        // Nothing should resolve to a business through a closed account.
        activeStoreId: null,
        closedAt: new Date(),
        closureReason: reason.slice(0, 500),
      },
    });

    return { oauthAccounts, sessions, userSessions, recoveryCodes, passwordResetTokens };
  });

  // ============ AN ACT ON SOMEBODY'S ACCOUNT IS RECORDED ==========
  //
  // On the security stream, where a `webhook.replayed` or an authorization
  // denial already lives, and with the same rule: the record says what
  // happened and never carries what was erased. Recording the old email here
  // would defeat the entire operation.
  await recordSignal({
    kind: SIGNAL_KINDS.accountClosed,
    severity: "warning",
    actorKind: "user",
    actorId,
    surface: "account:closure",
    detail: { userId, reason: reason.slice(0, 200), businesses, orders, ...removed },
  });

  return {
    userId,
    closed: true,
    removed,
    retained: {
      businesses,
      orders,
      reason:
        "Businesses and their orders are the business's own records — needed for accounting, " +
        "tax, refunds, disputes and reconciliation — and carry other people's transactions.",
    },
  };
}

/**
 * Whether an account is closed.
 *
 * Read by the sign-in path. A closed account has no password and no OAuth
 * account, so it cannot authenticate anyway — this exists so the answer is a
 * deliberate one rather than an accident of having deleted the credentials.
 */
export async function isClosed(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { closedAt: true } });
  return !!user?.closedAt;
}

/** Report a closure that could not complete, without ever naming the person. */
export function reportClosureFailure(userId: string, error: unknown): void {
  reportIssue("an account closure did not complete", error, {
    subsystem: "security",
    stage: "account.closure",
    extra: { userId },
  });
}
