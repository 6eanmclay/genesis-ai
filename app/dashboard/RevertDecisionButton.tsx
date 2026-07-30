"use client";

import type { ActionState } from "@/lib/actionState";
import { ActionForm } from "./ActionForm";
import { SubmitButton } from "./SubmitButton";

// Small client island (same pattern as MobileNav/GenesisAssistant) so a
// single revert button in a server-rendered list can carry its own inline
// error state without converting the whole page/panel to a client
// component.
export function RevertDecisionButton({
  action,
}: {
  action: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  return (
    <ActionForm action={action} className="mt-2">
      <SubmitButton
        pendingText="Reverting..."
        className="rounded-full border border-black/[.08] px-3 py-1 text-xs text-zinc-600 transition-colors hover:bg-black/[.03] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.05]"
      >
        Revert
      </SubmitButton>
    </ActionForm>
  );
}
