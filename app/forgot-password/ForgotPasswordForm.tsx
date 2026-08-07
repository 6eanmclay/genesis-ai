"use client";

import { useActionState } from "react";
import { requestPasswordReset, type RequestResetState } from "./actions";

const INITIAL_STATE: RequestResetState = { status: "idle" };

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, INITIAL_STATE);

  if (state.status === "success") {
    return (
      <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
        If an account exists for that email, we&apos;ve sent a link to reset your password. It expires in 1 hour.
      </p>
    );
  }

  return (
    <form action={formAction} className="mt-6 flex flex-col gap-4">
      <input
        type="email"
        name="email"
        placeholder="Email"
        required
        className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />

      {state.status === "error" && <p className="text-sm text-red-600 dark:text-red-400">{state.message}</p>}

      <button
        type="submit"
        disabled={pending}
        className="mt-2 rounded-full bg-foreground px-5 py-2 text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {pending ? "Sending..." : "Send reset link"}
      </button>
    </form>
  );
}
