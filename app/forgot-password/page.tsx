import Link from "next/link";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
      <div className="w-full max-w-sm rounded-2xl border border-black/[.08] p-8 dark:border-white/[.145]">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Reset your password
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Enter the email on your account and we&apos;ll send you a link to reset your password.
        </p>

        <ForgotPasswordForm />

        <p className="mt-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
          <Link href="/login" className="font-medium text-black dark:text-zinc-50">
            Back to login
          </Link>
        </p>
      </div>
    </div>
  );
}
