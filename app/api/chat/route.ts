import { auth } from "@/auth";
import { streamChatTurn, type ChatTurnBody } from "@/lib/j4/chatTurn";

// THE WEBSITE'S DOOR TO J4.
//
// The turn itself lives in lib/j4/chatTurn.ts, shared with the J4 phone app's
// /api/mobile/v1/chat (MOBILE_CHAT_CONTRACT.md D1). This route answers one
// question — which signed-in browser is asking — and hands over.
//
// Streaming, caching and duration settings stay here, because they are
// properties of the route Next serves, not of the turn.
export const maxDuration = 300;
// Real production bug (2026-08-07) — a purely conversational message got
// misrouted into the heavy fallback path; while diagnosing it, verified
// there's no accidental buffering in this route's own code but added this
// defensively anyway, so Next.js never applies any static-optimization/caching
// path to a route that must always stream fresh, per-request output.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const turnStartedAt = Date.now();
  const body = (await request.json().catch(() => null)) as ChatTurnBody;
  const requestId = body?.requestId ?? "unknown";
  console.log(`[genesis-chat-diag] side=server requestId=${requestId} event=request_received tMs=0 meta={}`);

  const session = await auth();
  if (!session?.user) {
    console.log(`[genesis-chat-diag] side=server requestId=${requestId} event=auth_failed tMs=${Date.now() - turnStartedAt} meta={}`);
    return new Response(JSON.stringify({ type: "error", message: "Not signed in." }), { status: 401 });
  }

  return streamChatTurn({
    userId: session.user.id,
    sessionInstanceId: session.user.sessionInstanceId,
    body,
    turnStartedAt,
  });
}
