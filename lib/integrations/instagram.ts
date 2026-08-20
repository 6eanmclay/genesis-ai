import { prisma } from "@/lib/prisma";
import { beginOAuthHandoff } from "./oauthState";
import { PERMISSIONS } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { ConnectResult, IntegrationConnector, SyncedRecord } from "./types";
import { toStatusView } from "./types";
import { getBaseUrl, integrationCallbackUrl } from "./util";
import { encryptCredentials, decryptCredentials } from "./credentials";
import {
  META_OAUTH_DIALOG_URL,
  META_SCOPES,
  metaClientCredentials,
  exchangeCodeForUserToken,
  exchangeForLongLivedUserToken,
  fetchManagedPages,
  fetchMetaUserId,
  metaGraphGet,
  revokeMetaGrant,
} from "./metaShared";
import type { SocialAccount } from "@/lib/businessModel/entities";
import { generateSocialInsight } from "@/lib/execution/socialInsight";

// Social Connections & Business Intelligence (2026-08-09) — Instagram
// Business/Creator accounts are reached via the Facebook Login flow (a
// linked Facebook Page's own access token, not a separate Instagram-only
// token) — real, current Meta architecture, confirmed against their docs.
// Independent StoreIntegration row/OAuth flow from facebook.ts (see the
// IntegrationProvider enum's own comment for why) even though both share
// metaShared.ts's low-level helpers.
//
// Real, honest v1 scope limit, same as facebook.ts: connects the first
// Page found with a linked Instagram Business Account. Real, honest
// capability limit: Meta's docs are explicit that some Insights metrics
// only appear once an account passes 100 followers — a smaller account
// will legitimately show more fields in unavailableMetrics, not a bug.
//
// A note for whoever does the first live connect (see SOCIAL_CONNECTIONS_
// SETUP.md): the exact Insights metric names below (audience_city/
// audience_country/audience_gender_age) are Meta's documented names as of
// this implementation, but their Insights API has a real history of
// migrating demographic metrics to newer names (follower_demographics/
// engaged_audience_demographics with breakdown params) across API
// versions — if a live sync 400s specifically on the demographics call,
// re-check https://developers.facebook.com/docs/instagram-platform/insights
// before assuming the integration itself is broken; the rest of sync()
// (basic account fields, day-period metrics) is on much more stable ground.

type InstagramCredentials = {
  schemaVersion: 1;
  igUserId: string;
  pageAccessToken: string;
  // Kept solely so disconnect() can revoke at Meta (2026-08-20). Optional
  // because connections made before that change genuinely do not have them.
  metaUserId?: string;
  userAccessToken?: string;
};

export const instagramConnector: IntegrationConnector = {
  provider: "INSTAGRAM",
  displayName: "Instagram Business",
  requiredPermission: PERMISSIONS.CONNECTIONS_MANAGE,
  capabilities: {
    authKind: "oauth",
    scopes: ["pages_show_list", "pages_read_engagement", "instagram_basic", "instagram_manage_insights"],
    reads: ["socialAccount"],
    writes: [],
    revokesOnDisconnect: true,
  },

  async connect(storeId, userId, params) {
    const { clientId, clientSecret } = metaClientCredentials();

    if (params?.code) {
      const baseUrl = await getBaseUrl();
      const redirectUri = integrationCallbackUrl(baseUrl, "INSTAGRAM");

      const shortLived = await exchangeCodeForUserToken({
        code: params.code,
        redirectUri,
        clientId,
        clientSecret,
      });
      const longLived = await exchangeForLongLivedUserToken({
        shortLivedToken: shortLived.accessToken,
        clientId,
        clientSecret,
      });

      const pages = await fetchManagedPages(longLived.accessToken);
      const pageWithInstagram = pages.find((p) => p.instagram_business_account?.id);
      if (!pageWithInstagram?.instagram_business_account) {
        throw new Error(
          "No Instagram Business or Creator account is linked to any of your Facebook Pages — link one in your Instagram app's own Settings first (Account type: Professional, connected to a Facebook Page)."
        );
      }

      const igUserId = pageWithInstagram.instagram_business_account.id;
      const credentials: InstagramCredentials = {
        schemaVersion: 1,
        igUserId,
        pageAccessToken: pageWithInstagram.access_token,
        metaUserId: await fetchMetaUserId(longLived.accessToken),
        userAccessToken: longLived.accessToken,
      };

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "INSTAGRAM" } },
        create: {
          storeId,
          provider: "INSTAGRAM",
          status: "CONNECTED",
          externalAccountId: igUserId,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          externalAccountId: igUserId,
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
    const url = new URL(META_OAUTH_DIALOG_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", integrationCallbackUrl(baseUrl, "INSTAGRAM"));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", META_SCOPES);
    url.searchParams.set("state", await beginOAuthHandoff({ storeId, userId, provider: "INSTAGRAM", executionId: params?.executionId }));

    return { kind: "redirect", url: url.toString() } satisfies ConnectResult;
  },

  async verify(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "INSTAGRAM" } },
    });
    if (!integration?.credentials) {
      return { ok: false, error: "Not connected" };
    }

    try {
      const credentials = decryptCredentials<InstagramCredentials>(integration.credentials);
      await metaGraphGet(`/${credentials.igUserId}`, credentials.pageAccessToken, { fields: "id,username" });
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
      where: { storeId_provider: { storeId, provider: "INSTAGRAM" } },
    });
    if (!integration) return;
    // Revoke at Meta before clearing locally — best-effort, so a Meta outage
    // cannot trap the owner in a connection they asked to end.
    if (integration.credentials) {
      const credentials = decryptCredentials<InstagramCredentials>(integration.credentials);
      const result = await revokeMetaGrant({
        metaUserId: credentials.metaUserId,
        userAccessToken: credentials.userAccessToken,
      });
      if (!result.revoked) {
        console.error(`[instagram/disconnect] grant not revoked at Meta for store ${storeId}: ${result.reason}`);
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
        where: { storeId_provider: { storeId, provider: "INSTAGRAM" } },
      })
    );
  },

  async sync(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "INSTAGRAM" } },
    });
    if (!integration?.credentials) return [];
    const credentials = decryptCredentials<InstagramCredentials>(integration.credentials);

    const account = await metaGraphGet<{
      id: string;
      username?: string;
      name?: string;
      followers_count?: number;
      follows_count?: number;
      media_count?: number;
    }>(`/${credentials.igUserId}`, credentials.pageAccessToken, {
      fields: "id,username,name,followers_count,follows_count,media_count",
    });

    const unavailableMetrics: string[] = [];

    // Account-level day-period metrics — real, current, stable field names.
    let recentDailyMetrics: SocialAccount["recentDailyMetrics"] = null;
    try {
      const insights = await metaGraphGet<{
        data?: { name: string; values: { end_time: string; value: number }[] }[];
      }>(`/${credentials.igUserId}/insights`, credentials.pageAccessToken, {
        metric: "impressions,reach,profile_views",
        period: "day",
      });
      const byMetric = new Map((insights.data ?? []).map((m) => [m.name, m.values]));
      const reachSeries = byMetric.get("reach") ?? [];
      if (reachSeries.length > 0) {
        recentDailyMetrics = reachSeries.map((point, i) => ({
          date: point.end_time.slice(0, 10),
          followerCount: null,
          reach: point.value,
          impressions: byMetric.get("impressions")?.[i]?.value ?? null,
          profileViews: byMetric.get("profile_views")?.[i]?.value ?? null,
        }));
      } else {
        unavailableMetrics.push("recentDailyMetrics");
      }
    } catch {
      // A real, honest degrade — see this file's own top comment on why
      // this specific call is the most likely one to need a metric-name
      // update after a live API version check.
      unavailableMetrics.push("recentDailyMetrics");
    }

    // Audience demographics — see this file's own top comment: these exact
    // metric names are the ones most likely to need reconfirming against
    // Meta's current docs at first live connect.
    let audienceDemographics: SocialAccount["audienceDemographics"] = null;
    try {
      const demo = await metaGraphGet<{
        data?: { name: string; total_value?: { breakdowns?: { results: { dimension_values: string[]; value: number }[] }[] } }[];
      }>(`/${credentials.igUserId}/insights`, credentials.pageAccessToken, {
        metric: "audience_gender_age,audience_city,audience_country",
        period: "lifetime",
      });
      const byMetric = new Map((demo.data ?? []).map((m) => [m.name, m.total_value?.breakdowns?.[0]?.results ?? []]));
      const toShareMap = (results: { dimension_values: string[]; value: number }[]) => {
        const total = results.reduce((sum, r) => sum + r.value, 0);
        if (total === 0) return null;
        const map: Record<string, number> = {};
        for (const r of results) map[r.dimension_values.join("/")] = r.value / total;
        return map;
      };
      audienceDemographics = {
        ageRanges: toShareMap(byMetric.get("audience_gender_age") ?? []),
        genderSplit: null, // audience_gender_age combines both dimensions — split out only if the raw breakdown supports it cleanly
        topCountries: toShareMap(byMetric.get("audience_country") ?? []),
        topCities: toShareMap(byMetric.get("audience_city") ?? []),
      };
      if (!audienceDemographics.ageRanges && !audienceDemographics.topCountries && !audienceDemographics.topCities) {
        audienceDemographics = null;
        unavailableMetrics.push("audienceDemographics");
      }
    } catch {
      // Common, honest case per Meta's own documented minimum: "some
      // metrics are not available on accounts with fewer than 100
      // followers." Never treated as a hard sync failure.
      unavailableMetrics.push("audienceDemographics");
    }

    // Top-performing content — most recent 10 media, each with its own
    // real per-media insights. Bounded, matching this framework's own
    // "prove the architecture, don't over-build any one integration"
    // precedent (mailchimp.ts's own 10-campaign cap).
    let topContent: SocialAccount["topContent"] = null;
    try {
      const media = await metaGraphGet<{
        data?: { id: string; caption?: string; timestamp?: string; permalink?: string }[];
      }>(`/${credentials.igUserId}/media`, credentials.pageAccessToken, {
        fields: "id,caption,timestamp,permalink",
        limit: "10",
      });
      const items = media.data ?? [];
      const withMetrics = await Promise.all(
        items.map(async (item) => {
          try {
            const mediaInsights = await metaGraphGet<{ data?: { name: string; values: { value: number }[] }[] }>(
              `/${item.id}/insights`,
              credentials.pageAccessToken,
              { metric: "reach,impressions,engagement" }
            );
            const metrics: Record<string, number> = {};
            for (const m of mediaInsights.data ?? []) {
              const value = m.values?.[0]?.value;
              if (typeof value === "number") metrics[m.name] = value;
            }
            return {
              externalId: item.id,
              caption: item.caption ?? null,
              postedAt: item.timestamp ?? null,
              permalink: item.permalink ?? null,
              metrics,
            };
          } catch {
            return null;
          }
        })
      );
      const successful = withMetrics.filter((m): m is NonNullable<typeof m> => m !== null);
      topContent = successful.length > 0 ? successful.sort((a, b) => (b.metrics.engagement ?? 0) - (a.metrics.engagement ?? 0)) : null;
      if (!topContent) unavailableMetrics.push("topContent");
    } catch {
      unavailableMetrics.push("topContent");
    }

    const record: SocialAccount = {
      platform: "instagram",
      accountName: account.name ?? null,
      accountUsername: account.username ?? null,
      profileUrl: account.username ? `https://instagram.com/${account.username}` : null,
      followerCount: account.followers_count ?? null,
      followingCount: account.follows_count ?? null,
      mediaCount: account.media_count ?? null,
      engagementRate: null, // computed honestly only once real reach/engagement history is in hand — see recentDailyMetrics
      audienceDemographics,
      recentDailyMetrics,
      topContent,
      unavailableMetrics: Array.from(new Set(unavailableMetrics)),
      syncedFromApiAt: new Date().toISOString(),
    };

    return [{ entityType: "socialAccount", externalId: account.id, data: record } satisfies SyncedRecord];
  },

  async interpretSync(storeId) {
    await generateSocialInsight(storeId);
  },
};
