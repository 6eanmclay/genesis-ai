import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

// Polling endpoint for the "Welcome to Genesis" generation-progress UI
// (CreateStoreForm.tsx) — deliberately a plain Route Handler, not a Server
// Action. Next.js dispatches Server Actions one at a time per client (its
// own docs: "do not rely on Promise.all to parallelize Server Actions from
// the client"), so a Server Action polled while generateStoreDraft's own
// action is still in flight would simply queue behind it and never
// actually run concurrently. A Route Handler is a plain HTTP endpoint,
// not subject to that serialization, so it can be polled while the real
// generation request is still running.
//
// Read-only, cheap (one indexed findUnique by the already-unique
// userId), and returns only the current status string — the real
// generatedOutput/theme/etc. content is never exposed here, this exists
// purely to drive an honest "which real phase are we in" progress
// message client-side.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ status: null }, { status: 401 });
  }

  const draft = await prisma.storeDraft.findUnique({
    where: { userId: session.user.id },
    select: { status: true },
  });

  return NextResponse.json({ status: draft?.status ?? null });
}
