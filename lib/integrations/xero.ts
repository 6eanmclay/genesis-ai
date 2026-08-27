import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { beginOAuthHandoff } from "./oauthState";
import type { ConnectResult, IntegrationConnector, SyncedRecord } from "./types";
import { toStatusView } from "./types";
import { getBaseUrl, integrationCallbackUrl } from "./util";
import { encryptCredentials, decryptCredentials } from "./credentials";
import {
  XERO_API_BASE,
  XERO_CONNECTIONS_URL,
  XERO_REVOCATION_URL,
  XERO_SCOPES,
  XERO_TOKEN_URL,
  chooseTenant,
  classifyXeroFailure,
  credentialsAfterFailedRefresh,
  rotatedCredentials,
  shouldRefresh,
  xeroAuthorizeUrl,
  xeroContactToContact,
  xeroInvoiceToDocument,
  type XeroConnection,
  type XeroContact,
  type XeroFailure,
  type XeroInvoice,
} from "./xeroProtocol";

// XERO — accounting, as the alternative to QuickBooks.
//
// Verified against Xero's own documentation on 2026-08-27. The mapping half
// lives in ./xeroProtocol.ts, pure and testable; this file holds the
// credentials and the network.
//
// ============ WHY XERO ====================================================
//
// CONNECTIONS_MILESTONE.md records that QuickBooks is the only connector that
// has ever produced business data here -- 41 records and 43 of the platform's
// 47 business events -- and that it has been dead since 2026-08-01. Accounting
// data is demonstrably where the value is, and Xero is what a business uses
// when it does not use QuickBooks. This is that same capability for the other
// half of the market, not a new category.
//
// ============ THE ROTATING REFRESH TOKEN ==================================
//
// This is the whole reason to be careful with this connector.
//
// Xero access tokens last THIRTY MINUTES. Refresh tokens ROTATE: exchanging one
// invalidates it and returns a new one. A connector that keeps refreshing with
// the token it first stored works exactly once and then dies with
// invalid_grant -- and dies quietly, because nothing was wrong at the moment
// of connecting.
//
// That is not hypothetical. It is what happened to QuickBooks in this
// codebase, and capabilities.tokenLifetime exists as a field because of it.
// Xero is declared "rotating" and the refresh path stores what came back.
//
// Xero also allows a 30-MINUTE GRACE PERIOD on the old token, specifically so
// a failed round trip can be retried -- which is why a refresh that ERRORS must
// keep what it has rather than clearing it. Discarding on error would turn a
// recoverable network blip into a dead connection.
//
// ============ A TOKEN IS NOT ENOUGH TO READ ANYTHING ======================
//
// One Xero authorization can cover several organisations, and every API call
// needs an explicit Xero-Tenant-Id header. There is no default. This is unlike
// every other connector here, and it is why connect() makes a second call
// before it can claim success.
//
// ============ NOT ONE LIVE CALL HAS BEEN MADE =============================
//
// There is no Xero application yet, so there are no client credentials and no
// consent screen to reach.

export type XeroCredentials = {
  schemaVersion: 1;
  accessToken: string;
  refreshToken: string;
  /** Epoch millis. Thirty minutes from issue. */
  expiresAt: number | null;
  /** The organisation every call names. Without it nothing can be read. */
  tenantId: string | null;
  tenantName: string | null;
};

export function xeroAppCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.XERO_CLIENT_ID?.trim();
  const clientSecret = process.env.XERO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

interface XeroTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

async function exchange(
  grant: Record<string, string>,
): Promise<{ ok: true; value: XeroTokenResponse } | { ok: false; failure: XeroFailure }> {
  const app = xeroAppCredentials();
  if (!app) return { ok: false, failure: { kind: "auth", detail: "Xero is not configured for this deployment." } };

  let response: Response;
  try {
    response = await fetch(XERO_TOKEN_URL, {
      method: "POST",
      headers: {
        // HTTP Basic with the client credentials — Xero's documented scheme
        // for this endpoint. They do not go in the body.
        Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`, "utf8").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(grant).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Network error";
    return { ok: false, failure: { kind: "provider", detail: `Couldn't reach Xero: ${detail}` } };
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, failure: { kind: "provider", detail: "Xero's token response wasn't JSON." } };
  }
  if (!response.ok) return { ok: false, failure: classifyXeroFailure(response.status, body) };

  const token = body as XeroTokenResponse;
  if (!token.access_token || !token.refresh_token) {
    return { ok: false, failure: { kind: "provider", detail: "Xero returned an incomplete token response." } };
  }
  return { ok: true, value: token };
}

async function loadCredentials(storeId: string): Promise<XeroCredentials | null> {
  const row = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId, provider: "XERO" } },
  });
  if (!row?.credentials) return null;
  const credentials = decryptCredentials<XeroCredentials>(row.credentials);
  return credentials?.accessToken ? credentials : null;
}

/** The tenants one authorization actually covers. */
async function fetchConnections(
  accessToken: string,
): Promise<{ ok: true; value: XeroConnection[] } | { ok: false; failure: XeroFailure }> {
  let response: Response;
  try {
    response = await fetch(XERO_CONNECTIONS_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Network error";
    return { ok: false, failure: { kind: "provider", detail: `Couldn't reach Xero: ${detail}` } };
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) return { ok: false, failure: classifyXeroFailure(response.status, body) };
  return { ok: true, value: Array.isArray(body) ? (body as XeroConnection[]) : [] };
}

/**
 * Credentials good right now, refreshing if the access token has expired.
 *
 * THE ROTATION IS HANDLED HERE AND NOWHERE ELSE, so there is one place to get
 * it right rather than one per caller.
 */
async function liveCredentials(storeId: string): Promise<XeroCredentials | null> {
  const credentials = await loadCredentials(storeId);
  if (!credentials) return null;

  // Both halves of this are pure and proven in ./xeroProtocol.ts, so the
  // rotation rule is checkable rather than merely described here.
  if (!shouldRefresh(credentials.expiresAt, Date.now())) return credentials;

  const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: credentials.refreshToken });
  if (!refreshed.ok) {
    // KEEPS WHAT IT HAS -- credentialsAfterFailedRefresh is the identity, and
    // is a named function precisely so "we deliberately did not discard" is a
    // decision in the code rather than an absence of one. Xero honours the old
    // refresh token for 30 minutes so a failed round trip can be retried.
    const kept = credentialsAfterFailedRefresh(credentials);
    console.error(`[xero/refresh] store ${storeId}: ${refreshed.failure.detail}`);
    void kept;
    return null;
  }

  const rotated = rotatedCredentials(refreshed.value, Date.now());
  if (!rotated) return null;
  const next: XeroCredentials = { ...credentials, ...rotated };
  await prisma.storeIntegration.updateMany({
    where: { storeId, provider: "XERO" },
    data: { credentials: encryptCredentials(next), lastError: null },
  });
  return next;
}

async function xeroGet<T>(
  storeId: string,
  path: string,
): Promise<{ ok: true; value: T } | { ok: false; failure: XeroFailure }> {
  const credentials = await liveCredentials(storeId);
  if (!credentials) return { ok: false, failure: { kind: "auth", detail: "Not connected" } };
  if (!credentials.tenantId) {
    return {
      ok: false,
      failure: { kind: "no_tenant", detail: "This Xero connection has no organisation attached to read from." },
    };
  }

  let response: Response;
  try {
    response = await fetch(`${XERO_API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        // REQUIRED ON EVERY CALL. There is no default organisation.
        "Xero-Tenant-Id": credentials.tenantId,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Network error";
    return { ok: false, failure: { kind: "provider", detail: `Couldn't reach Xero: ${detail}` } };
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) return { ok: false, failure: classifyXeroFailure(response.status, body) };
  return { ok: true, value: body as T };
}

export const xeroConnector: IntegrationConnector = {
  provider: "XERO",
  displayName: "Xero (accounting)",
  requiredPermission: PERMISSIONS.ORDERS_MANAGE,
  capabilities: {
    authKind: "oauth",
    scopes: [...XERO_SCOPES],
    reads: ["contact", "document"],
    // Read-only: every accounting scope requested ends in `.read`.
    writes: [],
    // ROTATING, and the field exists because of QuickBooks. Exchanging a
    // refresh token invalidates it and returns a new one; a connector that
    // keeps the original works once and then dies silently.
    tokenLifetime: "rotating",
    // Xero documents a revocation endpoint and disconnect() calls it.
    revokesOnDisconnect: true,
  },

  configured() {
    return xeroAppCredentials() !== null;
  },

  async connect(storeId, userId, params) {
    const app = xeroAppCredentials();
    if (!app) {
      throw new Error("Xero isn't configured for this deployment yet — XERO_CLIENT_ID and XERO_CLIENT_SECRET are missing.");
    }
    const redirectUri = integrationCallbackUrl(await getBaseUrl(), "XERO");

    if (params?.code) {
      const token = await exchange({
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: redirectUri,
      });
      if (!token.ok) throw new Error(token.failure.detail);

      // A SECOND CALL BEFORE SUCCESS CAN BE CLAIMED. A Xero token names no
      // organisation, so a connection stored without a tenant is one that
      // cannot read anything — connected in the database and useless in fact.
      const connections = await fetchConnections(token.value.access_token!);
      if (!connections.ok) throw new Error(connections.failure.detail);

      const tenant = chooseTenant(connections.value);
      if (!tenant) {
        throw new Error(
          "Xero authorised Genesis but didn't share an organisation. In Xero, reconnect and tick the organisation you want Genesis to read.",
        );
      }

      const credentials: XeroCredentials = {
        schemaVersion: 1,
        accessToken: token.value.access_token!,
        refreshToken: token.value.refresh_token!,
        expiresAt: token.value.expires_in ? Date.now() + token.value.expires_in * 1000 : null,
        tenantId: tenant.tenantId ?? null,
        tenantName: tenant.tenantName ?? null,
      };

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "XERO" } },
        create: {
          storeId,
          provider: "XERO",
          status: "CONNECTED",
          externalAccountId: credentials.tenantId,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          externalAccountId: credentials.tenantId,
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
      url: xeroAuthorizeUrl({
        clientId: app.clientId,
        redirectUri,
        state: await beginOAuthHandoff({ storeId, userId, provider: "XERO", executionId: params?.executionId }),
      }),
    } satisfies ConnectResult;
  },

  async verify(storeId) {
    const row = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "XERO" } },
      select: { id: true },
    });
    if (!row) return { ok: false, error: "Not connected" };

    // The organisation endpoint is the cheapest proof: it needs a live token,
    // a valid tenant header, and accounting.settings.read.
    const result = await xeroGet<{ Organisations?: { Name?: string }[] }>(storeId, "/Organisation");
    if (!result.ok) {
      await prisma.storeIntegration.update({
        where: { id: row.id, storeId },
        data: { status: "FAILED", lastError: result.failure.detail, lastVerifiedAt: new Date() },
      });
      return { ok: false, error: result.failure.detail };
    }

    await prisma.storeIntegration.update({
      where: { id: row.id, storeId },
      data: { status: "CONNECTED", lastVerifiedAt: new Date(), lastError: null },
    });
    return { ok: true };
  },

  async disconnect(storeId) {
    const app = xeroAppCredentials();
    const credentials = await loadCredentials(storeId);

    // REVOKED AT XERO, not merely forgotten here.
    if (app && credentials) {
      try {
        await fetch(XERO_REVOCATION_URL, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`, "utf8").toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          // Revoking the refresh token ends the whole grant, not just one
          // access token.
          body: new URLSearchParams({ token: credentials.refreshToken }).toString(),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        // Non-fatal and said out loud — a provider that cannot be reached must
        // not strand a merchant in a connection they asked to end.
        console.error(`[xero/disconnect] revocation failed for store ${storeId}`, error);
      }
    }

    await prisma.storeIntegration.updateMany({
      where: { storeId, provider: "XERO" },
      data: { status: "DISCONNECTED", credentials: undefined, lastError: null },
    });
  },

  async status(storeId) {
    const row = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "XERO" } },
    });
    return toStatusView(row);
  },

  /**
   * What Xero knows, in the Foundation's shapes.
   *
   * Each section degrades on its own — a merchant who granted contacts but not
   * invoices should get their contacts rather than an empty sync.
   */
  async sync(storeId): Promise<SyncedRecord[]> {
    const records: SyncedRecord[] = [];

    const contacts = await xeroGet<{ Contacts?: XeroContact[] }>(storeId, "/Contacts?page=1");
    if (contacts.ok) {
      for (const contact of contacts.value.Contacts ?? []) {
        const mapped = xeroContactToContact(contact);
        if (mapped) records.push({ entityType: "contact", externalId: contact.ContactID!, data: mapped });
      }
    } else {
      console.error(`[xero/sync] contacts unavailable for ${storeId}: ${contacts.failure.detail}`);
    }

    const invoices = await xeroGet<{ Invoices?: XeroInvoice[] }>(storeId, "/Invoices?page=1");
    if (invoices.ok) {
      for (const invoice of invoices.value.Invoices ?? []) {
        const mapped = xeroInvoiceToDocument(invoice);
        if (mapped) records.push({ entityType: "document", externalId: invoice.InvoiceID!, data: mapped });
      }
    } else {
      console.error(`[xero/sync] invoices unavailable for ${storeId}: ${invoices.failure.detail}`);
    }

    return records;
  },
};
