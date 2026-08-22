import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { recordSecurityEvent, describeDevice, SECURITY_EVENTS } from "@/lib/security/events";
import { standingFor, touchSession } from "@/lib/security/sessions";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { isTokenIssuedBeforePasswordChange } from "@/lib/auth/passwordReset";
import { checkSignInThrottle, recordFailedAttempt, clearAttempts } from "@/lib/auth/attemptThrottle";

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  providers: [
    // Real production bug (2026-08-07, reported by a genuine second real
    // user): "Continue with Google" silently looped back to /login with no
    // visible error. Confirmed the OAuth *initiation* itself works
    // correctly (real redirect to Google, valid client_id/redirect_uri) —
    // the likely failure is NextAuth's own default account-linking
    // behavior: if an email/password account already exists for the same
    // email as the Google account, sign-in is blocked with
    // OAuthAccountNotLinked, and (since the login page never displayed any
    // error at all until this same fix) that failure was completely
    // invisible — indistinguishable from nothing happening. Safe to allow
    // here specifically because Google verifies email ownership — the real
    // risk this flag normally protects against (an attacker registering an
    // OAuth account with someone else's unverified email to hijack an
    // existing account) doesn't apply to a provider that verifies the
    // email itself.
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials, request) => {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }
        const email = credentials.email as string;

        // Brute-force protection (2026-08-20). There was none at all before
        // this: a script could work through a password list against a known
        // address as fast as the network allowed.
        //
        // Vercel sets x-forwarded-for; the FIRST entry is the client, and the
        // rest are proxies that a caller can forge by supplying their own
        // header. Trusting a later entry would let an attacker rotate their
        // own bucket at will.
        const forwarded = request?.headers?.get?.("x-forwarded-for") ?? null;
        const ip = forwarded ? (forwarded.split(",")[0]?.trim() || null) : null;

        const userAgent = request?.headers?.get?.("user-agent") ?? null;

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
        return { ...user, device: describeDevice(userAgent) };
      },
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        // Minted only on a real sign-in (this branch), never on token
        // refresh — one id per "sitting" for the family-beta instrumentation
        // (ProductEvent.sessionInstanceId). Persists for the JWT's lifetime,
        // not per browser tab; see the v20 plan for that known tradeoff.
        token.sessionInstanceId = randomUUID();
        // The record of this sign-in, so the owner can see it and end it. Only
        // on this branch is the device knowable — the refresh branch below has
        // no request behind it, which is why `update` there never overwrites a
        // real device label with null.
        await touchSession({
          userId: user.id as string,
          sessionInstanceId: token.sessionInstanceId as string,
          device: (user as { device?: string | null }).device ?? null,
        });
        return token;
      }

      // A password reset must actually evict whoever prompted it (2026-08-20).
      //
      // Sessions are JWTs, so there is no session row to delete — a token
      // already in an attacker's hands stayed valid until it expired on its
      // own, which made "someone got into my account, I'll change my password"
      // fail at the one thing it exists to do.
      //
      // Only on token REFRESH, never on the sign-in branch above: at sign-in
      // the password was just verified, and comparing timestamps that were
      // written moments apart would sign people out of the session they are
      // in the middle of creating.
      //
      // Why an `iat` check works even though Auth.js re-issues the token on
      // every session read (jwt.js calls .setIssuedAt() with no argument, so
      // `iat` moves forward each time): the callback runs BEFORE that
      // re-encode, on the payload decoded from the cookie. So the `iat` seen
      // here is always from the holder's PREVIOUS request, and any request
      // after a password change necessarily carries one from before it. The
      // first request an evicted session makes is refused. Verified against
      // @auth/core's own lib/actions/session.js, where a null return pushes
      // sessionStore.clean() and drops the cookie — this is real eviction, not
      // a flag nothing reads.
      // AND THE SAME EVICTION, PER SESSION (Security & Trust, D1).
      //
      // The password check below is account-wide: it ends everything, including
      // the owner's own session. This is the surgical version — the owner
      // ended THIS device from their security screen, and it stops working on
      // its very next request, which is the bar the password path already set.
      //
      // "unknown" is deliberately allowed through, and getting this backwards
      // would sign out every existing user on deploy: every token minted before
      // UserSession existed carries an instance id with no row behind it.
      // Refusing those would be an outage delivered by a security feature.
      if (token.id && typeof token.sessionInstanceId === "string") {
        const standing = await standingFor(token.sessionInstanceId);
        if (standing === "revoked") return null;
        // Still in use. Recorded on the refresh branch because that is the only
        // signal a stateless session gives that somebody is still there.
        await touchSession({
          userId: token.id as string,
          sessionInstanceId: token.sessionInstanceId,
        });
      }

      if (token.id && typeof token.iat === "number") {
        const owner = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { passwordChangedAt: true },
        });
        // The units are a trap: `iat` is seconds, Date is milliseconds.
        // isTokenIssuedBeforePasswordChange owns that comparison and is
        // asserted in scripts/verify-password-policy.ts, because getting it
        // backwards would sign out every user on the platform at once.
        if (isTokenIssuedBeforePasswordChange(token.iat, owner?.passwordChangedAt)) {
          return null;
        }
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.sessionInstanceId = token.sessionInstanceId as string;
      }
      return session;
    },
  },
});