import { NextRequest, NextResponse } from "next/server";
import { prismaSystem } from "@/lib/prisma";

// Read-only companion to /api/cron/sync — reports each connected
// integration's own sync-scheduling state directly, since the sync route's
// synced/failed counts can't say *which* connector last ran without this.
// Same CRON_SECRET gate; no side effects. Deliberately cross-tenant (every
// connected integration on the platform, not one store's) — the real
// authorization is the CRON_SECRET header check above, not a storeId
// filter, so this uses prismaSystem rather than the tenant-isolation-
// guarded client — see lib/prisma.ts's own comment on that export.
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const integrations = await prismaSystem.storeIntegration.findMany({
    where: { status: "CONNECTED" },
    select: {
      storeId: true,
      provider: true,
      status: true,
      lastSyncedAt: true,
      nextSyncDueAt: true,
      syncFailureCount: true,
      lastError: true,
    },
    orderBy: { lastSyncedAt: "desc" },
  });

  return NextResponse.json({ integrations });
}
