import { auth } from "@/auth";
import { z } from "zod";
import { guard } from "@/lib/http/guard";
import { logSafeText } from "@/lib/http/logSafeText";

// Temporary production diagnostic endpoint (2026-08-08) — the client-side
// half of tracing the real iPhone/Safari chat streaming failure. Accepts
// timestamped client-side milestone events (via navigator.sendBeacon,
// chosen specifically because it's designed to survive the exact
// conditions under investigation — backgrounding, navigation, page
// teardown — where a normal fetch() would be aborted) and logs them so
// they show up in `vercel logs` correlated against app/api/chat/route.ts's
// own server-side diagLog() calls via a shared requestId. No PII, just
// event names and timestamps.
//
// ============ IT WROTE WHATEVER IT WAS GIVEN (2026-08-30) =============
//
// `meta` was an open `Record<string, unknown>` stringified whole into a log
// line, and `event` was any string of any length. So any signed-in account
// could write arbitrary content into production logs: newlines to forge log
// entries, megabytes to bury real ones, and anything they liked to spray into
// a place nobody reads carefully.
//
// Bounded now — short, single-line, and `meta` is gone rather than sanitised,
// because nothing was reading it and an open bag is the thing that made this a
// hazard. The endpoint's own comment already says it is not meant to ship
// long-term; that is recorded as an open item rather than acted on here,
// because deleting a diagnostic somebody may still be relying on is a decision
// rather than a cleanup.
export const dynamic = "force-dynamic";

const DiagBody = z.object({
  requestId: logSafeText(64),
  event: logSafeText(64),
  tMs: z.number().finite().nonnegative().max(86_400_000).optional(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return new Response(null, { status: 401 });

  const checked = await guard(request, {
    surface: "diag.clientLog",
    // A beacon carrying three short fields.
    maxBytes: 2 * 1024,
    schema: DiagBody,
    actorId: session.user.id,
    // A diagnostic beacon fires a handful of times per page load. Generous
    // enough never to interfere with the thing it was built to observe.
    limits: () => [{ kind: "diag:user", value: session.user.id!, max: 300, windowMs: 10 * 60 * 1000 }],
  });
  if (!checked.ok) return checked.response;

  const { requestId, event, tMs } = checked.body;
  console.log(
    `[genesis-chat-diag] side=client requestId=${requestId} event=${event} tMs=${tMs ?? "n/a"}`
  );

  return new Response(null, { status: 204 });
}
