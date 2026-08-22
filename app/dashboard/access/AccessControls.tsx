"use client";

import { useState, useTransition } from "react";
import type { MemberRow } from "@/lib/security/members";
import { addMemberAction, changeRoleAction, removeMemberAction } from "./actions";

const INPUT =
  "rounded-lg border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50";
const BUTTON =
  "rounded-full bg-black px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-zinc-50 dark:text-black";
const QUIET =
  "rounded-full border border-black/[.08] px-3 py-1.5 text-xs transition-colors hover:bg-black/[.03] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-white/[.05]";

export function AccessControls({
  members,
  canManage,
  slug,
}: {
  members: MemberRow[];
  canManage: boolean;
  slug?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-col divide-y divide-black/[.06] dark:divide-white/[.08]">
        {members.map((member) => (
          <li key={member.userId} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
            <div>
              <p className="text-sm text-black dark:text-zinc-50">
                {member.name ?? member.email}
                {member.isOwner && <span className="ml-2 text-xs text-zinc-500">Owner</span>}
              </p>
              <p className="text-xs text-zinc-500">
                {member.email} · since {member.since.toLocaleDateString()}
              </p>
            </div>

            {/* The owner has no controls, because the owner cannot be demoted
                or removed — a business with nobody able to manage it is an
                unrecoverable state, and offering a control that refuses is
                worse than not offering one. */}
            {canManage && !member.isOwner && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className={QUIET}
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      setError("");
                      setNotice("");
                      await changeRoleAction(member.userId, member.role === "OWNER" ? "EMPLOYEE" : "OWNER", slug);
                    })
                  }
                >
                  {member.role === "OWNER" ? "Make employee" : "Make owner"}
                </button>
                <button
                  className={QUIET}
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      setError("");
                      const outcome = await removeMemberAction(member.userId, slug);
                      setNotice(
                        outcome.removed
                          ? `${member.email} no longer has access, and was signed out of ${outcome.sessionsEnded} device${outcome.sessionsEnded === 1 ? "" : "s"}.`
                          : ""
                      );
                    })
                  }
                >
                  Remove
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {canManage && (
        <form
          action={(fd) =>
            start(async () => {
              setError("");
              setNotice("");
              const outcome = await addMemberAction(fd, slug);
              if (!outcome.added) {
                setError(
                  outcome.reason === "no_such_account"
                    ? "Nobody with that email has a Genesis account yet. Ask them to sign up first, then add them here."
                    : outcome.reason === "already_a_member"
                      ? "They can already reach this business."
                      : "That's you."
                );
              } else {
                setNotice("They can reach this business now.");
              }
            })
          }
          className="flex flex-wrap items-end gap-2"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="email" className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Give someone access
            </label>
            <input id="email" name="email" type="email" placeholder="them@example.com" required className={INPUT} />
          </div>
          <select name="role" className={INPUT} defaultValue="EMPLOYEE">
            <option value="EMPLOYEE">Employee</option>
            <option value="OWNER">Owner</option>
          </select>
          <button type="submit" className={BUTTON} disabled={pending}>
            {pending ? "Adding…" : "Add"}
          </button>
        </form>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
    </div>
  );
}
