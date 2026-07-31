import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { auth } from "@/auth";
import { getConnectorByName } from "@/lib/integrations/registry";
import { prisma } from "@/lib/prisma";
import { execute } from "@/lib/execution/engine";
import { connectExecutable } from "@/lib/execution/adapters/integrationExecutable";
import { recordExecution } from "@/lib/execution/log";
import { CURRENT_EXECUTION_SCHEMA_VERSION } from "@/lib/execution/types";

// Stripe's own real OAuth `error` values, worth a specific human sentence
// rather than falling through to a generic one — the only one commonly hit
// in practice is a merchant clicking "Cancel" on Stripe's consent screen.
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "You cancelled the connection before it finished.",
};

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
  // QuickBooks' own callback includes realmId (its company id) alongside
  // code — the one real per-provider extra param this generic route needs
  // to pass through. Every other provider simply never sends it.
  const realmId = searchParams.get("realmId");

  // Every outcome lands on the page that owns this provider, not bare
  // Home — that's where the explanation (this route's own flash param,
  // plus the durable ExecutionLog-backed status card) and the recovery
  // action (Reconnect) actually live. Stripe/PayPal own Payments (already
  // shipped, unchanged); every other provider (Phase 3 Milestone 2
  // onward) owns Connections.
  const PAYMENTS_PROVIDERS = new Set(["STRIPE", "PAYPAL"]);
  const redirectUrl = new URL(
    PAYMENTS_PROVIDERS.has(provider.toUpperCase()) ? "/dashboard/payments" : "/dashboard/connections",
    request.url
  );

  if (oauthError || !storeId || !code) {
    // Without this, a cancelled or expired OAuth handoff leaves the PENDING
    // ExecutionLog row `connectStripe()` wrote before redirecting here
    // dangling forever — only caught, if ever, by the much-later Genesis
    // stale-execution sweep — and the Payments page has nothing to show the
    // owner right when it matters (a live StoreIntegration row is only ever
    // created on a *successful* connect, so the "connected" branch's
    // failure UI is unreachable for a first-attempt failure like this one).
    if (storeId) {
      try {
        const connector = getConnectorByName(provider);
        const action = connectExecutable(connector).action;
        const pending = await prisma.executionLog.findFirst({
          where: { storeId, action, status: "PENDING" },
          orderBy: { createdAt: "desc" },
        });
        await recordExecution({
          executionId: pending?.executionId ?? randomUUID(),
          action,
          status: "FAILED",
          verified: false,
          message: oauthError
            ? (OAUTH_ERROR_MESSAGES[oauthError] ??
                `${connector.displayName} couldn't complete the connection (${oauthError}).`)
            : "The connection link was invalid or had expired. Please try again.",
          retryable: true,
          actorType: "USER",
          actorId: null,
          storeId,
          storeDraftId: null,
          schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION,
          timestamp: new Date(),
          metadata: {},
        });
      } catch {
        // Unknown provider, or the log write itself failed — the query
        // param below is still a real, if less detailed, signal.
      }
    }
    redirectUrl.searchParams.set("integration_error", provider);
    return NextResponse.redirect(redirectUrl);
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
      { params: realmId ? { code, realmId } : { code } },
      { storeId, executionId: pending?.executionId }
    );

    if (result.status === "FAILED") {
      redirectUrl.searchParams.set("integration_error", provider);
    } else {
      redirectUrl.searchParams.set("integration_connected", provider);
    }
  } catch (error) {
    unstable_rethrow(error);
    console.error(`[integrations/${provider}/callback]`, error);
    redirectUrl.searchParams.set("integration_error", provider);
  }

  return NextResponse.redirect(redirectUrl);
}
