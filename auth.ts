import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

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
      authorize: async (credentials) => {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email as string },
        });

        if (!user || !user.password) {
          return null;
        }

        const isValid = await bcrypt.compare(
          credentials.password as string,
          user.password
        );

        if (!isValid) {
          return null;
        }

        return user;
      },
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        // Minted only on a real sign-in (this branch), never on token
        // refresh — one id per "sitting" for the family-beta instrumentation
        // (ProductEvent.sessionInstanceId). Persists for the JWT's lifetime,
        // not per browser tab; see the v20 plan for that known tradeoff.
        token.sessionInstanceId = randomUUID();
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