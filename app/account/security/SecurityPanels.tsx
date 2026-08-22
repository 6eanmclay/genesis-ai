"use client";

import { useState, useTransition } from "react";
import {
  confirmPasswordAction,
  beginSetupAction,
  enableAction,
  disableAction,
  regenerateAction,
  endSessionAction,
  endOtherSessionsAction,
} from "./actions";
import type { ListedSession } from "@/lib/security/sessions";
import type { SecurityHistoryEntry } from "@/lib/security/events";

// The interactive half of Account Security. The page itself is a server
// component and does the reading; this does the asking.

const CARD = "rounded-lg border border-black/[.08] p-5 dark:border-white/[.145]";
const LABEL = "text-xs font-medium uppercase tracking-wide text-zinc-500";
const INPUT =
  "rounded-lg border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50";
const BUTTON =
  "rounded-full bg-black px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-zinc-50 dark:text-black";
const QUIET =
  "rounded-full border border-black/[.08] px-4 py-2 text-sm transition-colors hover:bg-black/[.03] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-white/[.05]";

/**
 * Recovery codes, shown exactly once.
 *
 * The copy says so plainly, because it is true and because an owner who
 * assumes they can come back for them later is the owner who gets locked out.
 */
function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="rounded-lg border border-amber-400/40 bg-amber-400/[.07] p-4">
      <p className="text-sm font-medium text-black dark:text-zinc-50">
        Save these now — you won&apos;t see them again.
      </p>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        Each one signs you in once if you lose your phone. Keep them somewhere that isn&apos;t your phone.
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm tabular-nums text-black dark:text-zinc-50">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
    </div>
  );
}

export function TwoFactorPanel({
  enabled,
  confirmed,
  recoveryCodesRemaining,
}: {
  enabled: boolean;
  confirmed: boolean;
  recoveryCodesRemaining: number;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const run = (fn: () => Promise<void>) =>
    start(async () => {
      setError("");
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      }
    });

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-black dark:text-zinc-50">Two-factor authentication</h2>
          <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
            {enabled
              ? "On. Signing in needs a code from your authenticator app as well as your password."
              : "Off. Anyone with your password can sign in to your business."}
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide ${
            enabled
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
              : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
          }`}
        >
          {enabled ? "On" : "Off"}
        </span>
      </div>

      {enabled && (
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          {recoveryCodesRemaining} recovery code{recoveryCodesRemaining === 1 ? "" : "s"} left.
          {recoveryCodesRemaining <= 2 && (
            <span className="text-amber-700 dark:text-amber-400">
              {" "}
              Generate a new set before you run out.
            </span>
          )}
        </p>
      )}

      {!confirmed && (
        <p className="mt-4 text-sm text-zinc-500">Confirm your password above to change this.</p>
      )}

      {confirmed && !enabled && !setup && (
        <button className={`${BUTTON} mt-4`} disabled={pending} onClick={() => run(async () => {
          setSetup(await beginSetupAction());
        })}>
          {pending ? "Starting…" : "Turn on two-factor authentication"}
        </button>
      )}

      {confirmed && setup && !enabled && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Add this to your authenticator app, then enter the code it shows.
          </p>
          {/* The secret in text as well as a link. Not every phone can scan
              from the screen it is signed in on, and an owner setting this up
              on the same device has no second camera. */}
          <p className={LABEL}>Setup key</p>
          <p className="break-all font-mono text-sm text-black dark:text-zinc-50">{setup.secret}</p>
          <form
            action={(fd) =>
              run(async () => {
                const outcome = await enableAction(fd);
                if (outcome.enabled) {
                  setCodes(outcome.recoveryCodes);
                  setSetup(null);
                } else {
                  setError(
                    outcome.reason === "incorrect_code"
                      ? "That code didn't work. Codes change every 30 seconds — try the current one."
                      : "Start the setup again."
                  );
                }
              })
            }
            className="flex flex-wrap items-end gap-2"
          >
            <div className="flex flex-col gap-1">
              <label htmlFor="token" className={LABEL}>
                Code from your app
              </label>
              <input id="token" name="token" inputMode="numeric" placeholder="123456" className={INPUT} required />
            </div>
            <button type="submit" className={BUTTON} disabled={pending}>
              {pending ? "Checking…" : "Verify and turn on"}
            </button>
          </form>
        </div>
      )}

      {codes && (
        <div className="mt-4">
          <RecoveryCodes codes={codes} />
        </div>
      )}

      {confirmed && enabled && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button className={QUIET} disabled={pending} onClick={() => run(async () => {
            setCodes(await regenerateAction());
          })}>
            Generate new recovery codes
          </button>
          <button className={QUIET} disabled={pending} onClick={() => run(async () => {
            await disableAction();
            setCodes(null);
          })}>
            Turn off
          </button>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </section>
  );
}

export function ConfirmPanel({ confirmed }: { confirmed: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState("");

  if (confirmed) {
    return (
      <section className={CARD}>
        <h2 className="text-base font-semibold text-black dark:text-zinc-50">Password confirmed</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          You can change your security settings for the next few minutes.
        </p>
      </section>
    );
  }

  return (
    <section className={CARD}>
      <h2 className="text-base font-semibold text-black dark:text-zinc-50">Confirm your password</h2>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        Being signed in isn&apos;t proof this is you. Confirm your password before changing how your
        account is protected.
      </p>
      <form
        action={(fd) =>
          start(async () => {
            setError("");
            const outcome = await confirmPasswordAction(fd);
            if (!outcome.confirmed) {
              setError(
                outcome.reason === "no_password"
                  ? "This account signs in with Google, so there's no password to confirm."
                  : "That password didn't match."
              );
            }
          })
        }
        className="mt-4 flex flex-wrap items-end gap-2"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="password" className={LABEL}>
            Password
          </label>
          <input id="password" name="password" type="password" autoComplete="current-password" className={INPUT} required />
        </div>
        <button type="submit" className={BUTTON} disabled={pending}>
          {pending ? "Checking…" : "Confirm"}
        </button>
      </form>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </section>
  );
}

export function SessionsPanel({
  available,
  sessions,
}: {
  available: boolean;
  sessions: ListedSession[];
}) {
  const [pending, start] = useTransition();

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-black dark:text-zinc-50">Where you&apos;re signed in</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Ending a session signs that device out the next time it does anything.
          </p>
        </div>
        {sessions.length > 1 && (
          <button className={QUIET} disabled={pending} onClick={() => start(async () => { await endOtherSessionsAction(); })}>
            Sign out everywhere else
          </button>
        )}
      </div>

      {/* TWO SILENCES ARE NOT THE SAME SILENCE. "You are signed in nowhere
          else" is the worst possible wrong answer for somebody checking
          whether an intruder is in their account. */}
      {!available ? (
        <p className="mt-4 text-sm text-amber-700 dark:text-amber-400">
          We can&apos;t show your sessions right now. This is a problem on our side — try again shortly.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-black/[.06] dark:divide-white/[.08]">
          {sessions.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
              <div>
                <p className="text-sm text-black dark:text-zinc-50">
                  {session.device ?? "Unrecognised device"}
                  {session.current && <span className="ml-2 text-xs text-zinc-500">This device</span>}
                </p>
                <p className="text-xs text-zinc-500">
                  Last used {session.lastSeenAt.toLocaleString()}
                </p>
              </div>
              {!session.current && (
                <button
                  className={QUIET}
                  disabled={pending}
                  onClick={() => start(async () => { await endSessionAction(session.sessionInstanceId); })}
                >
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HistoryPanel({
  available,
  entries,
}: {
  available: boolean;
  entries: SecurityHistoryEntry[];
}) {
  return (
    <section className={CARD}>
      <h2 className="text-base font-semibold text-black dark:text-zinc-50">Recent security activity</h2>
      {!available ? (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
          We can&apos;t show your history right now. This is a problem on our side — try again shortly.
        </p>
      ) : entries.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">Nothing has happened on this account yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-black/[.06] dark:divide-white/[.08]">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-3 py-2.5 first:pt-0">
              <p className={`text-sm ${entry.noteworthy ? "text-black dark:text-zinc-50" : "text-zinc-600 dark:text-zinc-400"}`}>
                {entry.label}
                {entry.device && <span className="ml-2 text-xs text-zinc-500">{entry.device}</span>}
              </p>
              <p className="text-xs tabular-nums text-zinc-500">{entry.createdAt.toLocaleString()}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
