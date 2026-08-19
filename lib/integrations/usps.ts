import EasyPost from "@easypost/api";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { ConnectResult, IntegrationConnector } from "./types";
import { toStatusView } from "./types";
import { encryptCredentials, decryptCredentials } from "./credentials";

// Priority 2 (shipping, 2026-08-09) — "USPS/shipping integration so a paid
// order can go all the way through fulfillment, label/tracking" (Sean).
// USPS itself has no direct self-serve REST API for a small business to
// buy real retail labels — EasyPost is the real, standard way apps get
// real USPS (and other carrier) rates/labels/tracking through one REST
// API, confirmed against EasyPost's own current docs and the installed
// SDK's own type definitions before writing this (this codebase's own
// standing "verify against real docs/installed types, not training-data
// memory" discipline — see AGENTS.md). The IntegrationProvider value stays
// USPS (already reserved in the schema as a future connector) because
// that's how Sean and the owner actually think about this connection —
// EasyPost is the real mechanism underneath, named honestly in the setup
// docs and displayName below, not hidden.

export type UspsCredentials = {
  schemaVersion: 1;
  apiKey: string;
};

function getClient(apiKey: string) {
  return new EasyPost(apiKey);
}

// The cheapest honest proof a submitted key is real: ask EasyPost for the
// account's own API keys list, which requires a genuinely valid key to
// succeed. No cheaper no-op "whoami" endpoint exists in the SDK's own
// types.
async function verifyApiKey(apiKey: string): Promise<void> {
  const client = getClient(apiKey);
  await client.ApiKey.all();
}

export const uspsConnector: IntegrationConnector = {
  provider: "USPS",
  displayName: "USPS Shipping",
  requiredPermission: PERMISSIONS.ORDERS_MANAGE,
  capabilities: {
    // A LEGITIMATE EXCEPTION, per Sean's rule. The real provider is EasyPost,
    // which issues API keys and offers no OAuth flow for this use. Forcing an
    // OAuth shape here would be inventing one the provider does not have.
    authKind: "api_key",
    apiKeyExceptionReason:
      "EasyPost (the actual provider behind this connector) authenticates with an account API key and offers no OAuth authorization flow.",
    scopes: [],
    reads: [],
    writes: ["purchases shipping labels, which spends the merchant's real money"],
  },

  async connect(storeId, userId, params) {
    if (params?.apiKey) {
      const apiKey = params.apiKey.trim();
      await verifyApiKey(apiKey);

      const credentials: UspsCredentials = { schemaVersion: 1, apiKey };
      const encryptedCredentials = encryptCredentials(credentials);

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "USPS" } },
        create: {
          storeId,
          provider: "USPS",
          status: "CONNECTED",
          externalAccountId: "easypost",
          credentials: encryptedCredentials,
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          credentials: encryptedCredentials,
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });

      return { kind: "connected" };
    }

    return {
      kind: "form",
      fields: [{ name: "apiKey", label: "EasyPost API Key", type: "password" }],
    } satisfies ConnectResult;
  },

  async verify(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "USPS" } },
    });
    if (!integration?.credentials) {
      return { ok: false, error: "Not connected" };
    }
    const credentials = decryptCredentials<UspsCredentials>(integration.credentials);
    if (!credentials?.apiKey) {
      return { ok: false, error: "Not connected" };
    }

    try {
      await verifyApiKey(credentials.apiKey);
      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId },
        data: { status: "CONNECTED", lastVerifiedAt: new Date(), lastError: null },
      });
      return { ok: true };
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
      where: { storeId_provider: { storeId, provider: "USPS" } },
    });
    if (!integration) return;

    // No revoke call for a bare API key — regenerating it in the EasyPost
    // dashboard is how a merchant would fully cut access, same posture as
    // PayPal's own disconnect() comment.
    await prisma.storeIntegration.update({
      where: { id: integration.id, storeId },
      data: { status: "DISCONNECTED", credentials: Prisma.DbNull },
    });
  },

  async status(storeId) {
    // Phase 0 — never returns the credentials blob.
    return toStatusView(
      await prisma.storeIntegration.findUnique({
        where: { storeId_provider: { storeId, provider: "USPS" } },
      })
    );
  },
};
