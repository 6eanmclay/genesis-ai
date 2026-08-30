import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateQuery, queryToken } from "@/lib/http/guard";
import { unstable_rethrow } from "next/navigation";
import { auth } from "@/auth";
import { completeOAuthHandoff, oauthStateFailureMessage, safeReturnTo } from "@/lib/integrations/oauthState";
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
/**
 * What an OAuth return may carry.
 *
 * Every field optional: a provider that refuses sends `error` and no `code`,
 * and the verification below is what decides whether the combination is usable.
 * This only bounds what arrives.
 */
const CallbackQuery = z
  .object({
    state: queryToken(2048).optional(),
    code: queryToken(4096).optional(),
    error: queryToken(256).optional(),
    // QuickBooks alone sends this; every other provider never does.
    realmId: queryToken(128).optional(),
  })
  // Providers append their own extras. Ignored, never refused.
  .passthrough();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  // ============ BOUNDS, NOT AUTHORIZATION (2026-08-30) =============
  //
  // completeOAuthHandoff below verifies the signature, nonce, provider, expiry
  // and session user, and that remains the control — nothing here weakens or
  // duplicates it. What was missing is a LENGTH: `code` is handed to a
  // provider's token exchange and `state` to a signature check, and a callback
  // is the one place an unauthenticated stranger can put text into a URL that a
  // signed-in owner will click.
  //
  // A malformed one is treated exactly as a missing state already was — it
  // falls through to the verification below with nothing, which redirects with
  // the route's own flash parameter. The flow is untouched.
  const checked = await validateQuery(request, { surface: "integrations.callback", schema: CallbackQuery });
  const state = checked.ok ? checked.value.state ?? null : null;
  const code = checked.ok ? checked.value.code ?? null : null;
  const oauthError = checked.ok ? checked.value.error ?? null : "invalid_request";
  // QuickBooks' own callback includes realmId (its company id) alongside
  // code — the one real per-provider extra param this generic route needs
  // to pass through. Every other provider simply never sends it.
  const realmId = checked.ok ? checked.value.realmId ?? null : null;

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

  // Phase 0 — `state` is now a signed, single-use, session-bound, expiring
  // token rather than the storeId in plain sight. The storeId comes OUT of it
  // only after the signature, nonce cookie, provider, expiry and session user
  // all check out, so a crafted callback cannot bind a provider account to a
  // store this server never started a flow for.
  const session = await auth();
  const verified = await completeOAuthHandoff({
    state,
    provider,
    sessionUserId: session?.user?.id,
  });
  const storeId = verified.ok ? verified.payload.storeId : null;
  const handoffExecutionId = verified.ok && verified.payload.executionId ? verified.payload.executionId : null;

  // WHERE THE FLOW STARTED, WHEN IT WASN'T THE CONNECTIONS PAGE (2026-08-27).
  //
  // The Creation Station asks for a supplier mid-task. Somebody who was making
  // a T-shirt has to land back on the T-shirt — on both outcomes, because a
  // failure they can retry in place beats a failure explained on a page they
  // did not ask for.
  //
  // Read only out of the VERIFIED payload, so it is a path this server signed,
  // and re-checked by safeReturnTo, so a minting bug cannot turn it into an
  // open redirect either.
  const returnTo = verified.ok ? safeReturnTo(verified.payload.returnTo) : null;
  if (returnTo) {
    const target = new URL(returnTo, request.url);
    redirectUrl.pathname = target.pathname;
    redirectUrl.search = target.search;
  }

  if (!verified.ok && state) {
    // A rejected state is worth its own console signal — it is either a real
    // expiry (common, harmless) or someone probing the callback (rare, worth
    // knowing). No store is named, because we do not trust the one supplied.
    console.warn(`[integrations/${provider}/callback] rejected state: ${verified.reason}`);
  }

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
        const pending = handoffExecutionId
          ? { executionId: handoffExecutionId }
          : await prisma.executionLog.findFirst({
              where: { storeId, action, status: "PENDING" },
              orderBy: { createdAt: "desc" },
            });
        await recordExecution({
          executionId: pending?.executionId ?? randomUUID(),
          action,
          status: "FAILED",
          verified: false,
          message: oauthError
            // hasOwnProperty (2026-08-22): oauthError is a raw query param, so
            // ?error=constructor resolved to the inherited Object constructor —
            // truthy, so `??` never fired, and a FUNCTION was written into the
            // merchant's ExecutionLog as the failure message they then read.
            ? (Object.prototype.hasOwnProperty.call(OAUTH_ERROR_MESSAGES, oauthError)
                ? OAUTH_ERROR_MESSAGES[oauthError]
                : undefined) ??
              `${connector.displayName} couldn't complete the connection (${oauthError}).`
            : !verified.ok
              ? oauthStateFailureMessage(verified.reason)
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

  if (!session?.user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  try {
    const connector = getConnectorByName(provider);
    const executable = connectExecutable(connector);

    // Phase 0 — EXACT linkage, not a guess.
    //
    // This used to take "the most recent PENDING row for this action", which is
    // wrong the moment a merchant retries: each callback closed the newest row
    // and orphaned the rest. One real store had accumulated 18 of them. The
    // executionId now travels inside the signed state, so this closes the
    // attempt it actually belongs to. The fallback keeps older in-flight
    // handoffs (minted before this deploy) working rather than stranding them.
    const pending = handoffExecutionId
      ? { executionId: handoffExecutionId }
      : await prisma.executionLog.findFirst({
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
