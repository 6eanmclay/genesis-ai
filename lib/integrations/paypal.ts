import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { ConnectResult, IntegrationConnector } from "./types";
import { toStatusView } from "./types";
import { encryptCredentials, decryptCredentials } from "./credentials";

export type PaypalEnvironment = "sandbox" | "live";

export type PaypalCredentials = {
  schemaVersion: 1;
  clientId: string;
  clientSecret: string;
  environment: PaypalEnvironment;
};

export function paypalApiBase(environment: PaypalEnvironment): string {
  return environment === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

// Every PayPal REST call needs a bearer token, merchant-supplied
// credentials or not — this is how *any* caller authenticates, not a
// per-merchant OAuth authorization step. A successful exchange is also the
// cheapest honest proof the credentials are genuinely valid — PayPal has
// no "whoami" endpoint the way Stripe's accounts.retrieve() works.
export async function getPaypalAccessToken(
  clientId: string,
  clientSecret: string,
  environment: PaypalEnvironment
): Promise<string> {
  const res = await fetch(`${paypalApiBase(environment)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error_description ?? `PayPal token exchange failed (${res.status})`);
  }

  const data = await res.json();
  return data.access_token as string;
}

function parseEnvironment(value: string | undefined): PaypalEnvironment {
  const normalized = value?.trim().toLowerCase();
  return normalized === "live" ? "live" : "sandbox";
}

// The second connector on the Integration Framework (PH-02), and the first
// to use simple per-merchant API credentials instead of OAuth — each
// merchant creates their own PayPal Developer app and enters its Client
// ID/Secret via the {kind:"form"} branch of ConnectResult, designed in
// PH-02 for exactly this case but never exercised until now.
export const paypalConnector: IntegrationConnector = {
  provider: "PAYPAL",
  displayName: "PayPal",
  requiredPermission: PERMISSIONS.PAYMENTS_MANAGE,
  capabilities: {
    // Merchant-supplied client id/secret exchanged for a client_credentials
    // token. Not an OAuth handoff, and documented as such rather than dressed
    // up as one.
    authKind: "api_key",
    apiKeyExceptionReason:
      "PayPal REST is used with the merchant's own app credentials (client_credentials); no per-merchant OAuth handoff is implemented.",
    scopes: [],
    reads: [],
    writes: ["captures checkout payments"],
    // client-credentials token, nothing to revoke per-merchant
    revokesOnDisconnect: false,
  },

  async connect(storeId, userId, params) {
    // Second call: the merchant submitted their credentials.
    if (params?.clientId && params?.clientSecret) {
      const clientId = params.clientId.trim();
      const clientSecret = params.clientSecret.trim();
      const environment = parseEnvironment(params.environment);

      // Validates the credentials by using them — a failed exchange
      // throws, which the engine turns into a FAILED result.
      await getPaypalAccessToken(clientId, clientSecret, environment);

      const credentials: PaypalCredentials = {
        schemaVersion: 1,
        clientId,
        clientSecret,
        environment,
      };
      const encryptedCredentials = encryptCredentials(credentials);

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "PAYPAL" } },
        create: {
          storeId,
          provider: "PAYPAL",
          status: "CONNECTED",
          externalAccountId: clientId,
          credentials: encryptedCredentials,
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          externalAccountId: clientId,
          credentials: encryptedCredentials,
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });

      return { kind: "connected" };
    }

    // First call: no platform-wide app to redirect to — collect the
    // merchant's own credentials directly.
    return {
      kind: "form",
      fields: [
        { name: "clientId", label: "Client ID", type: "text" },
        { name: "clientSecret", label: "Secret", type: "password" },
        { name: "environment", label: "Environment (sandbox or live)", type: "text" },
      ],
    } satisfies ConnectResult;
  },

  async verify(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "PAYPAL" } },
    });
    if (!integration?.credentials) {
      return { ok: false, error: "Not connected" };
    }
    const credentials = decryptCredentials<PaypalCredentials>(integration.credentials);
    if (!credentials?.clientId || !credentials?.clientSecret) {
      return { ok: false, error: "Not connected" };
    }

    try {
      await getPaypalAccessToken(credentials.clientId, credentials.clientSecret, credentials.environment);
      await prisma.storeIntegration.update({
        where: { id: integration!.id, storeId },
        data: { status: "CONNECTED", lastVerifiedAt: new Date(), lastError: null },
      });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Verification failed";
      await prisma.storeIntegration.update({
        where: { id: integration!.id, storeId },
        data: { status: "FAILED", lastVerifiedAt: new Date(), lastError: message },
      });
      return { ok: false, error: message };
    }
  },

  async disconnect(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "PAYPAL" } },
    });
    if (!integration) return;

    // No revoke call exists for client-credentials — nothing to deauthorize
    // on PayPal's side from our end. Regenerating the Secret in the PayPal
    // dashboard is how a merchant would fully cut access.
    await prisma.storeIntegration.update({
      where: { id: integration.id, storeId },
      data: { status: "DISCONNECTED", credentials: Prisma.DbNull },
    });
  },

  async status(storeId) {
    // Phase 0 — never returns the credentials blob.
    return toStatusView(
      await prisma.storeIntegration.findUnique({
        where: { storeId_provider: { storeId, provider: "PAYPAL" } },
      })
    );
  },
};
