"use client";

import { useState } from "react";
import { callGenesisAction } from "@/lib/dashboard/submitGenesisAction";

// Reliability hardening — regenerateApprovalImage triggers real image
// generation (measured live this session: 30-56+ seconds), the other
// confirmed long-running AI action sharing GenesisAssistant's chat-send
// vulnerability class (see lib/dashboard/submitGenesisAction.ts's own
// comment). ApprovalRequestsPanel stays a plain Server Component — only
// this one button, the one genuinely long-running action among the three
// here, needs to be a Client Component.
export function RegenerateImageButton({
  regenerateAction,
  approvalId,
}: {
  regenerateAction: (id: string) => Promise<void>;
  approvalId: string;
}) {
  const [error, setError] = useState<string | null>(null);

  async function handleRegenerate() {
    setError(null);
    const result = await callGenesisAction(() => regenerateAction(approvalId));
    if (!result.ok) setError(result.message);
  }

  return (
    <div>
      <form action={handleRegenerate}>
        <button
          type="submit"
          className="rounded-full border border-black/[.08] px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-black/[.03] dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.05]"
        >
          Regenerate
        </button>
      </form>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
