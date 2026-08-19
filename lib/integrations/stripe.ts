import Stripe from "stripe";
import { beginOAuthHandoff } from "./oauthState";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { ConnectResult, IntegrationConnector } from "./types";
import { toStatusView } from "./types";
import { getBaseUrl, integrationCallbackUrl } from "./util";
import { encryptCredentials } from "./credentials";

// Phase 1 — lazy, not module-scope.
//
// This used to be constructed at import time, so merely importing the connector
// registry threw without STRIPE_SECRET_KEY — which made the framework's own
// test suite need a placeholder key to load a module it never calls. A getter
// costs nothing and keeps importing the registry free of side effects.
let stripeClient: Stripe | null = null;
function platformStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

export type StripeCredentials = {
  schemaVersion: 1;
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  livemode: boolean;
};


/**
 * What actually went wrong, instead of "retried 2 times".
 *
 * stripe-node's StripeConnectionError says "An error occurred with our
 * connection to Stripe. Request was retried 2 times." and nothing else — no
 * status, because the request never got a response. The real cause is one level
 * down in `cause` (ECONNRESET, ETIMEDOUT, ENOTFOUND...), and it was being
 * discarded before it could reach the ExecutionLog. That left a production
 * failure diagnosable only by guessing from the outside.
 *
 * Everything here is drawn from the error object itself. Nothing is invented,
 * and when there is genuinely no more detail the original message is returned
 * unchanged rather than padded out.
 */
function describeStripeError(error: unknown, stage: string): Error {
  if (!(error instanceof Error)) {
    return new Error(`Stripe ${stage} failed: ${String(error)}`);
  }

  const e = error as Error & {
    type?: string;
    code?: string;
    statusCode?: number;
    requestId?: string;
    // stripe-node attaches the ORIGINAL error here, not to `cause`. See
    // RequestSender.js: `new StripeConnectionError({ message, detail: error })`.
    // Reading `cause` — the standard Error property — is why the first version
    // of this function logged `causeCode: undefined` on a real production
    // failure and told us nothing.
    detail?: unknown;
    cause?: unknown;
  };

  const parts: string[] = [];
  if (e.type) parts.push(e.type);
  if (typeof e.statusCode === "number") parts.push(`HTTP ${e.statusCode}`);
  if (e.code) parts.push(`code=${e.code}`);

  // The Node-level reason a connection error actually happened: ECONNRESET,
  // ENOTFOUND, ETIMEDOUT, a TLS/certificate failure, and so on. `detail` first
  // because that is where stripe-node puts it; `cause` kept as the fallback for
  // errors that follow the standard convention.
  const underlying = (e.detail ?? e.cause) as
    | { code?: string; errno?: number; syscall?: string; hostname?: string; name?: string; message?: string }
    | undefined;
  if (underlying?.code) parts.push(`cause=${underlying.code}`);
  if (underlying?.syscall) parts.push(`syscall=${underlying.syscall}`);
  if (underlying?.hostname) parts.push(`host=${underlying.hostname}`);
  if (!underlying?.code && underlying?.message) parts.push(`cause=${underlying.message.slice(0, 80)}`);
  if (e.requestId) parts.push(`request=${e.requestId}`);

  const detail = parts.length > 0 ? ` [${parts.join(" ")}]` : "";
  const described = new Error(`Stripe ${stage} failed: ${e.message}${detail}`);

  // Also to the platform log, where the full object survives truncation.
  console.error(`[integrations/stripe] ${stage} failed`, {
    type: e.type,
    code: e.code,
    statusCode: e.statusCode,
    requestId: e.requestId,
    underlyingName: underlying?.name,
    underlyingCode: underlying?.code,
    underlyingErrno: underlying?.errno,
    underlyingSyscall: underlying?.syscall,
    underlyingHostname: underlying?.hostname,
    underlyingMessage: underlying?.message,
    message: e.message,
  });

  return described;
}

export const stripeConnector: IntegrationConnector = {
  provider: "STRIPE",
  displayName: "Stripe",
  requiredPermission: PERMISSIONS.PAYMENTS_MANAGE,
  capabilities: {
    authKind: "oauth",
    // PHASE 1 CORRECTION. Phase 0 recorded read_write as broader than Genesis
    // needs and said Phase 1 would narrow it. That was wrong, and tracing the
    // code is what showed it: app/store/[slug]/actions.ts builds the storefront
    // checkout by calling checkout.sessions.create with the MERCHANT'S OWN
    // access token, on their account. That is a genuine write, it is how every
    // real sale happens, and read_only would break checkout outright.
    //
    // So the scope stays, and what it is for is stated instead of implied.
    scopes: ["read_write"],
    reads: [],
    writes: [
      "creates Checkout Sessions on the connected account — this is how a customer pays the merchant",
    ],
  },

  // PHASE 1 DECISION, RECORDED: NO SYNC REQUIRED.
  //
  // Deliberately absent, not forgotten. Stripe payment data already enters
  // Genesis through the canonical path: a completed checkout writes a real
  // Order (app/api/webhooks/stripe), and internalMapper maps every Order into a
  // canonical `transaction` on read. A Stripe sync() mapping charges to
  // `transaction` would therefore produce a SECOND record of the same money,
  // under a different externalId, and M5/M7 profitability reads exactly those
  // records — inflating revenue in the intelligence layer we just shipped.
  //
  // What Genesis genuinely lacks from Stripe is payout and dispute state, and
  // neither has a canonical entity today. That is a real future capability with
  // a real design question attached, not something to smuggle in as a sync.
  //
  // The absence of `sync` here is the answer, and syncExecutable already
  // reports "Stripe has nothing to sync" rather than failing.

  async connect(storeId, userId, params) {
    const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
    if (!clientId) {
      throw new Error(
        "Stripe Connect isn't configured yet — STRIPE_CONNECT_CLIENT_ID is missing."
      );
    }

    // Second call of the round-trip: the callback route hands us the OAuth
    // code it received from Stripe.
    if (params?.code) {
      let token;
      try {
        token = await platformStripe().oauth.token({
          grant_type: "authorization_code",
          code: params.code,
        });
      } catch (error) {
        // The exact failure, not "retried 2 times" — this is the step that has
        // been failing in production since 2026-08-12.
        throw describeStripeError(error, "OAuth token exchange");
      }

      if (!token.stripe_user_id || !token.access_token) {
        throw new Error("Stripe didn't return a connected account");
      }

      const credentials: StripeCredentials = {
        schemaVersion: 1,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        scope: token.scope,
        livemode: token.livemode ?? false,
      };
      const encryptedCredentials = encryptCredentials(credentials);

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "STRIPE" } },
        create: {
          storeId,
          provider: "STRIPE",
          status: "CONNECTED",
          externalAccountId: token.stripe_user_id,
          credentials: encryptedCredentials,
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          externalAccountId: token.stripe_user_id,
          credentials: encryptedCredentials,
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });

      return { kind: "connected" };
    }

    // First call: send the merchant to Stripe's own hosted OAuth flow.
    const baseUrl = await getBaseUrl();
    const url = platformStripe().oauth.authorizeUrl({
      client_id: clientId,
      response_type: "code",
      scope: "read_write",
      redirect_uri: integrationCallbackUrl(baseUrl, "STRIPE"),
      state: await beginOAuthHandoff({ storeId, userId, provider: "STRIPE", executionId: params?.executionId }),
    });

    return { kind: "redirect", url } satisfies ConnectResult;
  },

  async verify(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "STRIPE" } },
    });
    if (!integration?.externalAccountId) {
      return { ok: false, error: "Not connected" };
    }

    try {
      let account;
      try {
        account = await platformStripe().accounts.retrieve(integration.externalAccountId);
      } catch (error) {
        throw describeStripeError(error, "account retrieval");
      }
      const ok = account.charges_enabled === true;

      // Phase 1 — "connected" is not the same as "the money reaches you".
      //
      // charges_enabled answers "can a customer pay?". payouts_enabled answers
      // "does that money ever land in the owner's bank?". An account can have
      // the first without the second — Stripe holds the funds pending
      // verification — and an owner selling happily into a blocked payout is
      // exactly the sort of thing a business partner should say out loud.
      //
      // Deliberately does NOT flip ok to false: they genuinely can sell, and
      // reporting a working checkout as broken would be its own lie. It is
      // recorded as the integration's current issue instead.
      const payoutsBlocked = ok && account.payouts_enabled !== true;
      const payoutNote =
        "Stripe can accept payments, but payouts to your bank are not enabled yet — money will sit in Stripe until its requirements are met.";

      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId },
        data: {
          status: ok ? "CONNECTED" : "NEEDS_ATTENTION",
          lastVerifiedAt: new Date(),
          lastError: !ok
            ? "Charges are not yet enabled on this Stripe account"
            : payoutsBlocked
              ? payoutNote
              : null,
        },
      });
      return ok ? { ok: true } : { ok: false, error: "Charges are not yet enabled on this Stripe account" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Verification failed";
      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId },
        data: { status: "FAILED", lastVerifiedAt: new Date(), lastError: message },
      });
      return { ok: false, error: message };
    }
  },

  async disconnect(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "STRIPE" } },
    });
    if (!integration) return;

    const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
    if (clientId && integration.externalAccountId) {
      try {
        await platformStripe().oauth.deauthorize({
          client_id: clientId,
          stripe_user_id: integration.externalAccountId,
        });
      } catch {
        // Already revoked on Stripe's side, or the connection was already
        // broken — either way, still clear our local record below.
      }
    }

    // externalAccountId/connectedByUserId/connectedAt are kept as a
    // historical record of the last connection; only the now-invalid
    // credentials are cleared.
    await prisma.storeIntegration.update({
      where: { id: integration.id, storeId },
      data: { status: "DISCONNECTED", credentials: Prisma.DbNull },
    });
  },

  async status(storeId) {
    // Phase 0 — never returns the credentials blob.
    return toStatusView(
      await prisma.storeIntegration.findUnique({
        where: { storeId_provider: { storeId, provider: "STRIPE" } },
      })
    );
  },
};
