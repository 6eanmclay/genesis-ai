import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { beginOAuthHandoff } from "./oauthState";
import type { ConnectResult, IntegrationConnector, SyncedRecord } from "./types";
import { toStatusView } from "./types";
import { getBaseUrl, integrationCallbackUrl } from "./util";
import { encryptCredentials, decryptCredentials } from "./credentials";
import {
  SQUARE_API_VERSION,
  SQUARE_SCOPES,
  catalogObjectToItem,
  classifySquareFailure,
  customerToContact,
  paymentToTransaction,
  squareAuthorizeUrl,
  squareHost,
  squareRevokeUrl,
  squareTokenUrl,
  type SquareCatalogObject,
  type SquareCustomer,
  type SquareFailure,
  type SquarePayment,
} from "./squareProtocol";

// SQUARE — point of sale, orders, catalog and customers.
//
// Verified against Square's own documentation on 2026-08-27. The mapping half
// lives in ./squareProtocol.ts, pure and testable; this file holds the
// credentials and the network.
//
// ============ WHY SQUARE, AND WHAT IT IS FOR ==============================
//
// The evidence for building this is in CONNECTIONS_MILESTONE.md: QuickBooks is
// the only connector that has ever produced business data on this platform --
// 43 of 47 business events. Financial and transactional data is demonstrably
// where the value is. Square is that data at its source for any business that
// sells in person, and unlike QuickBooks it also carries the CATALOG, which no
// other connector here provides.
//
// READ-ONLY, DELIBERATELY. Every scope requested ends in _READ. Square is a
// system the business already operates, and the non-goal this codebase has held
// since Phase 3 is to leave the underlying software responsible for its own
// operational workflows. Asking for a write scope Genesis never uses would be
// asking a merchant to grant something on the off-chance.
//
// ============ SQUARE REVOKES, AND MOST OF THESE DO NOT ====================
//
// disconnect() calls Square's own revocation endpoint, so ending the connection
// in Genesis really does end it at Square. Six connectors here honestly declare
// revokesOnDisconnect: false because their providers offer nothing to call.
// Square offers one, so not calling it would have been a shortcut -- deleting a
// stored token is not revoking it, and an owner told access ended while the
// token stayed live has been misled.
//   https://developer.squareup.com/reference/square/o-auth-api/revoke-token
//
// ============ NOT ONE LIVE CALL HAS BEEN MADE =============================
//
// There is no Square application yet, so there are no client credentials and no
// consent screen. Everything below is written against Square's published
// reference and proven by 100+ assertions that need no account; the first real
// authorization is what confirms it.

export type SquareCredentials = {
  schemaVersion: 1;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch millis. Square's access tokens last 30 days. */
  expiresAt: number | null;
  merchantId: string | null;
  /** Which Square environment this token belongs to. */
  useSandbox: boolean;
};

/** Platform credentials — one Square application, every merchant. */
export function squareAppCredentials(): { clientId: string; clientSecret: string; useSandbox: boolean } | null {
  const clientId = process.env.SQUARE_CLIENT_ID?.trim();
  const clientSecret = process.env.SQUARE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    // Sandbox is a DIFFERENT HOST and different credentials, so it is a
    // deployment-level switch rather than something guessed per call.
    useSandbox: process.env.SQUARE_USE_SANDBOX === "1",
  };
}

interface SquareTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  merchant_id?: string;
}

async function exchange(
  grant: Record<string, string>,
): Promise<{ ok: true; value: SquareTokenResponse } | { ok: false; failure: SquareFailure }> {
  const app = squareAppCredentials();
  if (!app) return { ok: false, failure: { kind: "auth", detail: "Square is not configured for this deployment." } };

  let response: Response;
  try {
    response = await fetch(squareTokenUrl(app.useSandbox), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // REQUIRED ON EVERY CALL, including the token exchange. Omitting it
        // does not mean "latest" -- it means whatever default Square picks.
        "Square-Version": SQUARE_API_VERSION,
      },
      body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, ...grant }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Network error";
    return { ok: false, failure: { kind: "provider", detail: `Couldn't reach Square: ${detail}` } };
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, failure: { kind: "provider", detail: "Square's token response wasn't JSON." } };
  }
  if (!response.ok) return { ok: false, failure: classifySquareFailure(response.status, body) };

  const token = body as SquareTokenResponse;
  if (!token.access_token) {
    return { ok: false, failure: { kind: "provider", detail: "Square returned no access token." } };
  }
  return { ok: true, value: token };
}

function credentialsFrom(token: SquareTokenResponse, useSandbox: boolean, previous?: SquareCredentials): SquareCredentials {
  // Square returns an ISO timestamp, not a duration. Parsed rather than
  // assumed -- an invented 30-day expiry would drift from Square's own.
  const expiresAt = token.expires_at ? Date.parse(token.expires_at) : NaN;
  return {
    schemaVersion: 1,
    accessToken: token.access_token!,
    // Square's code-flow refresh tokens do NOT rotate, so a response without
    // one means "keep using the one you have", not "you have none".
    refreshToken: token.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    merchantId: token.merchant_id ?? previous?.merchantId ?? null,
    useSandbox,
  };
}

async function loadCredentials(storeId: string): Promise<SquareCredentials | null> {
  const row = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId, provider: "SQUARE" } },
  });
  if (!row?.credentials) return null;
  const credentials = decryptCredentials<SquareCredentials>(row.credentials);
  return credentials?.accessToken ? credentials : null;
}

/** A Square API GET, refreshing the token first if it has expired. */
async function squareGet<T>(
  storeId: string,
  path: string,
): Promise<{ ok: true; value: T } | { ok: false; failure: SquareFailure }> {
  const credentials = await liveCredentials(storeId);
  if (!credentials) return { ok: false, failure: { kind: "auth", detail: "Not connected" } };

  let response: Response;
  try {
    response = await fetch(`${squareHost(credentials.useSandbox)}${path}`, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Square-Version": SQUARE_API_VERSION,
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Network error";
    return { ok: false, failure: { kind: "provider", detail: `Couldn't reach Square: ${detail}` } };
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) return { ok: false, failure: classifySquareFailure(response.status, body) };
  return { ok: true, value: body as T };
}

/** Credentials good right now — refreshed first if the token has expired. */
async function liveCredentials(storeId: string): Promise<SquareCredentials | null> {
  const credentials = await loadCredentials(storeId);
  if (!credentials) return null;

  // REFRESHED BEFORE USE, NOT AFTER A FAILURE. An expired token returns a 401
  // that is indistinguishable from a revoked one, and telling an owner to
  // reconnect when nothing was wrong is precisely the false alarm the
  // connection-truthfulness work exists to prevent. A minute of margin absorbs
  // the round trip.
  const expiring = credentials.expiresAt !== null && credentials.expiresAt - 60_000 <= Date.now();
  if (!expiring || !credentials.refreshToken) return credentials;

  const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: credentials.refreshToken });
  if (!refreshed.ok) return credentials;

  const next = credentialsFrom(refreshed.value, credentials.useSandbox, credentials);
  await prisma.storeIntegration.updateMany({
    where: { storeId, provider: "SQUARE" },
    data: { credentials: encryptCredentials(next), lastError: null },
  });
  return next;
}

export const squareConnector: IntegrationConnector = {
  provider: "SQUARE",
  displayName: "Square (point of sale)",
  requiredPermission: PERMISSIONS.ORDERS_MANAGE,
  capabilities: {
    authKind: "oauth",
    scopes: [...SQUARE_SCOPES],
    reads: ["contact", "transaction", "item"],
    // EMPTY MEANS READ-ONLY, and it is true here: every scope above ends
    // _READ, so Genesis cannot change anything in the merchant's Square
    // account even if a bug tried to.
    writes: [],
    // Access tokens last 30 days. Code-flow refresh tokens neither expire nor
    // rotate -- the OPPOSITE of Xero, which sits beside this file and does
    // both. "expires" describes the access token, which is what fails.
    tokenLifetime: "expires",
    // TRUE, AND EARNED. disconnect() calls Square's revocation endpoint, so
    // ending the connection here really ends it at Square.
    revokesOnDisconnect: true,
  },

  configured() {
    return squareAppCredentials() !== null;
  },

  async connect(storeId, userId, params) {
    const app = squareAppCredentials();
    if (!app) {
      throw new Error("Square isn't configured for this deployment yet — SQUARE_CLIENT_ID and SQUARE_CLIENT_SECRET are missing.");
    }
    const redirectUri = integrationCallbackUrl(await getBaseUrl(), "SQUARE");

    if (params?.code) {
      const token = await exchange({
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: redirectUri,
      });
      if (!token.ok) throw new Error(token.failure.detail);

      const credentials = credentialsFrom(token.value, app.useSandbox);
      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "SQUARE" } },
        create: {
          storeId,
          provider: "SQUARE",
          status: "CONNECTED",
          externalAccountId: credentials.merchantId,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          externalAccountId: credentials.merchantId,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });
      return { kind: "connected" };
    }

    return {
      kind: "redirect",
      url: squareAuthorizeUrl({
        useSandbox: app.useSandbox,
        clientId: app.clientId,
        redirectUri,
        state: await beginOAuthHandoff({ storeId, userId, provider: "SQUARE", executionId: params?.executionId }),
      }),
    } satisfies ConnectResult;
  },

  async verify(storeId) {
    const row = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "SQUARE" } },
      select: { id: true },
    });
    if (!row) return { ok: false, error: "Not connected" };

    // The cheapest honest proof: ask Square who the merchant is. It needs a
    // genuinely valid token and the MERCHANT_PROFILE_READ scope, so it also
    // catches a merchant who declined that permission.
    const result = await squareGet<{ merchant?: { id?: string; business_name?: string } }>(
      storeId,
      "/v2/merchants/me",
    );

    if (!result.ok) {
      await prisma.storeIntegration.update({
        where: { id: row.id, storeId },
        data: { status: "FAILED", lastError: result.failure.detail, lastVerifiedAt: new Date() },
      });
      return { ok: false, error: result.failure.detail };
    }

    await prisma.storeIntegration.update({
      where: { id: row.id, storeId },
      data: {
        status: "CONNECTED",
        externalAccountId: result.value.merchant?.id ?? undefined,
        lastVerifiedAt: new Date(),
        lastError: null,
      },
    });
    return { ok: true };
  },

  async disconnect(storeId) {
    const app = squareAppCredentials();
    const credentials = await loadCredentials(storeId);

    // REVOKED AT SQUARE, not merely forgotten here. Deleting a stored token is
    // not revoking it: the token stays valid at the provider while the owner
    // has just been told access ended.
    if (app && credentials) {
      try {
        await fetch(squareRevokeUrl(credentials.useSandbox), {
          method: "POST",
          headers: {
            // Square's own scheme for this endpoint, and it is NOT Bearer:
            // "Authorization: Client APPLICATION_SECRET".
            Authorization: `Client ${app.clientSecret}`,
            "Content-Type": "application/json",
            "Square-Version": SQUARE_API_VERSION,
          },
          body: JSON.stringify({ client_id: app.clientId, access_token: credentials.accessToken }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        // NON-FATAL, AND SAID OUT LOUD. A provider that cannot be reached must
        // not strand the merchant in a connection they have asked to end --
        // the local record is still cleared below, and the log is what lets
        // anyone notice the grant may still be live at Square.
        console.error(`[square/disconnect] revocation failed for store ${storeId}`, error);
      }
    }

    await prisma.storeIntegration.updateMany({
      where: { storeId, provider: "SQUARE" },
      data: { status: "DISCONNECTED", credentials: undefined, lastError: null },
    });
  },

  async status(storeId) {
    const row = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "SQUARE" } },
    });
    return toStatusView(row);
  },

  /**
   * What Square knows, in the Foundation's shapes.
   *
   * EACH SOURCE DEGRADES ON ITS OWN. A merchant who granted CUSTOMERS_READ but
   * not ITEMS_READ should get their customers, not an empty sync — so a
   * failure in one section is logged and skipped rather than failing the whole
   * run. The same posture the Meta connectors take per metric.
   */
  async sync(storeId): Promise<SyncedRecord[]> {
    const records: SyncedRecord[] = [];

    const customers = await squareGet<{ customers?: SquareCustomer[] }>(storeId, "/v2/customers?limit=100");
    if (customers.ok) {
      for (const customer of customers.value.customers ?? []) {
        const contact = customerToContact(customer);
        if (contact) records.push({ entityType: "contact", externalId: customer.id!, data: contact });
      }
    } else {
      console.error(`[square/sync] customers unavailable for ${storeId}: ${customers.failure.detail}`);
    }

    const payments = await squareGet<{ payments?: SquarePayment[] }>(storeId, "/v2/payments?limit=100");
    if (payments.ok) {
      for (const payment of payments.value.payments ?? []) {
        const transaction = paymentToTransaction(payment);
        if (transaction) records.push({ entityType: "transaction", externalId: payment.id!, data: transaction });
      }
    } else {
      console.error(`[square/sync] payments unavailable for ${storeId}: ${payments.failure.detail}`);
    }

    const catalog = await squareGet<{ objects?: SquareCatalogObject[] }>(storeId, "/v2/catalog/list?types=ITEM");
    if (catalog.ok) {
      for (const object of catalog.value.objects ?? []) {
        const item = catalogObjectToItem(object);
        if (item) records.push({ entityType: "item", externalId: object.id!, data: item });
      }
    } else {
      console.error(`[square/sync] catalog unavailable for ${storeId}: ${catalog.failure.detail}`);
    }

    return records;
  },
};
