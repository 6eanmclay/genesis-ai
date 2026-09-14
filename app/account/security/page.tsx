import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { getSecurityHistory } from "@/lib/security/events";
import { listSessions } from "@/lib/security/sessions";
import { isTwoFactorEnabled, countUnusedRecoveryCodes } from "@/lib/security/twoFactor";
import { hasFreshConfirmation, hasConfirmablePassword } from "@/lib/security/reauthentication";
import { ConfirmPanel, TwoFactorPanel, SessionsPanel, HistoryPanel } from "./SecurityPanels";

// ACCOUNT SECURITY — the one home for everything this milestone built.
//
// ACCOUNT-SCOPED, AND DELIBERATELY NOT UNDER /dashboard OR /b/[slug]. An
// account with three businesses has one password, one set of sessions and one
// sign-in history; hanging this off a business would have made "who is signed
// in as me" a per-business question, which it is not. Same reasoning that put
// SecurityEvent in its own table rather than in ExecutionLog.
//
// Everything here reads. The asking lives in SecurityPanels.tsx, and every
// action it calls goes through the single guard in actions.ts.

export const metadata = { title: "Account security" };

export default async function AccountSecurityPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;
  const currentSessionInstanceId =
    (session.user as { sessionInstanceId?: string }).sessionInstanceId ?? null;

  // WHETHER THERE IS A PASSWORD TO CONFIRM AT ALL (2026-09-13). A Google-only
  // account has none, so the confirmation gate below can never open for it —
  // and every panel that asks for one was asking for something that does not
  // exist. Read here rather than discovered by a failed attempt.
  const [enabled, confirmed, hasPassword, recoveryCodesRemaining, sessions, history] = await Promise.all([
    isTwoFactorEnabled(userId),
    hasFreshConfirmation(userId),
    hasConfirmablePassword(userId),
    countUnusedRecoveryCodes(userId),
    listSessions(userId, currentSessionInstanceId),
    getSecurityHistory(userId, 25),
  ]);

  return (
    <div className="min-h-screen bg-zinc-50 p-8 dark:bg-black">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div>
          <Link href="/dashboard" className="text-sm text-zinc-500 hover:underline">
            &larr; Back to your business
          </Link>
          <h1 className="mt-3 text-2xl font-semibold text-black dark:text-zinc-50">Account security</h1>
          <p className="mt-2 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
            This account holds your storefront, your payment connections and everything Genesis knows
            about your business. This is where you decide how well it&apos;s protected.
          </p>
        </div>

        <ConfirmPanel confirmed={confirmed} hasPassword={hasPassword} />
        <TwoFactorPanel
          enabled={enabled}
          confirmed={confirmed}
          hasPassword={hasPassword}
          recoveryCodesRemaining={recoveryCodesRemaining}
        />
        <SessionsPanel available={sessions.available} sessions={sessions.sessions} />
        <HistoryPanel available={history.available} entries={history.entries} />
      </div>
    </div>
  );
}
