import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { standingFor, touchSession } from "@/lib/security/sessions";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { isTokenIssuedBeforePasswordChange } from "@/lib/auth/passwordReset";
import { verifyCredentialSignIn } from "@/lib/auth/credentialSignIn";

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
        // The second factor, sent by the login form only when the account has
        // one. Absent for every account without 2FA, which is the majority.
        token: { label: "Authentication code", type: "text" },
      },
      // The checks themselves live in lib/auth/credentialSignIn.ts, shared
      // with the J4 phone app's sign-in route so the two doors cannot drift.
      authorize: (credentials, request) => verifyCredentialSignIn(credentials, request?.headers),
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
        // D2, approved: the claim lives in the JWT, so it inherits the
        // revocation path for free rather than costing a database read on every
        // authenticated request to answer a question that cannot change
        // mid-session. Reaching this branch at all means the factor was
        // satisfied in authorize — a session is never minted without it.
        token.twoFactorVerified = (user as { twoFactor?: boolean }).twoFactor === true;
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