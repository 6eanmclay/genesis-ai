import { NextResponse } from "next/server";
import { generateStoreDraftForApi } from "@/app/dashboard/ai-actions";
import { auth } from "@/auth";
import { checkRateLimit } from "@/lib/http/rateLimit";

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
  // ============ A LIMIT, NOT VALIDATION (2026-08-30) ================
  //
  // Authorization and the shape of this form are both settled inside
  // generateStoreDraftForApi, which re-derives identity from auth() and is the
  // authority on what a draft needs — validating the form again here would be a
  // second answer to one question.
  //
  // What nothing answered is cost. Every call is a model generation that runs
  // for around a hundred seconds, and lib/genesisModel.ts's daily token ceiling
  // caps the spend per day rather than the rate. A signed-in caller could start
  // them in a loop and hold that many functions open at once.
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const limited = await checkRateLimit(
    [{ kind: "storeDraft:user", value: session.user.id!, max: 20, windowMs: 60 * 60 * 1000 }],
    { surface: "generateStoreDraft", actorId: session.user.id },
  );
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "That is too many generations for now. Try again shortly." },
      { status: 429, headers: limited.retryAfterSeconds ? { "retry-after": String(limited.retryAfterSeconds) } : undefined },
    );
  }

  const formData = await request.formData();
  const result = await generateStoreDraftForApi(formData);

  if (!result.ok) {
    const status = result.error === "Not signed in" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ ok: true, storeName: result.storeName, storeConfirmed: result.storeConfirmed });
}
