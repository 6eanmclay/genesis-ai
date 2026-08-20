import { prisma } from "@/lib/prisma";
import { beginOAuthHandoff } from "./oauthState";
import { integrationFetch } from "./rateLimit";
import { PERMISSIONS } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { ConnectResult, IntegrationConnector, SyncedRecord } from "./types";
import { toStatusView } from "./types";
import { getBaseUrl, integrationCallbackUrl } from "./util";
import { encryptCredentials, decryptCredentials } from "./credentials";
import type { SocialAccount } from "@/lib/businessModel/entities";
import { generateSocialInsight } from "@/lib/execution/socialInsight";

// Social Connections & Business Intelligence (2026-08-09) — "TikTok
// should be implemented to the extent permitted by its current official
// API/scopes, with the capability clearly separated between profile
// statistics, content data and deeper analytics that may require
// additional approval" (Sean). Real, confirmed-current (2026-08-09) TikTok
// for Developers endpoints/scopes — see SOCIAL_CONNECTIONS_SETUP.md for
// exactly what to register.
//
// Honest capability boundary, not a partial/broken implementation: the
// standard TikTok Login Kit scopes (user.info.basic, user.info.stats,
// video.list) genuinely do NOT include audience demographics, reach, or
// impressions — those live behind TikTok's separate Business/Ads-adjacent
// API tiers with their own additional approval, not requested here.
// audienceDemographics and recentDailyMetrics are therefore always null,
// always named in unavailableMetrics, for every TikTok-sourced record —
// never estimated to look complete.

const TIKTOK_AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
// Confirmed against TikTok's own "User Access Token Management" doc: POST,
// form-encoded, client_key + client_secret + token. A success is an empty body.
const TIKTOK_REVOKE_URL = "https://open.tiktokapis.com/v2/oauth/revoke/";
const TIKTOK_API_BASE = "https://open.tiktokapis.com/v2";
// user.info.profile intentionally omitted — bio/verification aren't
// used by this integration's own sync() today; requesting only the
// scopes actually consumed keeps the app-review surface minimal.
const TIKTOK_SCOPES = "user.info.basic,user.info.stats,video.list";

type TikTokCredentials = {
  schemaVersion: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  openId: string;
};

function tiktokClientCredentials(): { clientKey: string; clientSecret: string } {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) {
    throw new Error("TikTok isn't configured yet — TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET are missing.");
  }
  return { clientKey, clientSecret };
}

async function refreshAccessToken(credentials: TikTokCredentials): Promise<string> {
  if (credentials.expiresAt > Date.now() + 60_000) {
    return credentials.accessToken;
  }
  const { clientKey, clientSecret } = tiktokClientCredentials();
  const res = await fetch(TIKTOK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`TikTok token refresh failed (${res.status})`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function tiktokApiGet<T>(path: string, accessToken: string, searchParams: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${TIKTOK_API_BASE}${path}`);
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value);
  // TikTok documents 429 + `rate_limit_exceeded` at 600 requests/minute.
  const res = await integrationFetch(
    url.toString(),
    { headers: { Authorization: `Bearer ${accessToken}` } },
    { label: "TikTok" }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TikTok API request to ${path} failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

export const tiktokConnector: IntegrationConnector = {
  provider: "TIKTOK",
  displayName: "TikTok",
  requiredPermission: PERMISSIONS.CONNECTIONS_MANAGE,
  capabilities: {
    authKind: "oauth",
    scopes: ["user.info.basic", "user.info.stats", "video.list"],
    reads: ["socialAccount"],
    writes: [],
    revokesOnDisconnect: true,
  },

  async connect(storeId, userId, params) {
    const { clientKey, clientSecret } = tiktokClientCredentials();

    if (params?.code) {
      const baseUrl = await getBaseUrl();
      const res = await fetch(TIKTOK_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
        body: new URLSearchParams({
          client_key: clientKey,
          client_secret: clientSecret,
          code: params.code,
          grant_type: "authorization_code",
          redirect_uri: integrationCallbackUrl(baseUrl, "TIKTOK"),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`TikTok token exchange failed (${res.status}): ${body}`);
      }
      const token = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        open_id: string;
      };

      const credentials: TikTokCredentials = {
        schemaVersion: 1,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
        openId: token.open_id,
      };

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "TIKTOK" } },
        create: {
          storeId,
          provider: "TIKTOK",
          status: "CONNECTED",
          externalAccountId: token.open_id,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          externalAccountId: token.open_id,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });

      return { kind: "connected" };
    }

    const baseUrl = await getBaseUrl();
    const url = new URL(TIKTOK_AUTH_URL);
    url.searchParams.set("client_key", clientKey);
    url.searchParams.set("redirect_uri", integrationCallbackUrl(baseUrl, "TIKTOK"));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", TIKTOK_SCOPES);
    url.searchParams.set("state", await beginOAuthHandoff({ storeId, userId, provider: "TIKTOK", executionId: params?.executionId }));

    return { kind: "redirect", url: url.toString() } satisfies ConnectResult;
  },

  async verify(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "TIKTOK" } },
    });
    if (!integration?.credentials) {
      return { ok: false, error: "Not connected" };
    }
    try {
      const credentials = decryptCredentials<TikTokCredentials>(integration.credentials);
      const accessToken = await refreshAccessToken(credentials);
      await tiktokApiGet(`/user/info/`, accessToken, { fields: "open_id" });
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
      where: { storeId_provider: { storeId, provider: "TIKTOK" } },
    });
    if (!integration) return;
    // Revoke at TikTok before clearing locally — deleting our copy of a token
    // leaves the grant live, and the owner has just been told it ended.
    // Best-effort by design: the local disconnect proceeds regardless.
    if (integration.credentials) {
      try {
        const credentials = decryptCredentials<TikTokCredentials>(integration.credentials);
        const { clientKey, clientSecret } = tiktokClientCredentials();
        const res = await fetch(TIKTOK_REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_key: clientKey,
            client_secret: clientSecret,
            token: credentials.accessToken,
          }),
        });
        if (!res.ok) {
          console.error(`[tiktok/disconnect] revoke failed for store ${storeId}: ${res.status}`);
        }
      } catch (error) {
        // Never the token itself — only what went wrong.
        console.error(`[tiktok/disconnect] revoke errored for store ${storeId}:`, error instanceof Error ? error.message : error);
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
        where: { storeId_provider: { storeId, provider: "TIKTOK" } },
      })
    );
  },

  async sync(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "TIKTOK" } },
    });
    if (!integration?.credentials) return [];
    const credentials = decryptCredentials<TikTokCredentials>(integration.credentials);
    const accessToken = await refreshAccessToken(credentials);

    const userInfo = await tiktokApiGet<{
      data?: {
        user?: {
          display_name?: string;
          follower_count?: number;
          following_count?: number;
          likes_count?: number;
          video_count?: number;
        };
      };
    }>("/user/info/", accessToken, {
      fields: "open_id,display_name,follower_count,following_count,likes_count,video_count",
    });
    const user = userInfo.data?.user;

    // Real, honest capability boundary — see this file's own top comment.
    // Never populated for TikTok: the standard Login Kit scopes this
    // connector requests don't expose them.
    const unavailableMetrics: string[] = ["audienceDemographics", "recentDailyMetrics"];

    let topContent: SocialAccount["topContent"] = null;
    let engagementRate: number | null = null;
    try {
      const videos = await tiktokApiGet<{
        data?: {
          videos?: {
            id: string;
            title?: string;
            create_time?: number;
            view_count?: number;
            like_count?: number;
            comment_count?: number;
            share_count?: number;
          }[];
        };
      }>("/video/list/", accessToken, {
        fields: "id,title,create_time,view_count,like_count,comment_count,share_count",
        max_count: "10",
      });
      const items = videos.data?.videos ?? [];
      if (items.length > 0) {
        topContent = items
          .map((v) => ({
            externalId: v.id,
            caption: v.title ?? null,
            postedAt: v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
            permalink: null,
            metrics: {
              views: v.view_count ?? 0,
              likes: v.like_count ?? 0,
              comments: v.comment_count ?? 0,
              shares: v.share_count ?? 0,
            },
          }))
          .sort((a, b) => b.metrics.views - a.metrics.views);
        // A real, honestly-computed engagement rate from the actual
        // recent videos returned — never fabricated, and distinct from
        // TikTok's own unavailable account-level analytics.
        const totalViews = items.reduce((sum, v) => sum + (v.view_count ?? 0), 0);
        const totalEngagements = items.reduce(
          (sum, v) => sum + (v.like_count ?? 0) + (v.comment_count ?? 0) + (v.share_count ?? 0),
          0
        );
        engagementRate = totalViews > 0 ? totalEngagements / totalViews : null;
      } else {
        unavailableMetrics.push("topContent");
      }
    } catch {
      unavailableMetrics.push("topContent");
    }

    const record: SocialAccount = {
      platform: "tiktok",
      accountName: user?.display_name ?? null,
      accountUsername: null,
      profileUrl: null,
      followerCount: user?.follower_count ?? null,
      followingCount: user?.following_count ?? null,
      mediaCount: user?.video_count ?? null,
      engagementRate,
      audienceDemographics: null,
      recentDailyMetrics: null,
      topContent,
      unavailableMetrics: Array.from(new Set(unavailableMetrics)),
      syncedFromApiAt: new Date().toISOString(),
    };

    return [{ entityType: "socialAccount", externalId: credentials.openId, data: record } satisfies SyncedRecord];
  },

  async interpretSync(storeId) {
    await generateSocialInsight(storeId);
  },
};
