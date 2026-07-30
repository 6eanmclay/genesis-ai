"use client";

import { useActionState } from "react";
import type { ActionState } from "@/lib/actionState";

const INITIAL_STATE: ActionState = { ok: true };

// The reusable wrapper for "a form whose action returns ActionState instead
// of throwing" — the client-side half of the standard error-handling
// pattern (see lib/actionState.ts). Any action passed here must accept
// (prevState, formData) as its final two parameters, composing cleanly
// with this codebase's existing .bind(null, id) currying convention.
//
// Plain ReactNode children only — NOT a render-prop. A render-prop
// (children as a function) can't cross the server→client boundary when
// this component is used directly from a Server Component (React Server
// Components can only serialize plain elements/data as props, not
// arbitrary functions — confirmed live: passing one throws "Functions are
// not valid as a child of Client Components"). Forms that need to echo a
// failed submission's values back into their own fields (see
// lib/actionState.ts's `values`) use their own small dedicated client
// component instead (e.g. products/CreateProductForm.tsx) rather than
// relying on this generic wrapper to expose state outward.
export function ActionForm({
  action,
  children,
  className,
}: {
  action: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, INITIAL_STATE);
  return (
    <form action={formAction} className={className}>
      {children}
      {!state.ok && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{state.error}</p>}
    </form>
  );
}
