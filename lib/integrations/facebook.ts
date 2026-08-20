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

// Social Connections & Business Intelligence (2026-08-09) — "Instagram/
// Facebook should be the first implementation because Meta currently
// exposes meaningful professional-account/Page insights" (Sean). Real
// permissions, OAuth flow, and endpoints confirmed against Meta's current
// developer docs (see metaShared.ts's own top comment for the exact
// version/scope basis). Requires FACEBOOK_CLIENT_ID/FACEBOOK_CLIENT_SECRET
// (one Meta app covers both Facebook and Instagram) — see
// SOCIAL_CONNECTIONS_SETUP.md for exactly what to create in Meta's own
// developer console.
//
// Real, honest v1 scope limit: connects the first Facebook Page the
// merchant manages (the common case — most small businesses have exactly
// one). A merchant with multiple Pages gets the first one found; real
// multi-Page selection is a genuine future improvement, not built here —
// named explicitly rather than silently picking one with no explanation.

type FacebookCredentials = {
  schemaVersion: 1;
  pageId: string;
  pageAccessToken: string;
  // Kept solely so disconnect() can revoke at Meta (2026-08-20). Optional
  // because connections made before that change genuinely do not have them,
  // and inventing a value would be worse than admitting the limit.
  metaUserId?: string;
  userAccessToken?: string;
};

export const facebookConnector: IntegrationConnector = {
  provider: "FACEBOOK",
  displayName: "Facebook Page",
  requiredPermission: PERMISSIONS.CONNECTIONS_MANAGE,
  capabilities: {
    authKind: "oauth",
    // The Page token used for every API call is effectively non-expiring, but
    // the long-lived USER token kept alongside it for revocation lasts ~60 days.
    // So the connection keeps working past 60 days while disconnect() quietly
    // loses the ability to revoke at Meta — declared "expires" for that reason,
    // and the failure is logged rather than silent.
    tokenLifetime: "expires",
    scopes: ["pages_show_list", "pages_read_engagement", "instagram_basic", "instagram_manage_insights"],
    reads: ["socialAccount"],
    writes: [],
    revokesOnDisconnect: true,
  },

  async connect(storeId, userId, params) {
    const { clientId, clientSecret } = metaClientCredentials();

    // Second call: Meta's callback handed us an OAuth code.
    if (params?.code) {
      const baseUrl = await getBaseUrl();
      const redirectUri = integrationCallbackUrl(baseUrl, "FACEBOOK");

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
      const page = pages[0];
      if (!page) {
        throw new Error(
          "No Facebook Page found for this account — you need to be an admin of at least one Facebook Page to connect it."
        );
      }

      const credentials: FacebookCredentials = {
        schemaVersion: 1,
        pageId: page.id,
        pageAccessToken: page.access_token,
        metaUserId: await fetchMetaUserId(longLived.accessToken),
        userAccessToken: longLived.accessToken,
      };

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "FACEBOOK" } },
        create: {
          storeId,
          provider: "FACEBOOK",
          status: "CONNECTED",
          externalAccountId: page.id,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          externalAccountId: page.id,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });

      return { kind: "connected" };
    }

    // First call: send the merchant to Meta's own hosted consent screen.
    const baseUrl = await getBaseUrl();
    const url = new URL(META_OAUTH_DIALOG_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", integrationCallbackUrl(baseUrl, "FACEBOOK"));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", META_SCOPES);
    url.searchParams.set("state", await beginOAuthHandoff({ storeId, userId, provider: "FACEBOOK", executionId: params?.executionId }));

    return { kind: "redirect", url: url.toString() } satisfies ConnectResult;
  },

  async verify(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "FACEBOOK" } },
    });
    if (!integration?.credentials) {
      return { ok: false, error: "Not connected" };
    }

    try {
      const credentials = decryptCredentials<FacebookCredentials>(integration.credentials);
      await metaGraphGet(`/${credentials.pageId}`, credentials.pageAccessToken, { fields: "id,name" });
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
      where: { storeId_provider: { storeId, provider: "FACEBOOK" } },
    });
    if (!integration) return;
    // Revoke at Meta before clearing locally, so "Disconnect" is true at the
    // provider and not just in our own row. Best-effort: a Meta outage must not
    // trap the owner in a connection they asked to end.
    if (integration.credentials) {
      const credentials = decryptCredentials<FacebookCredentials>(integration.credentials);
      const result = await revokeMetaGrant({
        metaUserId: credentials.metaUserId,
        userAccessToken: credentials.userAccessToken,
      });
      if (!result.revoked) {
        console.error(`[facebook/disconnect] grant not revoked at Meta for store ${storeId}: ${result.reason}`);
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
        where: { storeId_provider: { storeId, provider: "FACEBOOK" } },
      })
    );
  },

  // Real Page-level metrics only — "store that metric as unavailable
  // rather than fabricating" (Sean): Facebook Pages don't expose audience
  // age/gender/location breakdowns the way Instagram Business accounts do
  // (that data lives on the Instagram side even for a Page-linked
  // account), so audienceDemographics is honestly null here, named in
  // unavailableMetrics, not guessed at.
  async sync(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "FACEBOOK" } },
    });
    if (!integration?.credentials) return [];
    const credentials = decryptCredentials<FacebookCredentials>(integration.credentials);

    const page = await metaGraphGet<{ id: string; name: string; fan_count?: number; link?: string }>(
      `/${credentials.pageId}`,
      credentials.pageAccessToken,
      { fields: "id,name,fan_count,link" }
    );

    // Page Insights — real, long-standing Facebook metric names
    // (page_impressions/page_engaged_users/page_post_engagements). Wrapped
    // in try/catch: a Page with too little activity, or one whose Insights
    // access hasn't fully propagated yet, can legitimately 400 here — that
    // must degrade to "unavailable," never abort the whole sync.
    let recentDailyMetrics: SocialAccount["recentDailyMetrics"] = null;
    let engagementRate: number | null = null;
    const unavailableMetrics: string[] = ["audienceDemographics", "topContent"];
    try {
      const insights = await metaGraphGet<{
        data?: { name: string; values: { end_time: string; value: number }[] }[];
      }>(`/${credentials.pageId}/insights`, credentials.pageAccessToken, {
        metric: "page_impressions,page_engaged_users",
        period: "day",
      });
      const byMetric = new Map((insights.data ?? []).map((m) => [m.name, m.values]));
      const impressionsSeries = byMetric.get("page_impressions") ?? [];
      const engagedSeries = byMetric.get("page_engaged_users") ?? [];
      if (impressionsSeries.length > 0) {
        recentDailyMetrics = impressionsSeries.map((point) => ({
          date: point.end_time.slice(0, 10),
          followerCount: null,
          reach: null,
          impressions: point.value,
          profileViews: null,
        }));
        const totalImpressions = impressionsSeries.reduce((sum, p) => sum + p.value, 0);
        const totalEngaged = engagedSeries.reduce((sum, p) => sum + p.value, 0);
        engagementRate = totalImpressions > 0 ? totalEngaged / totalImpressions : null;
      } else {
        unavailableMetrics.push("recentDailyMetrics", "engagementRate");
      }
    } catch {
      unavailableMetrics.push("recentDailyMetrics", "engagementRate");
    }

    const record: SocialAccount = {
      platform: "facebook",
      accountName: page.name,
      accountUsername: null,
      profileUrl: page.link ?? null,
      followerCount: page.fan_count ?? null,
      followingCount: null,
      mediaCount: null,
      engagementRate,
      audienceDemographics: null,
      recentDailyMetrics,
      topContent: null,
      unavailableMetrics: Array.from(new Set(unavailableMetrics)),
      syncedFromApiAt: new Date().toISOString(),
    };

    return [{ entityType: "socialAccount", externalId: page.id, data: record } satisfies SyncedRecord];
  },

  async interpretSync(storeId) {
    await generateSocialInsight(storeId);
  },
};
