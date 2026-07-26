import type { ReactNode } from "react";
import type { ExecutionStatus } from "@/lib/execution/types";
import { STATUS_DOT } from "@/lib/execution/statusDisplay";

const STATUS_LABEL: Record<ExecutionStatus, string> = {
  SUCCESS: "Connected",
  WARNING: "Needs attention",
  FAILED: "Failed",
  PENDING: "In progress",
  PARTIAL: "Partially completed",
};

interface ExecutionLogDisplay {
  status: string;
  message: string;
  verified: boolean;
  createdAt: Date;
  retryable: boolean;
}

// Renders the most recent ExecutionLog row for one action (or a
// pre-PH-03-compatible fallback — see app/dashboard/page.tsx) as a status
// card: colored dot, label, message, and whether it was independently
// verified. `retryable` drives whether the caller's action buttons make
// sense to show as "try again" — this component doesn't render buttons
// itself, the caller passes its existing form buttons as `actions`.
export function ExecutionStatusCard({
  title,
  log,
  actions,
}: {
  title: string;
  log: ExecutionLogDisplay | null;
  actions: ReactNode;
}) {
  const status = (log?.status as ExecutionStatus) ?? "PENDING";

  return (
    <div className="mt-4 max-w-md rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[status]}`} />
        <p className="font-medium text-black dark:text-zinc-50">
          {title} — {STATUS_LABEL[status]}
        </p>
      </div>
      {log && (
        <>
          <p className="mt-1 text-xs text-zinc-500">
            {log.message}
            {log.verified ? " (verified)" : ""} — {log.createdAt.toLocaleString()}
          </p>
        </>
      )}
      <div className="mt-3 flex flex-wrap gap-3">{actions}</div>
    </div>
  );
}
