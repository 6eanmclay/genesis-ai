import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { beginOAuthHandoff } from "./oauthState";
import type { ConnectResult, IntegrationConnector } from "./types";
import { toStatusView } from "./types";
import { getBaseUrl, integrationCallbackUrl } from "./util";
import { encryptCredentials, decryptCredentials } from "./credentials";
import {
  buildSignedParams,
  configuredSignMethod,
  readFailure,
  type AliexpressFailure,
} from "@/lib/sourcing/aliexpressProtocol";

// ALIEXPRESS, AS A PER-MERCHANT CONNECTION.
//
// ============ WHY THIS EXISTS ALONGSIDE lib/sourcing/aliexpress.ts ========
//
// Those are two different things and it is worth being precise about which.
//
//   lib/sourcing/aliexpress.ts   a ProductSource. Searches the catalog using
//                                GENESIS's own app credentials. No merchant is
//                                involved, nothing is stored per store.
//
//   this file                    an IntegrationConnector. An OAuth grant from
//                                ONE merchant's AliExpress account, stored
//                                encrypted against their store.
//
// AliExpress splits its API the same way, which is why Genesis has to. The
// AFFILIATE group -- product search, product detail, freight -- authenticates
// with the app key and secret alone. The DROPSHIPPING group -- placing an order,
// tracking it -- authenticates as an AliExpress ACCOUNT, and no app credential
// substitutes for that.
//
// ============ WHOSE ACCOUNT PAYS, AND WHY IT IS THE MERCHANT'S ============
//
// The alternative was Genesis holding one AliExpress account and ordering on
// every merchant's behalf. That is the postage-float model Sean has already
// ruled out in another form, for the reason that applies identically here:
// Genesis should not become the party holding, fronting, recovering, refunding
// or reconciling somebody else's supplier money.
//
// So the grant is per merchant, the token belongs to their store, and their
// orders are paid from their own account. It is the same shape Printful
// already has, which is not a coincidence -- it is the shape that keeps a
// platform out of the middle of a payment.
//
// ============ WHAT IS AND IS NOT PROVEN HERE =============================
//
// NOT ONE LIVE CALL HAS BEEN MADE. There is no AliExpress app yet, so there are
// no client credentials and no consent screen to send anybody to. What this
// file makes true is narrower and is the thing that was blocking the
// application: the callback URL submitted on the form now RESOLVES. Before
// this, /api/integrations/aliexpress/callback threw "Unknown integration
// provider" -- the generic route looks the connector up by name, and AliExpress
// was a sourcing source with no connector behind it.
//
// The token endpoint and its parameters are written from AliExpress's published
// material and its maintained SDKs; the authorization host is the one its
// consent flow uses. Both are marked in ALIEXPRESS_REQUIREMENTS_VERIFIED.md as
// settled only by the first real handoff.

/** Where the merchant is sent to consent. */
const AUTHORIZE_URL = "https://api-sg.aliexpress.com/oauth/authorize";

/**
 * Token creation and refresh.
 *
 * These are ROUTED THROUGH THE SIGNED GATEWAY like every other call rather than
 * being plain OAuth endpoints — AliExpress's token exchange is itself a signed
 * API method, which is unusual enough to be worth saying out loud. A developer
 * expecting a bare `POST /token` with a client secret in the body will get an
 * IllegalAppKey and have no idea why.
 */
const TOKEN_METHOD = "/auth/token/create";
const REFRESH_METHOD = "/auth/token/refresh";
const REST_GATEWAY = "https://api-sg.aliexpress.com/rest";

export type AliexpressCredentials = {
  schemaVersion: 1;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch millis, or null where AliExpress did not say. */
  expiresAt: number | null;
  /** The merchant's AliExpress account id, for display and for support. */
  accountId: string | null;
};

/** Platform credentials — one app, shared by every merchant who connects. */
export function aliexpressAppCredentials(): { appKey: string; appSecret: string } | null {
  const appKey = process.env.ALIEXPRESS_APP_KEY?.trim();
  const appSecret = process.env.ALIEXPRESS_APP_SECRET?.trim();
  if (!appKey || !appSecret) return null;
  return { appKey, appSecret };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  user_id?: string;
  user_nick?: string;
}

/**
 * Exchange a code, or refresh a token.
 *
 * ONE FUNCTION FOR BOTH because they differ only in the method and the single
 * parameter carrying the grant. Two near-identical copies is how one of them
 * ends up fixed and the other does not.
 */
async function callTokenEndpoint(
  method: string,
  grant: Record<string, string>,
): Promise<{ ok: true; value: TokenResponse } | { ok: false; failure: AliexpressFailure }> {
  const app = aliexpressAppCredentials();
  if (!app) {
    return { ok: false, failure: { kind: "auth", detail: "AliExpress is not configured for this deployment." } };
  }

  const params = buildSignedParams({
    method,
    appKey: app.appKey,
    appSecret: app.appSecret,
    args: grant,
    signMethod: configuredSignMethod(),
  });

  let response: Response;
  try {
    response = await fetch(`${REST_GATEWAY}${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Network error";
    return { ok: false, failure: { kind: "provider", detail: `Couldn't reach AliExpress: ${detail}` } };
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, failure: { kind: "provider", detail: "AliExpress's token response wasn't JSON." } };
  }

  // THE BODY DECIDES, NOT THE STATUS — AliExpress answers 200 for failures.
  const failure = readFailure(body);
  if (failure) return { ok: false, failure };

  const token = body as TokenResponse;
  if (!token.access_token) {
    return { ok: false, failure: { kind: "provider", detail: "AliExpress returned no access token." } };
  }
  return { ok: true, value: token };
}

function credentialsFrom(token: TokenResponse): AliexpressCredentials {
  // `expires_in` arrives as seconds, sometimes as a string. Null where absent —
  // an expiry invented from a default would make a live token look dead, or a
  // dead one look live, and the second is worse.
  const seconds = token.expires_in != null ? Number(token.expires_in) : NaN;
  return {
    schemaVersion: 1,
    accessToken: token.access_token!,
    refreshToken: token.refresh_token ?? null,
    expiresAt: Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : null,
    accountId: token.user_id ?? null,
  };
}

export const aliexpressConnector: IntegrationConnector = {
  provider: "ALIEXPRESS",
  displayName: "AliExpress (wholesale sourcing)",
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,
  capabilities: {
    authKind: "oauth",
    // AliExpress grants whole-account access on consent and takes no scope
    // parameter, which the owner deserves to be told plainly. An empty array
    // must mean "none exist", never "nobody filled this in" — which is exactly
    // why the contract requires this field alongside it.
    scopes: [],
    noScopesReason:
      "AliExpress's authorization flow takes no scope parameter — consent grants the app access to the API groups the app itself was approved for, decided at application time rather than per merchant.",
    // NOTHING. This connection exists to ACT on the merchant's behalf, not to
    // learn about their business — the products it finds are written by the
    // sourcing layer as SourcedProduct rows, not as BusinessRecords, and
    // claiming a read here would put an entity type into the Foundation that
    // nothing produces.
    reads: [],
    writes: ["places orders with AliExpress suppliers, which spends the merchant's own money"],
    // AliExpress issues a refresh token and the access token expires. Whether
    // the refresh token itself rotates is NOT confirmed — see the note in
    // refresh handling below. "expires" is the honest floor.
    tokenLifetime: "expires",
    // No documented revocation endpoint was found. False is the honest answer;
    // the merchant withdraws access from their own AliExpress account settings,
    // which the disconnect copy tells them.
    revokesOnDisconnect: false,
  },

  configured() {
    return aliexpressAppCredentials() !== null;
  },

  async connect(storeId, userId, params) {
    const app = aliexpressAppCredentials();
    if (!app) {
      throw new Error(
        "AliExpress isn't configured for this deployment yet — ALIEXPRESS_APP_KEY and ALIEXPRESS_APP_SECRET are missing.",
      );
    }
    const redirectUri = integrationCallbackUrl(await getBaseUrl(), "ALIEXPRESS");

    // Second call: AliExpress's callback round-tripped with a code.
    if (params?.code) {
      const token = await callTokenEndpoint(TOKEN_METHOD, { code: params.code, uuid: storeId });
      if (!token.ok) throw new Error(token.failure.detail);

      const credentials = credentialsFrom(token.value);
      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "ALIEXPRESS" } },
        create: {
          storeId,
          provider: "ALIEXPRESS",
          status: "CONNECTED",
          externalAccountId: credentials.accountId,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          externalAccountId: credentials.accountId,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });
      return { kind: "connected" };
    }

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", app.appKey);
    url.searchParams.set("redirect_uri", redirectUri);
    // Signed, single-use, session-bound and expiring — the storeId is never in
    // the redirect in plain sight, so a crafted callback cannot bind an
    // AliExpress account to a store this server never started a flow for.
    url.searchParams.set(
      "state",
      await beginOAuthHandoff({ storeId, userId, provider: "ALIEXPRESS", executionId: params?.executionId }),
    );

    return { kind: "redirect", url: url.toString() } satisfies ConnectResult;
  },

  async verify(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "ALIEXPRESS" } },
    });
    if (!integration?.credentials) return { ok: false, error: "Not connected" };

    const credentials = decryptCredentials<AliexpressCredentials>(integration.credentials);
    if (!credentials?.accessToken) return { ok: false, error: "Not connected" };

    // ============ AN EXPIRY IS NOT A FAILURE IF IT CAN BE REFRESHED ========
    //
    // Checked BEFORE any call, because the alternative is discovering it as an
    // auth error that looks identical to a revoked grant — and telling an owner
    // to reconnect when nothing was wrong is the specific failure the
    // connection-truthfulness work exists to prevent.
    const expired = credentials.expiresAt !== null && credentials.expiresAt <= Date.now();
    if (expired && credentials.refreshToken) {
      const refreshed = await callTokenEndpoint(REFRESH_METHOD, { refresh_token: credentials.refreshToken });
      if (!refreshed.ok) {
        await prisma.storeIntegration.update({
          where: { id: integration.id, storeId },
          data: { status: "FAILED", lastError: refreshed.failure.detail, lastVerifiedAt: new Date() },
        });
        return { ok: false, error: refreshed.failure.detail };
      }

      // ============ KEEP THE NEW REFRESH TOKEN =============================
      //
      // Whether AliExpress rotates refresh tokens is NOT confirmed. This keeps
      // whichever one came back and falls back to the old one only when none
      // did — which is correct under both behaviours, and is the mistake that
      // took QuickBooks down for eighteen days when it was got wrong there.
      const next = credentialsFrom(refreshed.value);
      const merged: AliexpressCredentials = {
        ...next,
        refreshToken: next.refreshToken ?? credentials.refreshToken,
        accountId: next.accountId ?? credentials.accountId,
      };
      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId },
        data: {
          status: "CONNECTED",
          credentials: encryptCredentials(merged),
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });
      return { ok: true };
    }

    if (expired) {
      const message = "The AliExpress connection expired and there's no refresh token to renew it. Reconnect to continue.";
      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId },
        data: { status: "FAILED", lastError: message, lastVerifiedAt: new Date() },
      });
      return { ok: false, error: message };
    }

    await prisma.storeIntegration.update({
      where: { id: integration.id, storeId },
      data: { status: "CONNECTED", lastVerifiedAt: new Date(), lastError: null },
    });
    return { ok: true };
  },

  async disconnect(storeId) {
    // No documented revocation endpoint — see revokesOnDisconnect. The token is
    // forgotten here and remains valid at AliExpress until the merchant
    // withdraws it in their own account settings.
    await prisma.storeIntegration.updateMany({
      where: { storeId, provider: "ALIEXPRESS" },
      data: { status: "DISCONNECTED", credentials: undefined, lastError: null },
    });
  },

  async status(storeId) {
    const row = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "ALIEXPRESS" } },
    });
    return toStatusView(row);
  },

  // NO sync(). What this connection produces is orders and tracking, both of
  // which belong to the order lifecycle rather than to the Foundation's
  // business-record store. A sync() returning [] would make "connected and
  // producing nothing" the permanent state of a connector working correctly.
};

/** The merchant's live token, refreshing first if it has expired. */
export async function aliexpressAccessToken(storeId: string): Promise<string | null> {
  const verified = await aliexpressConnector.verify(storeId);
  if (!verified.ok) return null;
  const integration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId, provider: "ALIEXPRESS" } },
  });
  if (!integration?.credentials) return null;
  return decryptCredentials<AliexpressCredentials>(integration.credentials)?.accessToken ?? null;
}
