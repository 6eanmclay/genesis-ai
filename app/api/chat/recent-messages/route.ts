import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, resolveUserStore } from "@/lib/permissions";

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

  const resolved = await resolveUserStore(session.user.id);
  if (!resolved || !hasPermission(resolved.role, PERMISSIONS.GENESIS_CHAT)) {
    return new Response(JSON.stringify({ messages: [] }), { status: 403 });
  }

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
