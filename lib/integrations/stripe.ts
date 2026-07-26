import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { ConnectResult, IntegrationConnector } from "./types";
import { getBaseUrl, integrationCallbackUrl } from "./util";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

type StripeCredentials = {
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
      const token = await stripe.oauth.token({
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

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "STRIPE" } },
        create: {
          storeId,
          provider: "STRIPE",
          status: "CONNECTED",
          externalAccountId: token.stripe_user_id,
          credentials,
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          externalAccountId: token.stripe_user_id,
          credentials,
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
    const url = stripe.oauth.authorizeUrl({
      client_id: clientId,
      response_type: "code",
      scope: "read_write",
      redirect_uri: integrationCallbackUrl(baseUrl, "STRIPE"),
      state: storeId,
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
      const account = await stripe.accounts.retrieve(integration.externalAccountId);
      const ok = account.charges_enabled === true;
      await prisma.storeIntegration.update({
        where: { id: integration.id },
        data: {
          status: ok ? "CONNECTED" : "NEEDS_ATTENTION",
          lastVerifiedAt: new Date(),
          lastError: ok ? null : "Charges are not yet enabled on this Stripe account",
        },
      });
      return ok ? { ok: true } : { ok: false, error: "Charges are not yet enabled on this Stripe account" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Verification failed";
      await prisma.storeIntegration.update({
        where: { id: integration.id },
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
        await stripe.oauth.deauthorize({
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
      where: { id: integration.id },
      data: { status: "DISCONNECTED", credentials: Prisma.DbNull },
    });
  },

  async status(storeId) {
    return prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "STRIPE" } },
    });
  },
};
