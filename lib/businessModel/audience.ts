import { prisma } from "@/lib/prisma";

// M8 (2026-08-19) — J4 can see interest, not just purchases.
//
// THE GAP. NewsletterSignup is written by the LIVE STOREFRONT
// (app/store/[slug]/actions.ts) — a real stranger typing their email into a
// real store — and was read by exactly one dashboard page. It reached neither
// BusinessProfile nor the chat payload nor any insight.
//
// And contacts are derived from ORDERS ONLY (internalMapper's
// deriveContactsFromOrders), so J4's entire notion of "customer" is built from
// purchases. Someone who gave the business their email but hasn't bought did
// not exist in J4's understanding at all.
//
// For a pre-revenue store that is not a minor omission. A signup is the only
// evidence a real stranger wanted something. J4 looking at 14 subscribers and
// no sales could only say "you have no customers" — true, and deeply
// misleading.
//
// SUBSCRIBERS ARE NOT CUSTOMERS, and this file keeps them apart on purpose.
// Nothing here is merged into contact records, counted toward revenue or
// orders, or fed into getCustomerSegments/getTopContacts. Blending the two
// would change the canonical contact model and quietly restate "someone is
// interested" as "someone bought".
//
// COUNTS AND TIMESTAMPS ONLY, per Sean's decision. No email addresses leave the
// database: the question is "is anyone interested and when", which addresses do
// not answer, and Genesis cannot email them anyway while the Marketing Engine's
// own real-Resend dependency is unresolved.
//
// NO RATES, NO WINDOWS, NO THRESHOLD. Raw signup timestamps are handed over so
// J4 judges the pace in conversation. A "signups per week" figure or a
// "growth is slowing" flag would be a detector wearing a different hat, which
// this milestone deliberately is not.

/** Enough recent timestamps to see a pattern, bounded so a prompt stays sane. */
const RECENT_SIGNUP_LIMIT = 20;

export interface Audience {
  /** Real rows, all time. Never an estimate. */
  subscriberCount: number;
  /** Null when nobody has ever signed up — not a date, and not "never". */
  firstSignupAt: string | null;
  mostRecentSignupAt: string | null;
  /**
   * Signup times, newest first, capped at RECENT_SIGNUP_LIMIT. The raw material
   * for judging pace — deliberately not summarised into a rate here.
   */
  recentSignupsAt: string[];
  /** Whole days since the last signup. Null when there has never been one. */
  daysSinceMostRecent: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SignupRow {
  createdAt: Date;
}

/**
 * The audience picture — pure, so honest emptiness is directly testable.
 *
 * `now` is injected rather than read, so "days since" is a provable number.
 */
export function planAudience(params: { signups: SignupRow[]; now: Date }): Audience {
  const { signups, now } = params;

  if (signups.length === 0) {
    // Nobody has signed up. That is an absence of evidence, and it is reported
    // as exactly that — never as "no interest", which is a conclusion this
    // data cannot support.
    return {
      subscriberCount: 0,
      firstSignupAt: null,
      mostRecentSignupAt: null,
      recentSignupsAt: [],
      daysSinceMostRecent: null,
    };
  }

  const sorted = [...signups].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const mostRecent = sorted[0].createdAt;
  const first = sorted[sorted.length - 1].createdAt;

  return {
    // The true total, independent of how many timestamps are carried below.
    subscriberCount: signups.length,
    firstSignupAt: first.toISOString(),
    mostRecentSignupAt: mostRecent.toISOString(),
    recentSignupsAt: sorted.slice(0, RECENT_SIGNUP_LIMIT).map((s) => s.createdAt.toISOString()),
    // Clamped at zero: a clock skew must never produce a negative wait.
    daysSinceMostRecent: Math.max(0, Math.floor((now.getTime() - mostRecent.getTime()) / DAY_MS)),
  };
}

/**
 * The database-facing half.
 *
 * Selects `createdAt` and nothing else — no email address is read at all, so
 * none can reach a prompt. Data that is never fetched cannot leak.
 */
export async function getAudience(storeId: string): Promise<Audience> {
  const signups = await prisma.newsletterSignup.findMany({
    where: { storeId },
    select: { createdAt: true },
  });
  return planAudience({ signups, now: new Date() });
}
