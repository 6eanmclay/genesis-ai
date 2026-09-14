import type { ReactNode } from "react";
import { verificationLabel } from "@/lib/execution/verification";
import type { ExecutionStatus } from "@/lib/execution/types";

interface ExecutionLogDisplay {
  status: string;
  message: string;
  verified: boolean;
  createdAt: Date;
  retryable: boolean;
}

// The most recent ExecutionLog row for one connector, AS HISTORY.
//
// ============ IT USED TO SAY WHAT WAS CURRENTLY TRUE (2026-09-13) ======
//
// This rendered `{title} — {STATUS_LABEL[log.status]}` with a state dot, and
// STATUS_LABEL mapped SUCCESS to the word "Connected". The status came from the
// newest CONNECT/VERIFY/SYNC log, so a historical success described the
// present — directly beneath ConnectionStateLine, which reads the integration
// row and is the authoritative answer. Rendered, both broken states said both
// things at once:
//
//   Google Calendar — Needs reconnection     (health, correct)
//   Google Calendar — Connected              (this card, from an old log)
//
// and the same for Failed. That is the QuickBooks case lib/integrations/
// connectionHealth.ts was written about — "14 consecutive failures, no sync
// since 2026-08-01 — read CONNECTED, showed a connected card" — with the
// judgment fixed upstream and the word still printed here.
//
// THE CONTRACT: connectionHealthOf says what IS; this says what HAPPENED. So
// the present-tense label and the state dot are gone rather than re-sourced.
// Re-sourcing them from health would have put the same word on the screen
// twice and flattened "Connected — no data received" back into "Connected",
// which is the distinction that module exists to draw.
//
// The message and its timestamp stay, and they are the valuable part: "Synced
// 3 record(s) from Google Calendar" is a real account of the last thing that
// happened, and nothing else on the card carries it.
//
// `retryable` drives whether the caller's action buttons make sense to show as
// "try again" — this component renders no buttons itself; the caller passes
// its existing forms as `actions`.
export function ExecutionStatusCard({
  title,
  log,
  actions,
}: {
  /** Kept for the caller's key/labelling; no longer rendered as a status. */
  title: string;
  log: ExecutionLogDisplay | null;
  actions: ReactNode;
}) {
  const status = (log?.status as ExecutionStatus) ?? "PENDING";

  return (
    <div className="mt-4 max-w-md rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
      {log ? (
        <p className="text-xs text-zinc-500" data-testid="connector-last-activity">
          <span className="font-medium text-zinc-600 dark:text-zinc-400">Last activity:</span>{" "}
          {log.message}
          {/* THREE STATES, not a present/absent flag. "(verified)" alone could
              not distinguish "checked and fine" from "nobody checked", which
              was true of 27 of 30 executables until this milestone. */}
          {verificationLabel(status, log.verified)
            ? ` (${verificationLabel(status, log.verified)!.toLowerCase()})`
            : ""} — {log.createdAt.toLocaleString()}
        </p>
      ) : (
        <p className="text-xs text-zinc-500" data-testid="connector-last-activity">
          No activity recorded for {title} yet.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-3">{actions}</div>
    </div>
  );
}
