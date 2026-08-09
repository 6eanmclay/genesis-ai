// Social Connections & Business Intelligence (2026-08-09) — shared, low-
// level Meta Graph API helpers used by both facebook.ts and instagram.ts.
// Facebook and Instagram are two independent StoreIntegration rows/OAuth
// flows (see the IntegrationProvider enum's own comment for why), but both
// go through the same real Meta app, the same OAuth token exchange, and
// the same long-lived-token upgrade — this file is where that real,
// shared mechanics lives once, not duplicated per connector.
//
// API version and every endpoint/scope name here were confirmed against
// Meta's own current developer docs at implementation time (2026-08-09) —
// see the Facebook/Instagram Developer App setup doc this session produced
// for the exact sources. Meta revises its Graph API version and, less
// often, exact metric names — if a live connect/sync ever fails with a
// "metric not supported" or deprecated-version error, re-verify against
// https://developers.facebook.com/docs/graph-api/changelog before assuming
// the integration itself is broken.
export const META_GRAPH_API_VERSION = "v21.0";
export const META_GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;
export const META_OAUTH_DIALOG_URL = "https://www.facebook.com/v21.0/dialog/oauth";
export const META_OAUTH_TOKEN_URL = `${META_GRAPH_BASE}/oauth/access_token`;

// Real permissions, not guessed — see this file's own top comment.
// pages_show_list + pages_read_engagement cover Facebook Page info/
// insights; instagram_basic + instagram_manage_insights cover the linked
// Instagram Business Account. Requested together (one consent screen)
// regardless of which of the two connectors the merchant actually clicked
// first, since Meta's own Business Verification requirement for the
// insights permissions is a one-time app-level approval, not per-connector.
export const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_manage_insights",
].join(",");

export interface MetaUserCredentials {
  schemaVersion: 1;
  // The long-lived USER token (~60 days) — kept only to derive/refresh
  // Page tokens; never used directly for Page/Instagram Graph API calls.
  userAccessToken: string;
  userTokenExpiresAt: number; // epoch ms
}

export async function exchangeCodeForUserToken(params: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(META_OAUTH_TOKEN_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("client_secret", params.clientSecret);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("code", params.code);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Meta token exchange failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 3600 };
}

// A short-lived user token (1-2h) exchanged for a long-lived one (~60
// days) — confirmed against Meta's current docs: this is the real,
// documented step, not an assumption. Page tokens derived FROM this long-
// lived user token (see pageAccessTokenFor below) are themselves
// effectively non-expiring in practice.
export async function exchangeForLongLivedUserToken(params: {
  shortLivedToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(META_OAUTH_TOKEN_URL);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("client_secret", params.clientSecret);
  url.searchParams.set("fb_exchange_token", params.shortLivedToken);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Meta long-lived token exchange failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 60 * 24 * 60 * 60 };
}

export interface MetaPage {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string };
}

// The merchant's connected Facebook Pages, each with its own real Page
// access token (long-lived, effectively non-expiring — confirmed against
// Meta's current docs) and, when linked, the connected Instagram Business
// Account id. Both facebook.ts and instagram.ts call this — Instagram's
// own connect() needs it specifically to find instagram_business_account.
export async function fetchManagedPages(userAccessToken: string): Promise<MetaPage[]> {
  const url = new URL(`${META_GRAPH_BASE}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token,instagram_business_account");
  url.searchParams.set("access_token", userAccessToken);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fetching Facebook Pages failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { data?: MetaPage[] };
  return data.data ?? [];
}

export async function metaGraphGet<T>(path: string, accessToken: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${META_GRAPH_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("access_token", accessToken);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Meta Graph API request to ${path} failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

export function metaClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.FACEBOOK_CLIENT_ID;
  const clientSecret = process.env.FACEBOOK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Facebook/Instagram aren't configured yet — FACEBOOK_CLIENT_ID/FACEBOOK_CLIENT_SECRET are missing. One Meta app covers both."
    );
  }
  return { clientId, clientSecret };
}
