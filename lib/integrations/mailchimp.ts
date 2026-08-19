import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { ConnectResult, IntegrationConnector, SyncedRecord } from "./types";
import { toStatusView } from "./types";
import { encryptCredentials, decryptCredentials } from "./credentials";
import type { Campaign } from "@/lib/businessModel/entities";

// Phase 3 Milestone 2 — proof integration #3: API-key auth, no OAuth at
// all — the third distinct auth pattern (alongside Stripe's OAuth-redirect
// and PayPal's multi-field form/API-key). Mailchimp API keys embed their
// own datacenter suffix (e.g. "...-us6"), so the base URL is derived from
// the key itself rather than being fixed — a genuinely different detail
// than PayPal's fixed sandbox/live base URLs, still fitting the exact same
// {kind:"form"} ConnectResult shape with just one field instead of three.

type MailchimpCredentials = {
  schemaVersion: 1;
  apiKey: string;
};

function datacenterOf(apiKey: string): string {
  const parts = apiKey.split("-");
  const dc = parts[parts.length - 1];
  if (parts.length < 2 || !dc) {
    throw new Error("Mailchimp API key doesn't look valid — expected a \"-<datacenter>\" suffix.");
  }
  return dc;
}

function apiBase(apiKey: string): string {
  return `https://${datacenterOf(apiKey)}.api.mailchimp.com/3.0`;
}

async function pingMailchimp(apiKey: string): Promise<void> {
  const res = await fetch(`${apiBase(apiKey)}/`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`anystring:${apiKey}`).toString("base64")}`,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Mailchimp key check failed (${res.status})`);
  }
}

export const mailchimpConnector: IntegrationConnector = {
  provider: "MAILCHIMP",
  displayName: "Mailchimp",
  requiredPermission: PERMISSIONS.CONNECTIONS_MANAGE,
  capabilities: {
    // FLAGGED BY PHASE 0: Mailchimp does support OAuth2, so this API-key form
    // is an exception that has not earned itself. Recorded here honestly
    // rather than silently blessed — a candidate to convert.
    authKind: "api_key",
    apiKeyExceptionReason:
      "Currently collects an API key, though Mailchimp supports OAuth2 — flagged for conversion rather than justified.",
    scopes: [],
    reads: ["campaign"],
    writes: [],
  },

  async connect(storeId, userId, params) {
    // Second call: the merchant submitted their API key.
    if (params?.apiKey) {
      const apiKey = params.apiKey.trim();

      // Validates the key by using it — a failed ping throws, which the
      // engine turns into a FAILED result, same convention as PayPal's
      // getPaypalAccessToken() validation-by-use.
      await pingMailchimp(apiKey);

      const credentials: MailchimpCredentials = { schemaVersion: 1, apiKey };

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "MAILCHIMP" } },
        create: {
          storeId,
          provider: "MAILCHIMP",
          status: "CONNECTED",
          externalAccountId: datacenterOf(apiKey),
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          externalAccountId: datacenterOf(apiKey),
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });

      return { kind: "connected" };
    }

    // First call: no OAuth app — collect the merchant's own API key.
    return {
      kind: "form",
      fields: [{ name: "apiKey", label: "API Key", type: "password" }],
    } satisfies ConnectResult;
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
      await pingMailchimp(credentials.apiKey);
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
    // No revoke call for a plain API key — regenerating it in the
    // Mailchimp dashboard is how a merchant would fully cut access, same
    // limitation PayPal's own disconnect() already documents.
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
    const base = apiBase(credentials.apiKey);
    const authHeader = {
      Authorization: `Basic ${Buffer.from(`anystring:${credentials.apiKey}`).toString("base64")}`,
    };

    const res = await fetch(
      `${base}/campaigns?count=10&sort_field=send_time&sort_dir=DESC`,
      { headers: authHeader }
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
          const reportRes = await fetch(`${base}/reports/${campaign.id}`, { headers: authHeader });
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
