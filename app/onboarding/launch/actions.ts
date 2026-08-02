"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { execute } from "@/lib/execution/engine";
import { getConnector } from "@/lib/integrations/registry";
import { getBaseUrl } from "@/lib/integrations/util";
import { connectExecutable } from "@/lib/execution/adapters/integrationExecutable";
import { publishStoreExecutable } from "@/lib/execution/executables/storePublish";
import { logProductEvent } from "@/lib/telemetry/events";
import { confirmStoreDraftCore } from "@/app/dashboard/ai-actions";
import type { ExecutionResult } from "@/lib/execution/types";

// Onboarding v2 Milestone 2 — the Partnership/Launch screen's real backend
// actions. Deliberately redirect-free (unlike app/dashboard/actions.ts's
// connect*/toggleStorePublished, which are plain <form> Server Actions):
// LaunchScreen.tsx follows BusinessScreen.tsx's own established pattern —
// call the real action directly, advance the client-side beat once it
// resolves — rather than a full-page redirect for every step. Only
// launchConnectStripe hands back a URL for the client to navigate to
// itself (window.location.href), mirroring how startFulfillmentConnect
// already works in app/onboarding/actions.ts.

async function requireUser() {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in");
  return session.user;
}

// Same instrumentation app/dashboard/actions.ts's connectStripe/connectPaypal
// already write on every attempt — duplicated here (not imported) since
// that one is a private, unexported helper local to a different "use
// server" file, and each server-actions file in this codebase stays
// self-contained rather than reaching into another one's internals.
async function logConnectAttempt(
  provider: "stripe" | "paypal",
  action: string,
  result: ExecutionResult<unknown>
) {
  const user = await requireUser().catch(() => null);
  if (!user || !result.storeId) return;
  await logProductEvent({
    userId: user.id,
    storeId: result.storeId,
    sessionInstanceId: user.sessionInstanceId,
    name: action,
    category: "integration",
    attemptKey: `${provider}_connect:${result.storeId}`,
    outcome: result.status === "FAILED" ? "failure" : "success",
    metadata: { status: result.status, message: result.message },
  });
}

// Beat: commitment -> building. The real moment the business becomes a
// Store — same confirmStoreDraftCore the human-driven "Confirm & Create
// Store" flow and Arrival Experience V1's auto-chain both already use (see
// its own header comment in app/dashboard/ai-actions.ts).
export async function launchConfirmStore(): Promise<void> {
  const user = await requireUser();
  const draft = await prisma.storeDraft.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });
  if (!draft) throw new Error("No store draft to confirm.");

  await confirmStoreDraftCore(user.id, { sessionInstanceId: user.sessionInstanceId });
}

// Beat: payment choice, Stripe branch. Real OAuth handoff — the callback
// itself is the existing, real-money-tested shared route
// (app/api/integrations/[provider]/callback), left untouched: it always
// lands on /dashboard/payments, not back here. See the "continue to
// launch" banner added to that page for the way back to this screen.
export async function launchConnectStripe(): Promise<{ authorizeUrl: string | null; failed: boolean }> {
  const result = await execute(connectExecutable(getConnector("STRIPE")), {});
  await logConnectAttempt("stripe", "integration.connect_attempt", result);
  return { authorizeUrl: result.redirectUrl ?? null, failed: result.status === "FAILED" };
}

// Beat: payment choice, PayPal branch. Unlike Stripe, PayPal has no fixed
// external redirect_uri to honor (see submitPaypalCredentials in
// app/dashboard/actions.ts) — credentials are submitted directly, so the
// whole exchange safely stays on this screen with no redirect at all.
export async function launchConnectPaypal(
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  const clientId = (formData.get("clientId") as string)?.trim();
  const clientSecret = (formData.get("clientSecret") as string)?.trim();
  const environment = (formData.get("environment") as string)?.trim();
  if (!clientId || !clientSecret) {
    return { ok: false, error: "Client ID and Secret are required." };
  }

  const result = await execute(connectExecutable(getConnector("PAYPAL")), {
    params: { clientId, clientSecret, environment },
  });
  await logConnectAttempt("paypal", "integration.connect_attempt", result);
  return {
    ok: result.status !== "FAILED",
    error: result.status === "FAILED" ? result.message : undefined,
  };
}

// Beat: the decision -> live. The actual go-live moment — the same
// publishStoreExecutable toggle Website settings already uses.
export async function launchGoLive(): Promise<{ storeUrl: string }> {
  const result = await execute(publishStoreExecutable, undefined);
  if (result.status === "FAILED") {
    throw new Error(result.message);
  }
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: result.storeId! },
    select: { slug: true },
  });
  const baseUrl = await getBaseUrl();
  return { storeUrl: `${baseUrl}/store/${store.slug}` };
}
