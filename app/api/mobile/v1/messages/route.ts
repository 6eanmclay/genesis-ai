import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { resolveBusiness } from "@/lib/businessContext";
import { authenticateMobile, mobileAuthFailure } from "@/lib/auth/mobileSession";

// THE MAIN J4 THREAD, FOR THE PHONE (MOBILE_CHAT_CONTRACT.md D2).
//
// The same thread the dashboard's J4 opens on: this business's ungrouped
// history. Scoped by the business resolved on the server — resolveBusiness, the
// website's single answer to "which one" — never by anything the phone sends.
//
// Fifty, the window J4 itself reads, so the phone shows exactly the
// conversation J4 is answering from.
const WINDOW = 50;

export async function GET(request: Request): Promise<NextResponse> {
  const signedIn = await authenticateMobile(request);
  if (!signedIn.ok) return mobileAuthFailure(signedIn);

  const business = await resolveBusiness(signedIn.userId);
  if (business.kind === "ambiguous") {
    return NextResponse.json({ error: "choose_business" }, { status: 409 });
  }
  if (business.kind === "none" || !hasPermission(business.role, PERMISSIONS.GENESIS_CHAT)) {
    return NextResponse.json({ error: "no_business" }, { status: 403 });
  }

  const rows = await prisma.storeMessage.findMany({
    where: { storeId: business.store.id, conversationId: null },
    orderBy: { createdAt: "desc" },
    take: WINDOW,
    select: { id: true, role: true, content: true, changes: true, createdAt: true },
  });

  return NextResponse.json(
    {
      messages: rows.reverse().map((m) => ({
        id: m.id,
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
        // A memo recorded on the website: shown as its transcript with a label,
        // since the phone cannot play it yet (D2).
        voiceMemo: Boolean((m.changes as { audioUrl?: unknown } | null)?.audioUrl),
        createdAt: m.createdAt.toISOString(),
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
