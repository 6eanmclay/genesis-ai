import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { ConnectResult, IntegrationConnector } from "./types";
import { toStatusView } from "./types";
import { encryptCredentials, decryptCredentials } from "./credentials";
import { canonicalBaseUrl } from "./util";

export type PaypalEnvironment = "sandbox" | "live";

export type PaypalCredentials = {
  schemaVersion: 1;
  clientId: string;
  clientSecret: string;
  environment: PaypalEnvironment;
  // The refund subscription created in the merchant's own PayPal app at connect
  // time (2026-08-20). Optional rather than a schema bump: a row written before
  // this existed simply has no webhook, which is the truth about it — refunds do
  // not arrive for that store until it reconnects, and pretending otherwise
  // would be worse than the gap. Null when PayPal refused the URL (localhost).
  webhookId?: string | null;
};

export function paypalApiBase(environment: PaypalEnvironment): string {
  return environment === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

// Every PayPal REST call needs a bearer token, merchant-supplied
// credentials or not — this is how *any* caller authenticates, not a
// per-merchant OAuth authorization step. A successful exchange is also the
// cheapest honest proof the credentials are genuinely valid — PayPal has
// no "whoami" endpoint the way Stripe's accounts.retrieve() works.
export async function getPaypalAccessToken(
  clientId: string,
  clientSecret: string,
  environment: PaypalEnvironment
): Promise<string> {
  const res = await fetch(`${paypalApiBase(environment)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error_description ?? `PayPal token exchange failed (${res.status})`);
  }

  const data = await res.json();
  return data.access_token as string;
}

function parseEnvironment(value: string | undefined): PaypalEnvironment {
  const normalized = value?.trim().toLowerCase();
  return normalized === "live" ? "live" : "sandbox";
}

// The second connector on the Integration Framework (PH-02), and the first
// to use simple per-merchant API credentials instead of OAuth — each
// merchant creates their own PayPal Developer app and enters its Client
// ID/Secret via the {kind:"form"} branch of ConnectResult, designed in
// PH-02 for exactly this case but never exercised until now.
export const paypalConnector: IntegrationConnector = {
  provider: "PAYPAL",
  displayName: "PayPal",
  requiredPermission: PERMISSIONS.PAYMENTS_MANAGE,
  capabilities: {
    // Merchant-supplied client id/secret exchanged for a client_credentials
    // token. Not an OAuth handoff, and documented as such rather than dressed
    // up as one.
    authKind: "api_key",
    // The stored credential is the merchant's own client id/secret, which does
    // not expire. The short-lived bearer token is fetched per call, never kept.
    tokenLifetime: "permanent",
    apiKeyExceptionReason:
      "PayPal's delegated (multiparty) flow is not self-serve — a platform must apply and be approved by PayPal before it can act on a seller's behalf in live mode. Until that approval exists, the merchant's own app credentials are the only honest option, not a shortcut.",
    scopes: [],
    reads: [],
    // Declared, not implied. The webhook subscription is a real write into the
    // merchant's own PayPal app — Genesis creates it at connect and deletes it at
    // disconnect — and a capability list that omitted it would be understating
    // what connecting actually does.
    writes: ["captures checkout payments", "manages a refund webhook subscription"],
    // client-credentials token, nothing to revoke per-merchant
    revokesOnDisconnect: false,
  },

  async connect(storeId, userId, params) {
    // Second call: the merchant submitted their credentials.
    if (params?.clientId && params?.clientSecret) {
      const clientId = params.clientId.trim();
      const clientSecret = params.clientSecret.trim();
      const environment = parseEnvironment(params.environment);

      // Validates the credentials by using them — a failed exchange
      // throws, which the engine turns into a FAILED result.
      const accessToken = await getPaypalAccessToken(clientId, clientSecret, environment);

      // Subscribe to refunds while we have a token in hand. Deliberately NOT
      // fatal: a merchant on a development host, or one whose app will not take
      // the URL, still gets a working payment rail — they just get told, on the
      // integration itself, that refunds will not reach Genesis. Failing the
      // whole connection over it would trade a reporting gap for no rail at all.
      const baseUrl = await canonicalBaseUrl();
      const webhook = await ensurePaypalWebhook(
        accessToken,
        environment,
        paypalWebhookUrl(baseUrl, storeId)
      ).catch((error: unknown) => ({
        webhookId: null,
        error: error instanceof Error ? error.message : "Could not reach PayPal to set up refund notifications",
      }));

      const credentials: PaypalCredentials = {
        schemaVersion: 1,
        clientId,
        clientSecret,
        environment,
        webhookId: webhook.webhookId,
      };
      const webhookNote = webhook.webhookId
        ? null
        : `Connected, but refunds will not reach Genesis: ${webhook.error ?? "no refund webhook was created"}. A refunded order will keep counting as revenue until this is fixed.`;
      const encryptedCredentials = encryptCredentials(credentials);

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "PAYPAL" } },
        create: {
          storeId,
          provider: "PAYPAL",
          status: "CONNECTED",
          externalAccountId: clientId,
          credentials: encryptedCredentials,
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
          lastError: webhookNote,
        },
        update: {
          status: "CONNECTED",
          externalAccountId: clientId,
          credentials: encryptedCredentials,
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
          lastError: webhookNote,
        },
      });

      return { kind: "connected" };
    }

    // First call: no platform-wide app to redirect to — collect the
    // merchant's own credentials directly.
    return {
      kind: "form",
      fields: [
        { name: "clientId", label: "Client ID", type: "text" },
        { name: "clientSecret", label: "Secret", type: "password" },
        { name: "environment", label: "Environment (sandbox or live)", type: "text" },
      ],
    } satisfies ConnectResult;
  },

  async verify(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "PAYPAL" } },
    });
    if (!integration?.credentials) {
      return { ok: false, error: "Not connected" };
    }
    const credentials = decryptCredentials<PaypalCredentials>(integration.credentials);
    if (!credentials?.clientId || !credentials?.clientSecret) {
      return { ok: false, error: "Not connected" };
    }

    try {
      const accessToken = await getPaypalAccessToken(
        credentials.clientId,
        credentials.clientSecret,
        credentials.environment
      );

      // VERIFY MEANS VERIFY (2026-08-20). A working token says money can be
      // taken; it says nothing about whether a refund would ever reach Genesis.
      //
      // This is also the repair path. Every store connected before refund
      // webhooks existed has no subscription, and nothing else would ever give
      // it one — its refunds would 404 forever while the integration showed a
      // contented green Connected. So verify re-checks the subscription, creates
      // one if it is missing or has been deleted at PayPal, and persists it.
      const webhook = await ensurePaypalWebhookForVerify(accessToken, credentials, storeId);
      if (webhook.credentials) {
        await prisma.storeIntegration.update({
          where: { id: integration!.id, storeId },
          data: { credentials: encryptCredentials(webhook.credentials) },
        });
      }

      await prisma.storeIntegration.update({
        where: { id: integration!.id, storeId },
        data: { status: "CONNECTED", lastVerifiedAt: new Date(), lastError: webhook.note },
      });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Verification failed";
      await prisma.storeIntegration.update({
        where: { id: integration!.id, storeId },
        data: { status: "FAILED", lastVerifiedAt: new Date(), lastError: message },
      });
      return { ok: false, error: message };
    }
  },

  async disconnect(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "PAYPAL" } },
    });
    if (!integration) return;

    // No revoke call exists for client-credentials — nothing to deauthorize
    // on PayPal's side from our end. Regenerating the Secret in the PayPal
    // dashboard is how a merchant would fully cut access.
    //
    // The refund subscription IS ours to clean up, though: Genesis created it in
    // the merchant's app, so it should not be left behind pointing at a store
    // that no longer accepts PayPal. Best effort — a webhook we fail to delete
    // is noise, and its events are ignored anyway once the credentials are gone,
    // so it must never stop somebody disconnecting.
    const existing = integration.credentials
      ? decryptCredentials<PaypalCredentials>(integration.credentials)
      : null;
    if (existing?.webhookId && existing.clientId && existing.clientSecret) {
      try {
        const accessToken = await getPaypalAccessToken(
          existing.clientId,
          existing.clientSecret,
          existing.environment
        );
        await deletePaypalWebhook(accessToken, existing.environment, existing.webhookId);
      } catch {
        // Intentionally swallowed. See above.
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
        where: { storeId_provider: { storeId, provider: "PAYPAL" } },
      })
    );
  },
};

// --- Refunds ---------------------------------------------------------------
//
// The Stripe rail learns about a refund from charge.refunded. This rail had no
// counterpart at all, so a refunded PayPal sale kept counting as revenue and its
// goods could still be posted at the owner's expense (COMPLIANCE.md §41).
//
// PayPal webhooks are per-app, and each merchant here supplies their own app —
// so the subscription is created with the merchant's own credentials at connect
// time rather than asked for as one more thing to paste. The URL carries the
// store id, and the signature is what makes it trustworthy: the same shape as
// the Stripe rail, where `event.account` is the claim and the signature is the
// proof.

export const PAYPAL_WEBHOOK_EVENTS = ["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"] as const;

export function paypalWebhookUrl(baseUrl: string, storeId: string): string {
  return `${baseUrl}/api/webhooks/paypal/${storeId}`;
}

/**
 * Subscribe this merchant's PayPal app to refund events — idempotent.
 *
 * PayPal refuses a second subscription on a URL it already has
 * (WEBHOOK_URL_ALREADY_EXISTS), which is the normal case on reconnect, so that
 * answer is treated as "already done" and the existing id is looked up rather
 * than a failure. Returns null when PayPal will not take the URL at all — a
 * localhost or http:// base, which is every development machine — so the caller
 * can connect anyway and say plainly that refunds will not arrive.
 */
export async function ensurePaypalWebhook(
  accessToken: string,
  environment: PaypalEnvironment,
  url: string
): Promise<{ webhookId: string | null; error: string | null }> {
  const base = paypalApiBase(environment);
  const auth = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };

  const created = await fetch(`${base}/v1/notifications/webhooks`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      url,
      event_types: PAYPAL_WEBHOOK_EVENTS.map((name) => ({ name })),
    }),
  });

  if (created.ok) {
    const body = await created.json().catch(() => ({}));
    return { webhookId: (body.id as string) ?? null, error: null };
  }

  const errorBody = await created.json().catch(() => ({}));
  const duplicate =
    errorBody?.name === "WEBHOOK_URL_ALREADY_EXISTS" ||
    (errorBody?.details as { issue?: string }[] | undefined)?.some((d) => d.issue === "WEBHOOK_URL_ALREADY_EXISTS");

  if (duplicate) {
    const listed = await fetch(`${base}/v1/notifications/webhooks`, { headers: auth });
    if (listed.ok) {
      const body = await listed.json().catch(() => ({}));
      const match = (body.webhooks as { id?: string; url?: string }[] | undefined)?.find((w) => w.url === url);
      if (match?.id) return { webhookId: match.id, error: null };
    }
    return { webhookId: null, error: "PayPal already has a webhook on this URL but would not say which" };
  }

  // Deliberately not echoing PayPal's body — see lib/integrations/providerError.ts.
  return { webhookId: null, error: `PayPal would not accept a refund webhook on this URL (${created.status})` };
}

/** Best effort: a webhook left behind is noise, not a security hole. */
export async function deletePaypalWebhook(
  accessToken: string,
  environment: PaypalEnvironment,
  webhookId: string
): Promise<void> {
  await fetch(`${paypalApiBase(environment)}/v1/notifications/webhooks/${webhookId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch(() => undefined);
}

/**
 * Is this delivery genuinely from PayPal? — the only thing that makes the store
 * id in the URL mean anything.
 *
 * `rawBody` is spliced in as text rather than re-serialised. PayPal signs the
 * exact bytes it sent, and JSON.stringify of a parsed object is not guaranteed
 * to reproduce them — key order and number formatting both survive a round trip
 * by convention, not by rule.
 */
export async function verifyPaypalWebhook(input: {
  accessToken: string;
  environment: PaypalEnvironment;
  webhookId: string;
  rawBody: string;
  headers: {
    authAlgo: string | null;
    certUrl: string | null;
    transmissionId: string | null;
    transmissionSig: string | null;
    transmissionTime: string | null;
  };
}): Promise<boolean> {
  const { headers } = input;
  if (
    !headers.authAlgo ||
    !headers.certUrl ||
    !headers.transmissionId ||
    !headers.transmissionSig ||
    !headers.transmissionTime
  ) {
    return false;
  }

  const body =
    `{"auth_algo":${JSON.stringify(headers.authAlgo)},` +
    `"cert_url":${JSON.stringify(headers.certUrl)},` +
    `"transmission_id":${JSON.stringify(headers.transmissionId)},` +
    `"transmission_sig":${JSON.stringify(headers.transmissionSig)},` +
    `"transmission_time":${JSON.stringify(headers.transmissionTime)},` +
    `"webhook_id":${JSON.stringify(input.webhookId)},` +
    `"webhook_event":${input.rawBody}}`;

  const res = await fetch(`${paypalApiBase(input.environment)}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) return false;
  const result = await res.json().catch(() => ({}));
  return result?.verification_status === "SUCCESS";
}

/**
 * Make sure this store still has a refund subscription — used by verify().
 *
 * Split out rather than inlined because it has three genuinely different
 * outcomes and each one has to be honest: the subscription is there, it was
 * missing and has been created, or PayPal will not give us one and the owner
 * needs to be told what that costs them.
 */
async function ensurePaypalWebhookForVerify(
  accessToken: string,
  credentials: PaypalCredentials,
  storeId: string
): Promise<{ credentials: PaypalCredentials | null; note: string | null }> {
  const base = paypalApiBase(credentials.environment);

  if (credentials.webhookId) {
    // Still there? A merchant can delete it in their PayPal dashboard, and a
    // stored id that no longer resolves is worse than none — it makes every
    // delivery unverifiable while the integration insists it is configured.
    const existing = await fetch(`${base}/v1/notifications/webhooks/${credentials.webhookId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => null);
    if (existing?.ok) return { credentials: null, note: null };
    if (existing && existing.status !== 404) {
      // Could not tell. Do not throw away a subscription that may be fine.
      return { credentials: null, note: null };
    }
  }

  const baseUrl = await canonicalBaseUrl();
  const created = await ensurePaypalWebhook(
    accessToken,
    credentials.environment,
    paypalWebhookUrl(baseUrl, storeId)
  ).catch((error: unknown) => ({
    webhookId: null,
    error: error instanceof Error ? error.message : "Could not reach PayPal to set up refund notifications",
  }));

  if (!created.webhookId) {
    return {
      credentials: null,
      note: `Payments work, but refunds will not reach Genesis: ${created.error ?? "no refund webhook could be created"}. A refunded order will keep counting as revenue until this is fixed.`,
    };
  }
  return { credentials: { ...credentials, webhookId: created.webhookId }, note: null };
}
