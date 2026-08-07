"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";

// useSearchParams() requires a Suspense boundary for static generation
// (confirmed live via a real next build failure) — this page was
// previously fully static with no params to read at all; the ?reset=
// success flash (2026-08-07) is the first thing here that needs one.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

// Real production bug (2026-08-07) — every NextAuth sign-in error
// (including a real OAuth failure) was silently redirecting back to this
// page with an "?error=" param that nothing ever read — indistinguishable
// from clicking "Continue with Google" and having nothing happen. Spoken,
// not logged (Genesis Experience Principle 1): a raw NextAuth error code
// is never shown verbatim.
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  OAuthAccountNotLinked:
    "That Google account's email is already registered a different way. Try logging in with your email and password instead.",
  AccessDenied: "That sign-in was cancelled or denied.",
};
const DEFAULT_OAUTH_ERROR_MESSAGE = "Something went wrong signing in with Google. Please try again.";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const justReset = searchParams.get("reset") === "success";
  const oauthErrorCode = searchParams.get("error");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(
    oauthErrorCode ? (OAUTH_ERROR_MESSAGES[oauthErrorCode] ?? DEFAULT_OAUTH_ERROR_MESSAGE) : ""
  );
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (result?.error) {
      setError("Invalid email or password");
      setLoading(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
      <div className="w-full max-w-sm rounded-2xl border border-black/[.08] p-8 dark:border-white/[.145]">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Welcome back
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Log in to continue building with Genesis AI.
        </p>
        {/* Reassurance for anyone who got signed out unexpectedly (session
            expiry, a private/incognito tab, an in-app browser closing) —
            see memory/project_beta_readiness_audit.md's mobile-logout
            investigation. Nothing here is ever lost: StoreDraft/Store rows
            persist independently of the session, so signing back in always
            picks up exactly where things were left. */}
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
          If you were signed out, don&apos;t worry — your business and
          progress are saved. Signing back in picks up right where you left
          off.
        </p>

        {justReset && (
          <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300">
            Your password has been reset. Log in with your new password.
          </p>
        )}

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
          <input
            type="email"
            placeholder="Email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
          />
          <div className="flex flex-col gap-1.5">
            <input
              type="password"
              placeholder="Password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
            />
            <Link href="/forgot-password" className="self-end text-xs text-zinc-500 underline hover:text-black dark:hover:text-zinc-50">
              Forgot password?
            </Link>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="mt-2 rounded-full bg-foreground px-5 py-2 text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {loading ? "Logging in..." : "Log in"}
          </button>
        </form>

        <div className="mt-4 flex items-center gap-3">
          <div className="h-px flex-1 bg-black/[.08] dark:bg-white/[.145]" />
          <span className="text-xs text-zinc-500">or</span>
          <div className="h-px flex-1 bg-black/[.08] dark:bg-white/[.145]" />
        </div>

        <button
          onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
          className="mt-4 w-full rounded-full border border-black/[.08] px-5 py-2 text-black transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-[#1a1a1a]"
        >
          Continue with Google
        </button>

        <p className="mt-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="font-medium text-black dark:text-zinc-50">
            Sign up
          </Link>
        </p>

        <p className="mt-4 text-center text-xs text-zinc-500">
          <Link href="/terms" className="underline">
            Terms of Service
          </Link>{" "}
          &middot;{" "}
          <Link href="/privacy" className="underline">
            Privacy Policy
          </Link>
        </p>
      </div>
    </div>
  );
}