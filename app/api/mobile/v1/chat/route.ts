import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "@/lib/http/guard";
import { authenticateMobile, mobileAuthFailure } from "@/lib/auth/mobileSession";
import { streamChatTurn } from "@/lib/j4/chatTurn";
import { adaptTurnForPhone, saveDeferredStorefrontEdit } from "@/lib/j4/phoneChat";

// THE PHONE'S DOOR TO J4 (MOBILE_CHAT_CONTRACT.md, approved 2026-09-27).
//
// The same turn the website runs — streamChatTurn, shared — so the model, the
// tools, the permission check per tool, the hourly limit (shared with the
// website: one account, one allowance), the 8,000-character cap and every write
// are identical by construction. This route only says who is asking and adapts
// the two website-only endings for the phone (lib/j4/phoneChat.ts).
//
// The phone always joins the main thread: no slug, no conversation id, so the
// turn resolves the account's business and the ungrouped history exactly as the
// dashboard's J4 does (D2).
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const ChatBody = z.object({
  // The turn owns the real 8,000-character rule and says so in J4's words;
  // this only stops a body too large to be worth reading.
  message: z.string().min(1).max(20_000),
  requestId: z.string().max(100).optional(),
});

export async function POST(request: Request): Promise<Response> {
  const turnStartedAt = Date.now();
  const signedIn = await authenticateMobile(request);
  if (!signedIn.ok) return mobileAuthFailure(signedIn);

  const checked = await guard(request, {
    surface: "mobile.chat",
    maxBytes: 64 * 1024,
    schema: ChatBody,
    actorId: signedIn.userId,
  });
  if (!checked.ok) return checked.response;
  const { message, requestId } = checked.body;

  const turn = await streamChatTurn({
    userId: signedIn.userId,
    sessionInstanceId: signedIn.sessionInstanceId,
    body: { message, requestId },
    turnStartedAt,
  });

  // A refusal before the stream starts (empty, too long, rate limited, no
  // business) is already the right answer; only a streamed turn is adapted.
  if (!turn.ok || !turn.body || !turn.headers.get("content-type")?.includes("ndjson")) return turn;

  const adapted = adaptTurnForPhone(turn.body, (alreadySaid) =>
    saveDeferredStorefrontEdit({ userId: signedIn.userId, userMessage: message.trim(), alreadySaid })
  );
  return new NextResponse(adapted, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}
