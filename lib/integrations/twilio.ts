import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { ConnectResult, IntegrationConnector } from "./types";
import { toStatusView } from "./types";
import { encryptCredentials, decryptCredentials } from "./credentials";
import {
  accountReadiness,
  accountUrl,
  classifyFailure,
  isE164,
  messageForm,
  messagesUrl,
  readAccount,
  readSentMessage,
  segmentsFor,
  type SentMessage,
  type TwilioFailure,
} from "./twilioProtocol";

// TWILIO — SMS to customers.
//
// Verified against Twilio's own documentation on 2026-08-27. The protocol half
// lives in ./twilioProtocol.ts, pure and testable; this file holds the
// credentials and the network, and nothing else.
//
// ============ WHY THIS CONNECTOR, AND WHY NOW =============================
//
// Six catalog entries have had `connector: null` since the catalog was written.
// This is the only one of the six that needs NO third-party app review to
// connect: Toast, Square, Calendly, Xero and HubSpot are all OAuth, which means
// registering an app and waiting on someone else's queue before a single line
// can be exercised. Twilio authenticates with credentials the owner already has
// in their own console.
//
// It also answers something COMPLIANCE.md has had on its Action Required list
// for a while: with no RESEND_API_KEY, customers are never told their orders
// shipped. This is a second rail for exactly that, and it does not depend on
// the first one arriving.
//
// ============ API KEY, AND THE HONEST REASON WHY ==========================
//
// Twilio DOES have OAuth now — it went GA on 2026-04-06, and an earlier version
// of this comment would have said it did not. But it is not the delegated
// consent flow the exception rule is really about. Account-level OAuth apps
// support only the client-credentials grant, and the app is created INSIDE the
// merchant's own account — so the merchant still ends up in their console
// generating a secret and pasting it here. That is the same handoff as an API
// key with more steps and no extra safety.
//
// So: api_key, and the exception is real rather than convenient. Worth
// revisiting if Twilio opens an authorization-code flow to third parties, which
// its token endpoint suggests exists for someone.
//   https://www.twilio.com/en-us/changelog/oauth-apis-ga
//   https://www.twilio.com/docs/iam/oauth-apps/account-oauth-apps
//
// ============ AND WHY IT ASKS FOR AN API KEY, NOT THE AUTH TOKEN ==========
//
// Twilio's own guidance: "API keys are the preferred way to authenticate with
// Twilio's REST APIs", with Account SID + Auth Token positioned as the local-
// testing alternative. The difference matters to the owner rather than to us —
// an API key can be deleted in their console the moment they want Genesis out,
// without rotating the master credential that every other integration they own
// is also using. Asking for the Auth Token would work and would be worse.
//   https://www.twilio.com/docs/iam/api-keys

export type TwilioCredentials = {
  schemaVersion: 1;
  /** ACxxxx — which account is being billed. */
  accountSid: string;
  /** SKxxxx — the key, revocable on its own. */
  apiKeySid: string;
  apiKeySecret: string;
  /** A Twilio number in E.164, or an MG… Messaging Service SID. */
  fromNumber: string;
};

/** HTTP Basic, per Twilio: key SID as username, key secret as password. */
function authHeader(credentials: TwilioCredentials): string {
  const raw = `${credentials.apiKeySid}:${credentials.apiKeySecret}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

export type TwilioCallResult<T> = { ok: true; value: T } | { ok: false; failure: TwilioFailure };

async function twilioFetch<T>(
  url: string,
  credentials: TwilioCredentials,
  init: { method: "GET" } | { method: "POST"; form: URLSearchParams },
  read: (body: unknown) => T | null,
): Promise<TwilioCallResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: authHeader(credentials),
        ...(init.method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      // FORM-ENCODED. Twilio refuses a JSON request body, and the refusal does
      // not look like a content-type problem when it arrives.
      ...(init.method === "POST" ? { body: init.form.toString() } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Network error";
    return { ok: false, failure: { kind: "provider", detail: `Couldn't reach Twilio: ${detail}`, code: null } };
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  if (!response.ok) {
    return { ok: false, failure: classifyFailure(response.status, body) };
  }

  const value = read(body);
  if (value === null) {
    return {
      ok: false,
      failure: { kind: "provider", detail: "Twilio's response wasn't in the shape its docs describe.", code: null },
    };
  }
  return { ok: true, value };
}

async function loadCredentials(storeId: string): Promise<TwilioCredentials | null> {
  const integration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId, provider: "TWILIO" } },
  });
  if (!integration?.credentials) return null;
  const credentials = decryptCredentials<TwilioCredentials>(integration.credentials);
  if (!credentials?.accountSid || !credentials.apiKeySid || !credentials.apiKeySecret) return null;
  return credentials;
}

/** Fetch the account, which is also the credential check. */
async function fetchAccount(credentials: TwilioCredentials) {
  return twilioFetch(accountUrl(credentials.accountSid), credentials, { method: "GET" }, readAccount);
}

export const twilioConnector: IntegrationConnector = {
  provider: "TWILIO",
  displayName: "Twilio (SMS to customers)",
  requiredPermission: PERMISSIONS.ORDERS_MANAGE,
  capabilities: {
    authKind: "api_key",
    apiKeyExceptionReason:
      "Twilio's OAuth (GA 2026-04-06) covers account-level apps with the client-credentials grant only — the app is created inside the merchant's own account, so it still ends with them pasting a secret. An API key is the same handoff with fewer steps and can be revoked on its own without rotating the account's master Auth Token.",
    scopes: [],
    // NOTHING. Twilio is a delivery mechanism, not a source of business facts —
    // the interface anticipates exactly this ("not every connector produces
    // business data"), and claiming a read here would put an empty entity type
    // into the Foundation forever.
    reads: [],
    writes: ["sends SMS messages, which spends the merchant's real Twilio balance"],
    // An API key is valid until the merchant deletes it in their own console.
    tokenLifetime: "permanent",
    // HONEST FALSE. Genesis holds a key it did not mint and cannot delete;
    // disconnecting forgets it here. The setup copy tells the owner where to
    // revoke it, which is the only thing that actually ends access.
    revokesOnDisconnect: false,
  },

  // Nothing platform-level to configure: the credentials are the merchant's
  // own, so unlike every OAuth connector here this one is never "unavailable"
  // for want of an environment variable.
  configured() {
    return true;
  },

  async connect(storeId, userId, params) {
    if (params?.accountSid && params.apiKeySid && params.apiKeySecret) {
      const credentials: TwilioCredentials = {
        schemaVersion: 1,
        accountSid: params.accountSid.trim(),
        apiKeySid: params.apiKeySid.trim(),
        apiKeySecret: params.apiKeySecret.trim(),
        fromNumber: (params.fromNumber ?? "").trim(),
      };

      // PROVE IT BEFORE STORING IT. A connection that saves unverified
      // credentials and reports success is how a store ends up "connected" to
      // something that has never worked.
      const account = await fetchAccount(credentials);
      if (!account.ok) {
        throw new Error(account.failure.detail);
      }

      // The From number is what every message will be sent from, and a wrong
      // one fails at send time rather than here — which is the worst place for
      // it to fail. An MG… Messaging Service SID is the other valid shape.
      if (credentials.fromNumber && !isE164(credentials.fromNumber) && !credentials.fromNumber.startsWith("MG")) {
        throw new Error(
          `"${credentials.fromNumber}" isn't a Twilio number in international format (like +15551234567) or a Messaging Service SID (starting MG).`,
        );
      }

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "TWILIO" } },
        create: {
          storeId,
          provider: "TWILIO",
          status: "CONNECTED",
          externalAccountId: account.value.sid,
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          externalAccountId: account.value.sid,
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
      kind: "form",
      fields: [
        { name: "accountSid", label: "Account SID (Twilio Console → Account Info, starts AC)", type: "text" },
        { name: "apiKeySid", label: "API Key SID (Twilio Console → Account → API keys & tokens → Create API key, starts SK)", type: "text" },
        { name: "apiKeySecret", label: "API Key Secret (shown once, when you create the key)", type: "password" },
        { name: "fromNumber", label: "Your Twilio phone number (like +15551234567) or Messaging Service SID", type: "text" },
      ],
    } satisfies ConnectResult;
  },

  async verify(storeId) {
    const credentials = await loadCredentials(storeId);
    if (!credentials) return { ok: false, error: "Not connected" };

    const account = await fetchAccount(credentials);
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "TWILIO" } },
      select: { id: true },
    });

    if (!account.ok) {
      if (integration) {
        await prisma.storeIntegration.update({
          where: { id: integration.id, storeId },
          data: { status: "FAILED", lastError: account.failure.detail, lastVerifiedAt: new Date() },
        });
      }
      return { ok: false, error: account.failure.detail };
    }

    // ============ VERIFIED MEANS THE CREDENTIALS, NOT THE CAPABILITY =======
    //
    // A trial account passes this and still cannot message a customer. That is
    // recorded rather than celebrated — but it is NOT a failure, because
    // nothing is broken and there is nothing to reconnect. Escalating it would
    // put a false alarm in front of an owner whose credentials are perfect.
    //
    // lib/integrations/connectionHealth.ts is the single definition of what a
    // connection's state is and is deliberately not touched from here.
    if (integration) {
      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId },
        data: {
          status: "CONNECTED",
          externalAccountId: account.value.sid,
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });
    }
    // The credentials are good, so this is ok even for a trial account.
    // twilioReadiness() is where "can it actually reach a customer" is asked,
    // and sendSms() refuses with the reason rather than failing silently.
    return { ok: true };
  },

  async disconnect(storeId) {
    // Nothing to revoke at Twilio — see revokesOnDisconnect above. The key is
    // forgotten here and stays live in the owner's console until they delete
    // it, which the setup copy tells them.
    await prisma.storeIntegration.updateMany({
      where: { storeId, provider: "TWILIO" },
      data: { status: "DISCONNECTED", credentials: undefined, lastError: null },
    });
  },

  async status(storeId) {
    const row = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "TWILIO" } },
    });
    return toStatusView(row);
  },

  // NO sync(). Twilio produces no business data — it is a way to say something,
  // not a thing to learn from. The interface allows this explicitly, and a
  // sync() returning [] would make "connected and producing nothing" the
  // permanent, meaningless state of a connector working exactly as intended.
};

// ============ USING IT ====================================================

export type SendSmsOutcome =
  | { ok: true; message: SentMessage; segments: number }
  | { ok: false; reason: TwilioFailure["kind"] | "not_connected" | "no_from_number" | "bad_number"; detail: string };

/**
 * Send one SMS on a store's behalf.
 *
 * EVERY REFUSAL IS ITS OWN REASON. A caller that only knew "it didn't send"
 * could not tell an owner whether to fix a phone number, upgrade their Twilio
 * account, or simply wait — and those are the three things that actually
 * happen.
 */
export async function sendSms(params: {
  storeId: string;
  to: string;
  body: string;
}): Promise<SendSmsOutcome> {
  const credentials = await loadCredentials(params.storeId);
  if (!credentials) {
    return { ok: false, reason: "not_connected", detail: "Twilio isn't connected for this store." };
  }
  if (!credentials.fromNumber) {
    return {
      ok: false,
      reason: "no_from_number",
      detail: "Twilio is connected but has no number to send from. Add one in the connection settings.",
    };
  }
  if (!isE164(params.to)) {
    // CHECKED HERE RATHER THAN AT TWILIO. The same rejection costs a network
    // round trip and arrives as error 21211, which is less useful and slower.
    return {
      ok: false,
      reason: "bad_number",
      detail: `"${params.to}" isn't a phone number in international format (like +15551234567).`,
    };
  }

  const result = await twilioFetch(
    messagesUrl(credentials.accountSid),
    credentials,
    { method: "POST", form: messageForm({ to: params.to, from: credentials.fromNumber, body: params.body }) },
    readSentMessage,
  );

  if (!result.ok) {
    return { ok: false, reason: result.failure.kind, detail: result.failure.detail };
  }
  // Twilio's own count where it gave one, ours where it did not — the number is
  // what the message actually costs.
  return { ok: true, message: result.value, segments: result.value.segments ?? segmentsFor(params.body) };
}

/** Whether this store could send right now, and what to say if not. */
export async function twilioReadiness(storeId: string): Promise<{ canSend: boolean; summary: string }> {
  const credentials = await loadCredentials(storeId);
  if (!credentials) return { canSend: false, summary: "Twilio isn't connected." };

  const account = await fetchAccount(credentials);
  if (!account.ok) return { canSend: false, summary: account.failure.detail };

  const readiness = accountReadiness(account.value);
  if (!readiness.canSendToCustomers) return { canSend: false, summary: readiness.summary };
  if (!credentials.fromNumber) {
    return { canSend: false, summary: "Connected, but no number is set to send from." };
  }
  return { canSend: true, summary: readiness.summary };
}
