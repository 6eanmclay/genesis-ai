import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { completeOAuthHandoff } from "@/lib/integrations/oauthState";
import { prisma } from "@/lib/prisma";
import { exchangePrintfulCode } from "@/lib/integrations/printful";
import { encryptCredentials } from "@/lib/integrations/credentials";
import { recordExecution } from "@/lib/execution/log";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { CURRENT_EXECUTION_SCHEMA_VERSION } from "@/lib/execution/types";
import { initialDiscoveryState, applyFulfillmentConnected } from "@/lib/onboarding/discoveryFlow";
import type { OnboardingState } from "@/lib/onboarding/types";

// Onboarding v2 — the draft-phase OAuth callback for fulfillment connectors.
// Deliberately NOT the shared app/api/integrations/[provider]/callback
// route: that route hard-requires a real storeId and re-verifies
// requireStorePermission against it (its own comment calls it
// "real-money-tested") — during onboarding there is no Store yet, only a
// StoreDraft, so there's nothing for that check to run against. Bending a
// proven, real-money-adjacent route to also handle a draft-phase case is a
// real risk for a small convenience; this is a small, separate, dedicated
// route instead. See ONBOARDING_V2_IMPLEMENTATION.md section 4.
//
// `state` carries `${storeDraftId}:${provider}` (not just storeId, since no
// Store exists to look up a provider-specific callback URL against) — set
// when the draft-phase connect flow starts (app/onboarding/actions.ts).
// Only PRINTFUL is implemented today; the `provider` segment exists so a
// second fulfillment connector doesn't need a second route.
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const state = searchParams.get("state");
  const code = searchParams.get("code");
  const oauthError = searchParams.get("error");

  // Redirects back into the guided flow, not /dashboard — the owner
  // resumes exactly where they left off (see app/onboarding/business/).
  const redirectUrl = new URL("/onboarding/business", request.url);

  // Verified, not parsed (2026-08-20). This route used to split the state on a
  // colon and trust both halves, which is precisely the defect Phase 0 removed
  // from every other OAuth callback. The draft-ownership check below meant it
  // was not an open takeover — but a crafted callback clicked by a signed-in
  // owner would still have stored the ATTACKER'S Printful credentials on the
  // victim's draft, and every fulfillment order that store later placed would
  // have gone to the attacker's account.
  const session = await auth();
  const verified = await completeOAuthHandoff({
    state,
    provider: "PRINTFUL",
    sessionUserId: session?.user?.id,
  });
  // A state minted for the dashboard's own Printful connect carries a storeId
  // and no storeDraftId, so it cannot be replayed here even though the provider
  // matches.
  const storeDraftId = verified.ok ? (verified.payload.storeDraftId ?? null) : null;

  if (!verified.ok && state) {
    console.warn(`[onboarding/fulfillment/callback] rejected state: ${verified.reason}`);
  }

  if (oauthError || !storeDraftId || !code) {
    if (storeDraftId) {
      await recordExecution({
        executionId: randomUUID(),
        action: EXECUTION_ACTIONS.ONBOARDING_FULFILLMENT_CONNECT,
        status: "FAILED",
        verified: false,
        message: oauthError
          ? `Fulfillment connection couldn't complete (${oauthError}).`
          : "The connection link was invalid or had expired. Please try again.",
        retryable: true,
        actorType: "USER",
        actorId: null,
        storeId: null,
        storeDraftId,
        schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION,
        timestamp: new Date(),
        metadata: {},
      }).catch(() => {});
    }
    redirectUrl.searchParams.set("onboarding_fulfillment_error", "1");
    return NextResponse.redirect(redirectUrl);
  }

  if (!session?.user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // The real authorization check here — no Store to run requireStorePermission
  // against, so this route's own equivalent is "does this draft belong to
  // the signed-in user," a direct ownership check.
  const draft = await prisma.storeDraft.findUnique({ where: { id: storeDraftId } });
  if (!draft || draft.userId !== session.user.id) {
    redirectUrl.searchParams.set("onboarding_fulfillment_error", "1");
    return NextResponse.redirect(redirectUrl);
  }

  try {
    const credentials = await exchangePrintfulCode(code, `${request.nextUrl.origin}/api/onboarding/fulfillment/callback`);
    const existingState: OnboardingState = (draft.onboardingState as OnboardingState | null) ?? {
      ...initialDiscoveryState(),
      fulfillmentCredentials: {},
    };
    const advanced = applyFulfillmentConnected(existingState);
    const nextState: OnboardingState = {
      ...advanced,
      fulfillmentCredentials: {
        ...(existingState.fulfillmentCredentials ?? {}),
        PRINTFUL: encryptCredentials(credentials),
      },
    };
    await prisma.storeDraft.update({
      where: { id: storeDraftId },
      data: { onboardingState: nextState as unknown as object },
    });

    await recordExecution({
      executionId: randomUUID(),
      action: EXECUTION_ACTIONS.ONBOARDING_FULFILLMENT_CONNECT,
      status: "SUCCESS",
      verified: true,
      message: "Fulfillment connected during onboarding.",
      retryable: false,
      actorType: "USER",
      actorId: session.user.id,
      storeId: null,
      storeDraftId,
      schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION,
      timestamp: new Date(),
      metadata: { provider: "PRINTFUL" },
    });

    redirectUrl.searchParams.set("onboarding_fulfillment_connected", "1");
  } catch (error) {
    console.error("[onboarding/fulfillment/callback]", error);
    redirectUrl.searchParams.set("onboarding_fulfillment_error", "1");
  }

  return NextResponse.redirect(redirectUrl);
}
