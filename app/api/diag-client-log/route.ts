import { auth } from "@/auth";

// Temporary production diagnostic endpoint (2026-08-08) — the client-side
// half of tracing the real iPhone/Safari chat streaming failure. Accepts
// timestamped client-side milestone events (via navigator.sendBeacon,
// chosen specifically because it's designed to survive the exact
// conditions under investigation — backgrounding, navigation, page
// teardown — where a normal fetch() would be aborted) and logs them so
// they show up in `vercel logs` correlated against app/api/chat/route.ts's
// own server-side diagLog() calls via a shared requestId. No PII, just
// event names and timestamps. Delete once the real failing layer is found
// and fixed — not meant to ship long-term.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return new Response(null, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { requestId?: string; event?: string; tMs?: number; meta?: Record<string, unknown> }
    | null;
  if (!body?.requestId || !body?.event) return new Response(null, { status: 400 });

  console.log(
    `[genesis-chat-diag] side=client requestId=${body.requestId} event=${body.event} tMs=${body.tMs ?? "n/a"} meta=${JSON.stringify(body.meta ?? {})}`
  );

  return new Response(null, { status: 204 });
}
