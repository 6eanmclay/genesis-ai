import { prisma } from "@/lib/prisma";
import { beginOAuthHandoff } from "./oauthState";
import { PERMISSIONS } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { ConnectResult, IntegrationConnector, SyncedRecord } from "./types";
import { toStatusView } from "./types";
import { getBaseUrl, integrationCallbackUrl } from "./util";
import { encryptCredentials, decryptCredentials } from "./credentials";
import { mergeRefreshedTokens } from "./tokenRefresh";
import { integrationFetch } from "./rateLimit";
import type { Document, Transaction } from "@/lib/businessModel/entities";

// Phase 3 Milestone 2 — proof integration #2: a genuinely different OAuth
// flavor than Google's (Intuit's own authorize/token endpoints, a
// different scope model), and the real structural difference this
// connector is chosen to exercise: the OAuth callback also returns a
// realmId (the QuickBooks company id) that must be captured and stored
// alongside the tokens — an extra required credential field the framework
// needed to accommodate without any special-casing (it still fits
// `credentials: Json?` unchanged). Real Intuit Developer app credentials
// are provisioned at implementation time.

type QuickBooksEnvironment = "sandbox" | "production";

type QuickBooksCredentials = {
  schemaVersion: 1;
  accessToken: string;
  refreshToken: string;
  realmId: string;
  environment: QuickBooksEnvironment;
  expiresAt: number; // epoch ms
};

const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
// Intuit's documented revocation endpoint. Accepts either token; the refresh
// token is sent because revoking it invalidates the whole grant.
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";

function apiBase(environment: QuickBooksEnvironment): string {
  return environment === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

// PRODUCTION BUG FIXED HERE (2026-08-20).
//
// Intuit ROTATES the refresh token: every refresh response carries a new one,
// roughly every 24 hours, and the previous one stops working. This function
// read `access_token` and `expires_in`, threw the new `refresh_token` away, and
// never wrote anything back — so the first refresh succeeded, Intuit rotated,
// and every refresh after that presented a dead token.
//
// The evidence matched exactly: connected 2026-07-31, last successful sync
// 2026-08-01, then eleven consecutive "token refresh failed (400)". About
// twenty-four hours, which is Intuit's rotation interval.
//
// The refreshed access token was not persisted either, so even a working
// connection re-refreshed on every single call.
//
// Now the whole credential set is written back under the store it belongs to.
// storeId is required — this is a tenant-owned row, and lib/tenantIsolation.ts
// refuses an unscoped write regardless.
async function refreshAccessToken(
  storeId: string,
  credentials: QuickBooksCredentials
): Promise<string> {
  if (credentials.expiresAt > Date.now() + 60_000) {
    return credentials.accessToken;
  }
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("QuickBooks isn't configured yet.");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    }),
  });
  if (!res.ok) {
    // A 400 here means the stored refresh token is no longer accepted, which
    // only a fresh authorization can repair. Said plainly so the owner is told
    // to reconnect rather than left reading a status code.
    const detail =
      res.status === 400
        ? "QuickBooks no longer accepts this connection's saved credentials — please reconnect QuickBooks."
        : `QuickBooks token refresh failed (${res.status})`;
    throw new Error(detail);
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  // Shared, tested merge — see lib/integrations/tokenRefresh.ts for why a
  // rotated refresh token must never be discarded.
  const updated: QuickBooksCredentials = mergeRefreshedTokens(credentials, data);

  await prisma.storeIntegration.updateMany({
    where: { storeId, provider: "QUICKBOOKS" },
    data: { credentials: encryptCredentials(updated) },
  });

  return updated.accessToken;
}

export const quickbooksConnector: IntegrationConnector = {
  provider: "QUICKBOOKS",
  displayName: "QuickBooks Online",
  requiredPermission: PERMISSIONS.CONNECTIONS_MANAGE,
  capabilities: {
    authKind: "oauth",
    scopes: ["com.intuit.quickbooks.accounting"],
    reads: ["transaction", "document"],
    writes: [],
    // calls Intuit's revoke endpoint
    revokesOnDisconnect: true,
  },

  async connect(storeId, userId, params) {
    const clientId = process.env.QUICKBOOKS_CLIENT_ID;
    const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        "QuickBooks isn't configured yet — QUICKBOOKS_CLIENT_ID/SECRET are missing."
      );
    }

    // Second call: the callback route hands us the OAuth code AND realmId
    // (QuickBooks includes realmId as its own query param, distinct from
    // Google/Stripe's plain code-only callback — the callback route passes
    // both through as params).
    if (params?.code && params?.realmId) {
      const baseUrl = await getBaseUrl();
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: params.code,
          redirect_uri: integrationCallbackUrl(baseUrl, "QUICKBOOKS"),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`QuickBooks token exchange failed (${res.status}): ${body}`);
      }
      const token = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };

      const environment: QuickBooksEnvironment =
        process.env.QUICKBOOKS_ENVIRONMENT === "production" ? "production" : "sandbox";

      const credentials: QuickBooksCredentials = {
        schemaVersion: 1,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        realmId: params.realmId,
        environment,
        expiresAt: Date.now() + token.expires_in * 1000,
      };

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "QUICKBOOKS" } },
        create: {
          storeId,
          provider: "QUICKBOOKS",
          status: "CONNECTED",
          externalAccountId: params.realmId,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          externalAccountId: params.realmId,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });

      return { kind: "connected" };
    }

    // First call: send the merchant to Intuit's own hosted OAuth flow.
    const baseUrl = await getBaseUrl();
    const url = new URL(AUTH_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", integrationCallbackUrl(baseUrl, "QUICKBOOKS"));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("state", await beginOAuthHandoff({ storeId, userId, provider: "QUICKBOOKS", executionId: params?.executionId }));

    return { kind: "redirect", url: url.toString() } satisfies ConnectResult;
  },

  async verify(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "QUICKBOOKS" } },
    });
    if (!integration?.credentials) {
      return { ok: false, error: "Not connected" };
    }

    try {
      const credentials = decryptCredentials<QuickBooksCredentials>(integration.credentials);
      const accessToken = await refreshAccessToken(storeId, credentials);
      const res = await integrationFetch(
        `${apiBase(credentials.environment)}/v3/company/${credentials.realmId}/companyinfo/${credentials.realmId}`,
        { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
        { label: "QuickBooks" }
      );
      const ok = res.ok;
      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId },
        data: {
          status: ok ? "CONNECTED" : "NEEDS_ATTENTION",
          lastVerifiedAt: new Date(),
          lastError: ok ? null : `QuickBooks check failed (${res.status})`,
        },
      });
      return ok ? { ok: true } : { ok: false, error: `QuickBooks check failed (${res.status})` };
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
      where: { storeId_provider: { storeId, provider: "QUICKBOOKS" } },
    });
    if (!integration) return;

    // REVOKE AT INTUIT, not just locally (2026-08-20).
    //
    // Disconnect used to delete the stored credentials and stop there. The
    // token stayed alive at Intuit until it expired on its own, while the owner
    // had just been told Genesis no longer had access. That gap between what
    // the button says and what is true is the actual problem; Intuit requiring
    // revocation for production apps is only how we found it.
    //
    // Best effort, deliberately. If Intuit is unreachable the local disconnect
    // still proceeds — the owner asked to disconnect, and refusing because a
    // third party is down would leave them connected against their wishes. The
    // failure is logged so a token we failed to revoke is not silently
    // forgotten.
    const clientId = process.env.QUICKBOOKS_CLIENT_ID;
    const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
    if (integration.credentials && clientId && clientSecret) {
      try {
        const credentials = decryptCredentials<QuickBooksCredentials>(integration.credentials);
        if (credentials?.refreshToken) {
          const res = await fetch(REVOKE_URL, {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ token: credentials.refreshToken }),
          });
          if (!res.ok) {
            console.error(`[integrations/quickbooks] revoke returned ${res.status} for store ${storeId}`);
          }
        }
      } catch (error) {
        console.error(
          `[integrations/quickbooks] revoke failed for store ${storeId}`,
          error instanceof Error ? error.message : error
        );
      }
    }

    await prisma.storeIntegration.update({
      where: { id: integration.id, storeId },
      data: { status: "DISCONNECTED", credentials: Prisma.DbNull },
    });
  },

  async status(storeId) {
    // Phase 0 — never returns the credentials blob.
    return toStatusView(
      await prisma.storeIntegration.findUnique({
        where: { storeId_provider: { storeId, provider: "QUICKBOOKS" } },
      })
    );
  },

  // Maps recent Invoices -> Document and Payments -> Transaction, proving
  // the Foundation's financial entity shapes against a real external
  // accounting system — the one connector genuinely exercising that half
  // of the canonical model. A small, recent slice (25 of each), not full
  // historical coverage.
  async sync(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "QUICKBOOKS" } },
    });
    if (!integration?.credentials) return [];

    const credentials = decryptCredentials<QuickBooksCredentials>(integration.credentials);
    const accessToken = await refreshAccessToken(storeId, credentials);
    const base = apiBase(credentials.environment);
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };

    async function query(sql: string): Promise<{ QueryResponse?: Record<string, unknown[]> }> {
      const url = `${base}/v3/company/${credentials.realmId}/query?query=${encodeURIComponent(sql)}`;
      const res = await integrationFetch(url, { headers }, { label: "QuickBooks" });
      if (!res.ok) throw new Error(`QuickBooks query failed (${res.status})`);
      return res.json();
    }

    const [invoiceResponse, paymentResponse] = await Promise.all([
      query("SELECT * FROM Invoice ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 25"),
      query("SELECT * FROM Payment ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 25"),
    ]);

    const invoices = (invoiceResponse.QueryResponse?.Invoice ?? []) as {
      Id: string;
      TotalAmt?: number;
      Balance?: number;
      TxnDate?: string;
      DueDate?: string;
    }[];
    const payments = (paymentResponse.QueryResponse?.Payment ?? []) as {
      Id: string;
      TotalAmt?: number;
      TxnDate?: string;
    }[];

    const invoiceRecords: SyncedRecord[] = invoices.map((invoice) => {
      const document: Document = {
        type: "invoice",
        amountInCents: invoice.TotalAmt != null ? Math.round(invoice.TotalAmt * 100) : null,
        status: invoice.Balance === 0 ? "paid" : "pending",
        contactId: null,
        issuedAt: invoice.TxnDate ?? null,
        dueAt: invoice.DueDate ?? null,
      };
      return { entityType: "document", externalId: invoice.Id, data: document };
    });

    const paymentRecords: SyncedRecord[] = payments.map((payment) => {
      const transaction: Transaction = {
        amountInCents: payment.TotalAmt != null ? Math.round(payment.TotalAmt * 100) : 0,
        currency: "usd",
        type: "sale",
        date: payment.TxnDate ?? new Date().toISOString(),
        contactId: null,
        itemIds: [],
        status: "paid",
      };
      return { entityType: "transaction", externalId: payment.Id, data: transaction };
    });

    return [...invoiceRecords, ...paymentRecords];
  },
};
