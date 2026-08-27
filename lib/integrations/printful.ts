import { prisma } from "@/lib/prisma";
import { describeProviderError } from "./providerError";
import { PERMISSIONS } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { ConnectResult, IntegrationConnector } from "./types";
import { toStatusView } from "./types";
import { getBaseUrl, integrationCallbackUrl } from "./util";
import { encryptCredentials, decryptCredentials } from "./credentials";
import { integrationFetch } from "./rateLimit";
import { beginOAuthHandoff } from "./oauthState";

// Onboarding v2 — the OAuth auth backbone for Printful, the first
// fulfillment-strategy connector (see lib/fulfillment/printful.ts for what
// this connector's credentials are actually used to DO once connected —
// browsing the catalog, pricing, creating products/orders — deliberately
// kept separate from this file, since IntegrationConnector.sync()'s shape
// doesn't fit a fulfillment catalog; see ONBOARDING_V2_IMPLEMENTATION.md
// section 4). Real OAuth flow verified directly against Printful's own
// docs (developers.printful.com) before writing this, not assumed:
// authorize -> redirect+code -> token exchange -> 1hr access token + 90-day
// refresh token, the same overall shape as Stripe/QuickBooks/Google
// Calendar, with one real naming difference (redirect_url, not
// redirect_uri) preserved exactly below.

export type PrintfulCredentials = {
  schemaVersion: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  printfulStoreId: number;
};

const AUTHORIZE_URL = "https://www.printful.com/oauth/authorize";
const TOKEN_URL = "https://www.printful.com/oauth/token";
export const PRINTFUL_API_BASE = "https://api.printful.com";

// Shared by both the standard (post-Store) connect flow and the draft-phase
// onboarding flow (app/api/onboarding/fulfillment/callback/route.ts) — the
// only difference between the two callers is what `state` carries
// (storeId vs. a draft-phase compound value), never the URL shape itself.
export function buildPrintfulAuthorizeUrl(redirectUrl: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", requireClientId());
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_url", redirectUrl);
  return url.toString();
}

function requireClientId(): string {
  const clientId = process.env.PRINTFUL_CLIENT_ID;
  if (!clientId) {
    throw new Error("Printful isn't configured yet — PRINTFUL_CLIENT_ID is missing.");
  }
  return clientId;
}

interface PrintfulTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds, per Printful's own docs
}

// Exported so the draft-phase callback route (which has no Store/
// StoreIntegration to attach credentials to yet) can exchange the code and
// discover the merchant's Printful store id itself, without going through
// connect()'s storeId-shaped call site.
export async function exchangePrintfulCode(code: string, redirectUrl: string): Promise<PrintfulCredentials> {
  const clientId = requireClientId();
  const clientSecret = process.env.PRINTFUL_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error("Printful isn't configured yet — PRINTFUL_CLIENT_SECRET is missing.");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_url: redirectUrl,
    }),
  });
  if (!res.ok) {
    throw new Error(
      describeProviderError({ provider: "Printful", status: res.status, bodyText: await res.text(), stage: "token exchange" })
    );
  }
  const token = (await res.json()) as PrintfulTokenResponse;

  // A Public App token is store-scoped from the start — Printful returns
  // exactly one store for the merchant who just authorized (confirmed
  // directly against a real account during validation: GET /stores lists
  // the "Personal orders"-style native store every account has).
  const storesRes = await fetch(`${PRINTFUL_API_BASE}/stores`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!storesRes.ok) {
    throw new Error(`Printful store lookup failed after connect (${storesRes.status})`);
  }
  const storesBody = (await storesRes.json()) as { result?: { id: number }[] };
  const printfulStoreId = storesBody.result?.[0]?.id;
  if (!printfulStoreId) {
    throw new Error("Printful connected, but no store was found on that account.");
  }

  return {
    schemaVersion: 1,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: token.expires_at * 1000,
    printfulStoreId,
  };
}

export async function refreshPrintfulToken(credentials: PrintfulCredentials): Promise<PrintfulCredentials> {
  if (credentials.expiresAt > Date.now() + 60_000) {
    return credentials;
  }
  const clientId = requireClientId();
  const clientSecret = process.env.PRINTFUL_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error("Printful isn't configured yet — PRINTFUL_CLIENT_SECRET is missing.");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: credentials.refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Printful token refresh failed (${res.status})`);
  }
  const token = (await res.json()) as PrintfulTokenResponse;
  return {
    ...credentials,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: token.expires_at * 1000,
  };
}

export const printfulConnector: IntegrationConnector = {
  provider: "PRINTFUL",
  displayName: "Printful",
  requiredPermission: PERMISSIONS.CONNECTIONS_MANAGE,
  capabilities: {
    authKind: "oauth",
    // Printful returns a refresh_token on every renewal, so it is treated as
    // rotating and the new value is always persisted.
    tokenLifetime: "rotating",
    scopes: [],
    noScopesReason:
      "Printful's OAuth flow takes no scope parameter — a private token carries whatever scopes the merchant granted it in their own developer portal, and the app cannot narrow them from here.",
    reads: [],
    writes: ["submits fulfillment orders on the merchant's behalf"],
    // Not a gap, and the earlier note here claiming otherwise was wrong.
    // Printful documents no revocation endpoint at all — its OAuth docs cover
    // authorize, token, refresh and scopes, and nothing else; a private token
    // "remains valid until it expires or is manually deleted" in their own
    // developer portal. There is no honest call to make, so disconnect clears
    // our copy and the merchant removes the app on Printful's side.
    revokesOnDisconnect: false,
  },

  // BOTH HALVES OF THE OAUTH CREDENTIAL, OR IT IS NOT CONFIGURED.
  //
  // buildPrintfulAuthorizeUrl needs the id and the token exchange needs the
  // secret, so having one without the other is an offer that fails a step
  // later — after the person has left for Printful and come back. This is
  // what lets a Connect button be absent instead of broken, and it is now
  // read by the creation flow as well as the connections screen.
  configured() {
    return Boolean(process.env.PRINTFUL_CLIENT_ID && process.env.PRINTFUL_CLIENT_SECRET);
  },

  async connect(storeId, userId, params) {
    if (params?.code) {
      const baseUrl = await getBaseUrl();
      const credentials = await exchangePrintfulCode(params.code, integrationCallbackUrl(baseUrl, "PRINTFUL"));

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "PRINTFUL" } },
        create: {
          storeId,
          provider: "PRINTFUL",
          status: "CONNECTED",
          externalAccountId: String(credentials.printfulStoreId),
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          externalAccountId: String(credentials.printfulStoreId),
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });

      return { kind: "connected" };
    }

    // ============ THE STATE HAS TO BE A SIGNED HANDOFF ==================
    //
    // THE BUG, 2026-08-27. This passed the raw `storeId` as `state`, which is
    // what every OAuth connector here did before Phase 0 and what none of them
    // does now. The shared callback verifies `state` with completeOAuthHandoff:
    // a bare cuid has no `.`, so it failed at the first check as "malformed",
    // storeId came back null, and the route redirected to
    // /dashboard/connections?integration_error=printful.
    //
    // Every single attempt. Printful's authorize screen appeared, the owner
    // approved it, and the connection could never complete — which is exactly
    // what Sean saw. Printful was the last connector still on the old shape,
    // missed when Phase 0 converted the other ten, and nothing caught it
    // because no test drove Printful through the real callback.
    //
    // The handoff also carries this attempt's executionId, so the callback
    // closes its own ExecutionLog row instead of guessing at the newest
    // PENDING one, and `returnTo`, so a supplier connected from inside the
    // Creation Station comes back to what the owner was making.
    const baseUrl = await getBaseUrl();
    const url = buildPrintfulAuthorizeUrl(
      integrationCallbackUrl(baseUrl, "PRINTFUL"),
      await beginOAuthHandoff({
        storeId,
        userId,
        provider: "PRINTFUL",
        executionId: params?.executionId,
        returnTo: params?.returnTo,
      })
    );
    return { kind: "redirect", url } satisfies ConnectResult;
  },

  async verify(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "PRINTFUL" } },
    });
    if (!integration?.credentials) {
      return { ok: false, error: "Not connected" };
    }

    try {
      const credentials = decryptCredentials<PrintfulCredentials>(integration.credentials);
      const refreshed = await refreshPrintfulToken(credentials);
      // Persist it. refreshPrintfulToken RETURNS new credentials rather than
      // storing them, and lib/fulfillment/printful.ts saves what it gets back —
      // but this path did not, so a Recheck that happened to trigger a refresh
      // threw away the rotated refresh token and left the stored one retired.
      if (refreshed.accessToken !== credentials.accessToken) {
        await prisma.storeIntegration.update({
          where: { id: integration.id, storeId },
          data: { credentials: encryptCredentials(refreshed) },
        });
      }
      // Printful documents 120 calls/minute but does not document the status
      // code it returns when you exceed it. 429 is handled defensively rather
      // than claiming to know — if they use something else, this simply never
      // fires, which is the honest failure mode for an undocumented detail.
      const res = await integrationFetch(
        `${PRINTFUL_API_BASE}/stores`,
        { headers: { Authorization: `Bearer ${refreshed.accessToken}` } },
        { label: "Printful" }
      );
      const ok = res.ok;
      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId },
        data: {
          status: ok ? "CONNECTED" : "NEEDS_ATTENTION",
          credentials: ok ? encryptCredentials(refreshed) : undefined,
          lastVerifiedAt: new Date(),
          lastError: ok ? null : `Printful check failed (${res.status})`,
        },
      });
      return ok ? { ok: true } : { ok: false, error: `Printful check failed (${res.status})` };
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
      where: { storeId_provider: { storeId, provider: "PRINTFUL" } },
    });
    if (!integration) return;
    await prisma.storeIntegration.update({
      where: { id: integration.id, storeId },
      data: { status: "DISCONNECTED", credentials: Prisma.DbNull },
    });
  },

  async status(storeId) {
    // Phase 0 — never returns the credentials blob.
    return toStatusView(
      await prisma.storeIntegration.findUnique({
        where: { storeId_provider: { storeId, provider: "PRINTFUL" } },
      })
    );
  },

  // Deliberately no sync() — Printful isn't a source of the store's own
  // business activity (the shape sync() exists for); it's a fulfillment
  // catalog, accessed through lib/fulfillment/printful.ts instead.
};
