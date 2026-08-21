import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { resolveBusiness } from "@/lib/businessContext";

// J4 Workspace, Phase A (2026-08-08) — the reconciliation check. A mid-
// stream disconnect (backgrounding, a real dropped connection) must never
// tell the owner to resend something that actually finished — per the
// already-shipped server-side fix (app/api/chat/route.ts's emit()), the
// real turn keeps generating and persists its result regardless of
// whether the client is still listening. This route is the client's way
// of asking "did that already land?" before showing any failure state —
// a single lightweight read, not a polling/reconnection system.
export async function GET() {
  const session = await auth();
  if (!session?.user) return new Response(JSON.stringify({ messages: [] }), { status: 401 });

  // 409 rather than 403 for ambiguity: "choose a business" and "you may not do
  // this" need different responses, and the client can act on only one of them.
  const resolution = await resolveBusiness(session.user.id);
  if (resolution.kind === "ambiguous") {
    return new Response(JSON.stringify({ messages: [], reason: "choose_business" }), { status: 409 });
  }
  if (resolution.kind === "none" || !hasPermission(resolution.role, PERMISSIONS.GENESIS_CHAT)) {
    return new Response(JSON.stringify({ messages: [] }), { status: 403 });
  }
  const resolved = resolution;

  const recent = await prisma.storeMessage.findMany({
    where: { storeId: resolved.store.id },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { id: true, role: true, content: true, changes: true, createdAt: true },
  });

  return new Response(
    JSON.stringify({ messages: recent.reverse().map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) }),
    { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
  );
}
