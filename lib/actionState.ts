// The standard error-handling pattern for ordinary Server Actions, going
// forward: recoverable business errors (validation, missing integrations,
// permissions) surface as calm inline guidance; unexpected system failures
// are logged internally and shown a generic, reassuring message that never
// exposes implementation details. Generalizes the same shape
// lib/genesisModel.ts's genesisModelFailureMessage already proved out for
// classifying Anthropic-specific errors, for ordinary Server Actions.
//
// `values` echoes back the submitted form fields on failure — required
// because React 19 automatically resets every uncontrolled field once a
// form action settles, success or failure alike (its own documented
// behavior, not something this app can opt out of at the form level). Only
// ActionForm's remount-via-key mechanism actually restores them; this is
// just the data half of that fix.
export type ActionState =
  | { ok: true }
  | { ok: false; error: string; values?: Record<string, string> };

// Thrown by a Server Action for a condition that is real, anticipated, and
// safe to show the user verbatim. Anything else thrown is treated as
// unexpected and never shown to the user.
export class RecoverableError extends Error {}

const GENERIC_FAILURE_MESSAGE =
  "Something went wrong on our end. Please try again, and let us know if this keeps happening.";

export function toActionState(error: unknown, formData?: FormData): ActionState {
  const values = formData
    ? Object.fromEntries(
        [...formData.entries()].filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      )
    : undefined;

  if (error instanceof RecoverableError) {
    return { ok: false, error: error.message, values };
  }
  console.error("[action-error]", error);
  return { ok: false, error: GENERIC_FAILURE_MESSAGE, values };
}
