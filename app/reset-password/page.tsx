import Link from "next/link";
import { ResetPasswordForm } from "./ResetPasswordForm";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
      <div className="w-full max-w-sm rounded-2xl border border-black/[.08] p-8 dark:border-white/[.145]">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Choose a new password
        </h1>

        {token ? (
          <>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              Enter a new password for your account.
            </p>
            <ResetPasswordForm token={token} />
          </>
        ) : (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">
            This link is missing its reset token — please use the link from your email, or{" "}
            <Link href="/forgot-password" className="underline">
              request a new one
            </Link>
            .
          </p>
        )}

        <p className="mt-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
          <Link href="/login" className="font-medium text-black dark:text-zinc-50">
            Back to login
          </Link>
        </p>
      </div>
    </div>
  );
}
