import { NextRequest, NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { auth } from "@/auth";
import { getConnectorByName } from "@/lib/integrations/registry";
import { prisma } from "@/lib/prisma";
import { execute } from "@/lib/execution/engine";
import { connectExecutable } from "@/lib/execution/adapters/integrationExecutable";

// One generic callback route for every OAuth-style provider — it doesn't
// know anything about Stripe specifically. `state` carries the storeId
// through the provider's redirect (set when the connect flow started).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const searchParams = request.nextUrl.searchParams;
  const storeId = searchParams.get("state");
  const code = searchParams.get("code");
  const oauthError = searchParams.get("error");

  const dashboardUrl = new URL("/dashboard", request.url);

  if (oauthError || !storeId || !code) {
    dashboardUrl.searchParams.set("integration_error", provider);
    return NextResponse.redirect(dashboardUrl);
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  try {
    const connector = getConnectorByName(provider);
    const executable = connectExecutable(connector);

    // Best-effort linkage: reuse the executionId of the PENDING row this
    // OAuth handoff started from (written when the "Connect" button first
    // redirected here), so both rows describe one logical request. Not done
    // by encoding executionId into Stripe's own `state` param — that would
    // mean touching PH-02's already-verified, real-money-tested authorize
    // URL logic, more risk than this grouping convenience is worth.
    const pending = await prisma.executionLog.findFirst({
      where: { storeId, action: executable.action, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });

    // Permission is re-verified here (inside execute(), via
    // requireStorePermission), not just at the button that started the
    // flow — the callback URL itself is a public redirect target.
    const result = await execute(
      executable,
      { params: { code } },
      { storeId, executionId: pending?.executionId }
    );

    if (result.status === "FAILED") {
      dashboardUrl.searchParams.set("integration_error", provider);
    } else {
      dashboardUrl.searchParams.set("integration_connected", provider);
    }
  } catch (error) {
    unstable_rethrow(error);
    console.error(`[integrations/${provider}/callback]`, error);
    dashboardUrl.searchParams.set("integration_error", provider);
  }

  return NextResponse.redirect(dashboardUrl);
}
