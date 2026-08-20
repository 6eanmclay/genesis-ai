import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
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

        const { throttled, buckets } = await checkSignInThrottle({ email, ip });
        if (throttled) {
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
          return null;
        }

        // Cleared on success, so someone who mistypes nine times and then gets
        // it right is not left one slip away from a lockout for the next
        // quarter of an hour.
        await clearAttempts(buckets);
        return user;
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