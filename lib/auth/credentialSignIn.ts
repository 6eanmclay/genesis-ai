import bcrypt from "bcryptjs";
import { recordSecurityEvent, describeDevice, SECURITY_EVENTS } from "@/lib/security/events";
import { isTwoFactorEnabled, verifySecondFactor } from "@/lib/security/twoFactor";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/auth/normalizeEmail";
import { checkSignInThrottle, recordFailedAttempt, clearAttempts } from "@/lib/auth/attemptThrottle";

// ONE SIGN-IN CHECK, TWO DOORS (2026-09-27).
//
// This is the body of the credentials provider's `authorize` in auth.ts, moved
// here unchanged so the J4 phone app's sign-in route runs the SAME checks in the
// SAME order: throttle, password, second factor, history. MOBILE_SIGN_IN_CONTRACT.md
// is explicit that the phone calls the website's security code and never keeps
// a copy of it — two copies of a lockout are two lockouts that drift apart.
//
// The only thing that changed in the move is where the headers come from:
// NextAuth hands authorize a Request, the mobile route has its own. Both pass
// their headers here.

export interface CredentialInput {
  email?: unknown;
  password?: unknown;
  /** The second factor, when the person typed one. */
  token?: unknown;
}

/** Just enough of Headers to read two of them — NextAuth's request may be partial. */
export interface HeaderSource {
  get?: (name: string) => string | null;
}

/**
 * Is this a real, fully authenticated sign-in? The signed-in user, or null for
 * every refusal alike.
 *
 * Returns the user with the coarse `device` label and whether 2FA is on — the
 * shape auth.ts's jwt callback has always received from authorize.
 */
export async function verifyCredentialSignIn(credentials: CredentialInput | undefined, headers: HeaderSource | undefined) {
  if (!credentials?.email || !credentials?.password) {
    return null;
  }
  // NORMALISED ONCE, HERE, and every lookup below uses this value.
  // Both the throttle lookup and the sign-in lookup were literal, so
  // an account could be reached only with the capitalisation its
  // owner first typed. See lib/auth/normalizeEmail.ts for why both
  // sides could finally change together.
  const email = normalizeEmail(credentials.email as string);

  // Brute-force protection (2026-08-20). There was none at all before
  // this: a script could work through a password list against a known
  // address as fast as the network allowed.
  //
  // Vercel sets x-forwarded-for; the FIRST entry is the client, and the
  // rest are proxies that a caller can forge by supplying their own
  // header. Trusting a later entry would let an attacker rotate their
  // own bucket at will.
  const forwarded = headers?.get?.("x-forwarded-for") ?? null;
  const ip = forwarded ? (forwarded.split(",")[0]?.trim() || null) : null;

  const userAgent = headers?.get?.("user-agent") ?? null;

  const { throttled, buckets } = await checkSignInThrottle({ email, ip });
  if (throttled) {
    // Recorded against the account when one exists. An attacker
    // hammering an address the owner really owns is exactly what the
    // owner needs to see in their own history.
    //
    // No event at all for an address with no account: there is nobody to
    // tell, and writing one would let anyone who can guess addresses grow
    // this table.
    const throttledUser = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (throttledUser) {
      await recordSecurityEvent({
        userId: throttledUser.id,
        kind: SECURITY_EVENTS.signInBlocked,
        userAgent,
      });
    }
    // Deliberately the same `null` as a wrong password. A distinct
    // "too many attempts" response would confirm the address exists and
    // is worth attacking — and this path is reached by addresses that
    // have no account at all.
    return null;
  }

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.password) {
    await recordFailedAttempt(buckets);
    return null;
  }

  const isValid = await bcrypt.compare(
    credentials.password as string,
    user.password
  );

  if (!isValid) {
    await recordFailedAttempt(buckets);
    // A real account, a real wrong password. This is the line an owner
    // reads when they want to know whether somebody has been trying.
    await recordSecurityEvent({
      userId: user.id,
      kind: SECURITY_EVENTS.signInFailed,
      userAgent,
    });
    return null;
  }

  // THE SECOND FACTOR, AND IT IS NOT BYPASSABLE (Security & Trust, D6).
  //
  // Enforced HERE, in authorize, because this is the single gate every
  // credential sign-in passes through — there is no partially
  // authenticated state that can read anything, no "skip for now", and no
  // query parameter that reaches past it. A session simply does not exist
  // until the factor is satisfied.
  //
  // The password has already been verified at this point, so a missing or
  // wrong code is refused with the SAME null as a wrong password. A
  // distinct answer would confirm to somebody holding a stolen password
  // that they had the right one and only needed the phone.
  if (await isTwoFactorEnabled(user.id)) {
    const token = typeof credentials.token === "string" ? credentials.token : "";
    if (!token) {
      // Cleared deliberately: the password WAS right, so leaving failed
      // attempts against it would lock an owner out for going to fetch
      // their phone.
      await clearAttempts(buckets);
      return null;
    }
    const challenge = await verifySecondFactor({ userId: user.id, token, userAgent });
    if (!challenge.passed) {
      await recordFailedAttempt(buckets);
      return null;
    }
  }

  // Cleared on success, so someone who mistypes nine times and then gets
  // it right is not left one slip away from a lockout for the next
  // quarter of an hour.
  await clearAttempts(buckets);
  // The sign-in itself. Recorded here rather than in the jwt callback
  // because this is the only place that holds the request, and therefore
  // the only place that can say which device it came from.
  await recordSecurityEvent({
    userId: user.id,
    kind: SECURITY_EVENTS.signedIn,
    userAgent,
  });
  // The device travels to the jwt callback on the returned user, because
  // that callback has no request of its own and this is the only bridge
  // NextAuth gives between them. Reduced to the coarse label here — the
  // raw agent never leaves this function.
  return { ...user, device: describeDevice(userAgent), twoFactor: await isTwoFactorEnabled(user.id) };
}
