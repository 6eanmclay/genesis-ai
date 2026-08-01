import { NextResponse } from "next/server";
import { generateStoreDraftForApi } from "@/app/dashboard/ai-actions";

// What CreateStoreForm.tsx's client-driven progress UI actually calls —
// see generateStoreDraftCore's own comment in ai-actions.ts for why this
// is a plain Route Handler rather than the generateStoreDraft Server
// Action: a Server Action invoked programmatically must be wrapped in
// startTransition, which defers committing the whole tree (including
// sibling state set outside the transition) until the action's own
// promise settles — confirmed live, this silently prevented the progress
// panel from ever painting for the ~110s a real generation call is in
// flight. A plain fetch() has no such coupling. Auth itself is handled
// inside generateStoreDraftForApi (a plain, safe-to-export function that
// independently re-derives identity from auth() — see its comment).
export async function POST(request: Request) {
  const formData = await request.formData();
  const result = await generateStoreDraftForApi(formData);

  if (!result.ok) {
    const status = result.error === "Not signed in" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ ok: true, storeName: result.storeName, storeConfirmed: result.storeConfirmed });
}
