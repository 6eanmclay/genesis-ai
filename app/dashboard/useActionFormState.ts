"use client";

import { useActionState, useState } from "react";
import type { ActionState } from "@/lib/actionState";

const INITIAL_STATE: ActionState = { ok: true };

// React 19 automatically resets every uncontrolled field once a form
// action settles, success or failure alike — its own documented behavior,
// not something a form can opt out of directly. `resetKey` forces a
// genuine remount (via `key={resetKey}` on the <form>) whenever `state`
// itself changes, which is what lets a field's defaultValue — echoed back
// from the submitted formData on failure, see lib/actionState.ts — take
// effect again instead of showing blank/stale text. Used by dedicated
// per-form client components (not the generic ActionForm, which can't
// expose state as a render-prop when rendered from a Server Component —
// React Server Components can't serialize a function as a child/prop).
export function useActionFormState(
  action: (prevState: ActionState, formData: FormData) => Promise<ActionState>
) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, INITIAL_STATE);

  const [renderedState, setRenderedState] = useState(state);
  const [resetKey, setResetKey] = useState(0);
  if (state !== renderedState) {
    setRenderedState(state);
    setResetKey((k) => k + 1);
  }

  return { state, formAction, resetKey };
}
