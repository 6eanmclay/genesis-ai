import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import { beginOAuthHandoff } from "./oauthState";
import { integrationFetch } from "./rateLimit";
import type { ConnectResult, IntegrationConnector, SyncedRecord } from "./types";
import { toStatusView } from "./types";
import { getBaseUrl, integrationCallbackUrl } from "./util";
import { encryptCredentials, decryptCredentials } from "./credentials";
import type { Campaign } from "@/lib/businessModel/entities";

// Originally built (Phase 3 M2) as the proof that the framework handled plain
// API-key auth. Phase 0 then flagged it as an exception that had not earned
// itself: Mailchimp does support OAuth2, and Sean's standing rule is not to ask
// a business owner to paste an API key when the provider offers a delegated
// flow. Pasting a Mailchimp key hands over the whole account permanently, in a
// form the owner cannot see, narrow, or withdraw from Genesis's side.
//
// So this is OAuth now, against Mailchimp's documented endpoints. Two details
// are genuinely Mailchimp-specific rather than assumed:
//
//   - Access tokens DO NOT EXPIRE and there is no refresh token. That is
//     Mailchimp's own documented behaviour, which is why there is no refresh()
//     here — absence is an answer, not an oversight.
//   - The API base is per-account. The token alone does not tell you which
//     datacenter to call, so the metadata endpoint is asked once at connect and
//     the answer stored.
//
// Connections made before this change still work. Their credentials are an API
// key, they keep being used as one, and nothing forces an owner to reconnect
// mid-campaign — see authFor() below.

const AUTHORIZE_URL = "https://login.mailchimp.com/oauth2/authorize";
const TOKEN_URL = "https://login.mailchimp.com/oauth2/token";
const METADATA_URL = "https://login.mailchimp.com/oauth2/metadata";

/** Issued by OAuth. The current shape. */
type MailchimpOAuthCredentials = {
  schemaVersion: 2;
  accessToken: string;
  /** Server prefix, e.g. "us6" — from the metadata endpoint, not guessed. */
  dc: string;
};

/** Pasted by the owner, before the OAuth conversion. Still honoured. */
type MailchimpApiKeyCredentials = {
  schemaVersion: 1;
  apiKey: string;
};

type MailchimpCredentials = MailchimpOAuthCredentials | MailchimpApiKeyCredentials;

function isApiKey(credentials: MailchimpCredentials): credentials is MailchimpApiKeyCredentials {
  return (credentials as MailchimpApiKeyCredentials).apiKey !== undefined;
}

function mailchimpClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.MAILCHIMP_CLIENT_ID;
  const clientSecret = process.env.MAILCHIMP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Mailchimp isn't configured yet — MAILCHIMP_CLIENT_ID/MAILCHIMP_CLIENT_SECRET are missing. Register the app at Mailchimp's own developer console first."
    );
  }
  return { clientId, clientSecret };
}

function datacenterOf(apiKey: string): string {
  const parts = apiKey.split("-");
  const dc = parts[parts.length - 1];
  if (parts.length < 2 || !dc) {
    throw new Error("Mailchimp API key doesn't look valid — expected a \"-<datacenter>\" suffix.");
  }
  return dc;
}

/**
 * How to call Mailchimp for THIS connection — pure, and the one place the two
 * credential shapes are told apart. An API-key connection made before the OAuth
 * conversion keeps working exactly as it did.
 */
export function authFor(credentials: MailchimpCredentials): { base: string; headers: Record<string, string> } {
  if (isApiKey(credentials)) {
    return {
      base: `https://${datacenterOf(credentials.apiKey)}.api.mailchimp.com/3.0`,
      headers: {
        Authorization: `Basic ${Buffer.from(`anystring:${credentials.apiKey}`).toString("base64")}`,
      },
    };
  }
  // Mailchimp's own documented header for an OAuth token — "OAuth", not
  // "Bearer".
  return {
    base: `https://${credentials.dc}.api.mailchimp.com/3.0`,
    headers: { Authorization: `OAuth ${credentials.accessToken}` },
  };
}

/** Validation by use — a failed ping throws, which the engine records as FAILED. */
async function pingMailchimp(credentials: MailchimpCredentials): Promise<void> {
  const { base, headers } = authFor(credentials);
  const res = await integrationFetch(`${base}/`, { headers }, { label: "Mailchimp" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Mailchimp connection check failed (${res.status})`);
  }
}

export const mailchimpConnector: IntegrationConnector = {
  provider: "MAILCHIMP",
  displayName: "Mailchimp",
  requiredPermission: PERMISSIONS.CONNECTIONS_MANAGE,
  capabilities: {
    authKind: "oauth",
    scopes: [],
    noScopesReason:
      "Mailchimp's OAuth2 flow takes no scope parameter — consent grants access to the account, and there is nothing narrower to ask for. Genesis only reads campaigns.",
    reads: ["campaign"],
    writes: [],
    // Mailchimp documents no revocation endpoint: a token "will remain valid
    // unless the user revokes your application's permission" — from their
    // account's Connected Sites/integrations settings, not from an API. There
    // is no honest call to make here, so disconnect clears our copy and says so.
    revokesOnDisconnect: false,
  },

  async connect(storeId, userId, params) {
    const { clientId, clientSecret } = mailchimpClientCredentials();
    const baseUrl = await getBaseUrl();
    const redirectUri = integrationCallbackUrl(baseUrl, "MAILCHIMP");

    // Second call: Mailchimp's callback round-tripped with a code.
    if (params?.code) {
      const tokenRes = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code: params.code,
        }),
      });
      if (!tokenRes.ok) {
        // The body can echo the code back; only the status is logged/raised.
        throw new Error(`Mailchimp token exchange failed (${tokenRes.status})`);
      }
      const token = (await tokenRes.json()) as { access_token: string };

      // Which datacenter this account lives in. The token does not say, and
      // guessing a prefix would produce 404s that look like a broken account.
      const metaRes = await fetch(METADATA_URL, {
        headers: { Authorization: `OAuth ${token.access_token}` },
      });
      if (!metaRes.ok) {
        throw new Error(`Mailchimp metadata lookup failed (${metaRes.status})`);
      }
      const metadata = (await metaRes.json()) as { dc?: string; login?: { login_email?: string } };
      if (!metadata.dc) {
        throw new Error("Mailchimp did not return a server prefix for this account.");
      }

      const credentials: MailchimpOAuthCredentials = {
        schemaVersion: 2,
        accessToken: token.access_token,
        dc: metadata.dc,
      };

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "MAILCHIMP" } },
        create: {
          storeId,
          provider: "MAILCHIMP",
          status: "CONNECTED",
          externalAccountId: metadata.dc,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          externalAccountId: metadata.dc,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });

      return { kind: "connected" };
    }

    // First call: Mailchimp's own hosted consent screen. No key ever reaches
    // Genesis, and the owner can withdraw the grant from their own account.
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", await beginOAuthHandoff({ storeId, userId, provider: "MAILCHIMP", executionId: params?.executionId }));

    return { kind: "redirect", url: url.toString() } satisfies ConnectResult;
  },

  async verify(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "MAILCHIMP" } },
    });
    if (!integration?.credentials) {
      return { ok: false, error: "Not connected" };
    }
    const credentials = decryptCredentials<MailchimpCredentials>(integration.credentials);

    try {
      await pingMailchimp(credentials);
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
      where: { storeId_provider: { storeId, provider: "MAILCHIMP" } },
    });
    if (!integration) return;
    // Mailchimp documents no revocation endpoint — a token stays valid until
    // the user withdraws the app's permission from their own Mailchimp account
    // settings. Nothing to call, so nothing is pretended.
    await prisma.storeIntegration.update({
      where: { id: integration.id, storeId },
      data: { status: "DISCONNECTED", credentials: Prisma.DbNull },
    });
  },

  async status(storeId) {
    // Phase 0 — never returns the credentials blob.
    return toStatusView(
      await prisma.storeIntegration.findUnique({
        where: { storeId_provider: { storeId, provider: "MAILCHIMP" } },
      })
    );
  },

  // Maps recent campaigns -> Campaign. Metrics (opens/clicks) need a
  // second, per-campaign report call — kept to the 10 most recent
  // campaigns to bound the number of extra requests, matching "prove the
  // architecture, don't over-build any one integration."
  async sync(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "MAILCHIMP" } },
    });
    if (!integration?.credentials) return [];

    const credentials = decryptCredentials<MailchimpCredentials>(integration.credentials);
    const { base, headers: authHeader } = authFor(credentials);

    const res = await integrationFetch(
      `${base}/campaigns?count=10&sort_field=send_time&sort_dir=DESC`,
      { headers: authHeader },
      { label: "Mailchimp" }
    );
    if (!res.ok) {
      throw new Error(`Mailchimp campaigns fetch failed (${res.status})`);
    }
    const data = (await res.json()) as {
      campaigns?: {
        id: string;
        settings?: { title?: string };
        send_time?: string;
        emails_sent?: number;
      }[];
    };

    const campaigns = data.campaigns ?? [];

    const records = await Promise.all(
      campaigns.map(async (campaign): Promise<SyncedRecord> => {
        let metrics: Record<string, number> | null = null;
        try {
          // The genuine exposure here: Mailchimp's documented limit is 10
          // SIMULTANEOUS connections, and this fans out one request per
          // campaign at once. Ten campaigns sits exactly on the line.
          const reportRes = await integrationFetch(
            `${base}/reports/${campaign.id}`,
            { headers: authHeader },
            { label: "Mailchimp" }
          );
          if (reportRes.ok) {
            const report = (await reportRes.json()) as {
              opens?: { opens_total?: number };
              clicks?: { clicks_total?: number };
            };
            metrics = {
              opens: report.opens?.opens_total ?? 0,
              clicks: report.clicks?.clicks_total ?? 0,
            };
          }
        } catch {
          // Report unavailable (e.g. campaign hasn't sent yet) — metrics
          // stay null, an honest "not available" rather than a fabricated
          // zero standing in for missing data.
        }

        const record: Campaign = {
          name: campaign.settings?.title ?? "(untitled campaign)",
          channel: "email",
          sentAt: campaign.send_time ?? null,
          audienceSize: campaign.emails_sent ?? null,
          metrics,
        };
        return { entityType: "campaign", externalId: campaign.id, data: record };
      })
    );

    return records;
  },
};
