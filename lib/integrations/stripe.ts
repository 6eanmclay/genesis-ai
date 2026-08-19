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
      const token = await platformStripe().oauth.token({
        grant_type: "authorization_code",
        code: params.code,
      });

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
      const account = await platformStripe().accounts.retrieve(integration.externalAccountId);
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
