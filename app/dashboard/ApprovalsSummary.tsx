import Link from "next/link";
import type { PendingApproval } from "@/lib/dashboard/pendingApprovals";
import { ACTION_SECTIONS } from "@/lib/execution/genesisActions";

// Home's view of pending approvals: "does my business need me?" — so the
// count and the one-line summaries stay here, but the actual Approve/
// Reject/Regenerate controls (and diffs) only render on each approval's
// owning section (see ApprovalRequestsPanel.tsx usage on Website/Marketing/
// Products). Every item deep-links out rather than duplicating management
// UI, per the same principle the rest of this cleanup follows.
export function ApprovalsSummary({ approvals }: { approvals: PendingApproval[] }) {
  if (approvals.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-col gap-2.5">
      {approvals.map((approval) => {
        const section = ACTION_SECTIONS[approval.actionType];
        return (
          <li key={approval.id} className="flex items-center justify-between gap-3">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{approval.summary}</p>
            {section && (
              <Link
                href={section.href}
                className="shrink-0 text-xs font-medium text-[var(--brand-accent,#2563eb)] underline"
              >
                Review in {section.label}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
