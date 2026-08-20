import { prisma } from "@/lib/prisma";
import { beginOAuthHandoff } from "./oauthState";
import { PERMISSIONS } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { ConnectResult, IntegrationConnector, SyncedRecord } from "./types";
import { toStatusView } from "./types";
import { getBaseUrl, integrationCallbackUrl } from "./util";
import { encryptCredentials, decryptCredentials } from "./credentials";
import { mergeRefreshedTokens } from "./tokenRefresh";
import { integrationFetch, isGoogleRateLimit } from "./rateLimit";
import type { Appointment } from "@/lib/businessModel/entities";
import { internalContactId } from "@/lib/businessModel/internalMapper";

// Phase 3 Milestone 2 — proof integration #1: OAuth-redirect (same shape as
// Stripe), read-only scope (calendar.readonly — this phase never writes
// back to a connected system), and the first connector to implement
// sync(), the Foundation's mapping contract. Real Google Cloud OAuth app
// credentials (GOOGLE_CALENDAR_CLIENT_ID/SECRET) are provisioned at
// implementation time — see this milestone's own plan for why that's
// deliberately not blocking the framework itself.

type GoogleCalendarCredentials = {
  schemaVersion: 1;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
};

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
// Google's documented revocation endpoint.
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

async function refreshAccessToken(
  storeId: string,
  credentials: GoogleCalendarCredentials
): Promise<string> {
  if (credentials.expiresAt > Date.now() + 60_000) {
    return credentials.accessToken;
  }
  if (!credentials.refreshToken) {
    throw new Error("Google Calendar connection expired and can't be refreshed automatically.");
  }
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google Calendar isn't configured yet.");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    // Google does not rotate refresh tokens, so a 400 here is not the rotation
    // bug QuickBooks had — it means the token was revoked or expired. The most
    // common cause by far is an OAuth consent screen still in "Testing"
    // publishing status, where Google expires every refresh token after seven
    // days. That is a Google Cloud Console setting, not something code can fix.
    const detail =
      res.status === 400
        ? "Google no longer accepts this connection's saved credentials — please reconnect Google Calendar."
        : `Google token refresh failed (${res.status})`;
    throw new Error(detail);
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  // Persist the refreshed token (2026-08-20). Google does not rotate, so this
  // was not fatal the way QuickBooks' identical omission was — but without it
  // every single call re-refreshed, burning a network round trip and a quota
  // hit to re-derive a token we already had.
  // Shared, tested merge — see lib/integrations/tokenRefresh.ts for why a
  // rotated refresh token must never be discarded.
  const updated: GoogleCalendarCredentials = mergeRefreshedTokens(credentials, data);
  await prisma.storeIntegration.updateMany({
    where: { storeId, provider: "GOOGLE_CALENDAR" },
    data: { credentials: encryptCredentials(updated) },
  });

  return updated.accessToken;
}

export const googleCalendarConnector: IntegrationConnector = {
  provider: "GOOGLE_CALENDAR",
  displayName: "Google Calendar",
  requiredPermission: PERMISSIONS.CONNECTIONS_MANAGE,
  capabilities: {
    authKind: "oauth",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    reads: ["appointment"],
    writes: [],
    // calls Google's revoke endpoint
    revokesOnDisconnect: true,
  },

  async connect(storeId, userId, params) {
    const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        "Google Calendar isn't configured yet — GOOGLE_CALENDAR_CLIENT_ID/SECRET are missing."
      );
    }

    // Second call: the callback route hands us the OAuth code.
    if (params?.code) {
      const baseUrl = await getBaseUrl();
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code: params.code,
          grant_type: "authorization_code",
          redirect_uri: integrationCallbackUrl(baseUrl, "GOOGLE_CALENDAR"),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Google token exchange failed (${res.status}): ${body}`);
      }
      const token = (await res.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };

      const credentials: GoogleCalendarCredentials = {
        schemaVersion: 1,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
      };

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "GOOGLE_CALENDAR" } },
        create: {
          storeId,
          provider: "GOOGLE_CALENDAR",
          status: "CONNECTED",
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          credentials: encryptCredentials(credentials),
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });

      return { kind: "connected" };
    }

    // First call: send the merchant to Google's own hosted OAuth flow.
    const baseUrl = await getBaseUrl();
    const url = new URL(AUTH_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", integrationCallbackUrl(baseUrl, "GOOGLE_CALENDAR"));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", await beginOAuthHandoff({ storeId, userId, provider: "GOOGLE_CALENDAR", executionId: params?.executionId }));

    return { kind: "redirect", url: url.toString() } satisfies ConnectResult;
  },

  async verify(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "GOOGLE_CALENDAR" } },
    });
    if (!integration?.credentials) {
      return { ok: false, error: "Not connected" };
    }

    try {
      const credentials = decryptCredentials<GoogleCalendarCredentials>(integration.credentials);
      const accessToken = await refreshAccessToken(storeId, credentials);
      const res = await integrationFetch(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1",
        { headers: { Authorization: `Bearer ${accessToken}` } },
        // Google signals a rate limit with 403 OR 429, and a 403 is also how it
        // reports a genuinely missing permission — which must NOT be retried.
        { label: "Google Calendar", isRateLimited: isGoogleRateLimit }
      );
      const ok = res.ok;
      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId },
        data: {
          status: ok ? "CONNECTED" : "NEEDS_ATTENTION",
          lastVerifiedAt: new Date(),
          lastError: ok ? null : `Google Calendar check failed (${res.status})`,
        },
      });
      return ok ? { ok: true } : { ok: false, error: `Google Calendar check failed (${res.status})` };
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
      where: { storeId_provider: { storeId, provider: "GOOGLE_CALENDAR" } },
    });
    if (!integration) return;

    // REVOKE AT GOOGLE (2026-08-20). This used to say the revoke endpoint
    // "could be added here later" and pointed the merchant at their own Google
    // account settings. That put the work on the person who had just clicked
    // Disconnect and been told it was done. Forgetting a token is not ending
    // access, and this scope reads real personal calendar data.
    //
    // Best effort: an unreachable Google must not trap an owner in a connection
    // they asked to end, so the local disconnect proceeds either way and the
    // failure is logged rather than swallowed.
    if (integration.credentials) {
      try {
        const credentials = decryptCredentials<GoogleCalendarCredentials>(integration.credentials);
        // Revoking the refresh token ends the whole grant; the access token is
        // the fallback for a connection that never received one.
        const token = credentials?.refreshToken ?? credentials?.accessToken;
        if (token) {
          const res = await fetch(REVOKE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token }),
          });
          if (!res.ok) {
            console.error(`[integrations/google_calendar] revoke returned ${res.status} for store ${storeId}`);
          }
        }
      } catch (error) {
        console.error(
          `[integrations/google_calendar] revoke failed for store ${storeId}`,
          error instanceof Error ? error.message : error
        );
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
        where: { storeId_provider: { storeId, provider: "GOOGLE_CALENDAR" } },
      })
    );
  },

  // The Foundation's mapping contract, made real for the first time. Maps
  // upcoming calendar events into canonical Appointment records — a small,
  // deliberately modest slice (50 upcoming events), never the full API
  // surface, matching "prove the architecture, don't over-build any one
  // integration."
  async sync(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "GOOGLE_CALENDAR" } },
    });
    if (!integration?.credentials) return [];

    const credentials = decryptCredentials<GoogleCalendarCredentials>(integration.credentials);
    const accessToken = await refreshAccessToken(storeId, credentials);

    const url = new URL(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events"
    );
    url.searchParams.set("timeMin", new Date().toISOString());
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");

    const res = await integrationFetch(
      url.toString(),
      { headers: { Authorization: `Bearer ${accessToken}` } },
      { label: "Google Calendar", isRateLimited: isGoogleRateLimit }
    );
    if (!res.ok) {
      throw new Error(`Google Calendar events fetch failed (${res.status})`);
    }
    const data = (await res.json()) as {
      items?: {
        id: string;
        summary?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
        status?: string;
        attendees?: { email?: string }[];
      }[];
    };

    return (data.items ?? []).map((event): SyncedRecord => {
      // Integrations (Chapter 4, connected-data understanding) — real
      // attendee emails, already returned by the Events API, mapped to a
      // real contact identity via the exact same internalContactId(email)
      // convention Order-derived contacts already use. When an attendee's
      // email matches a real customer Genesis already knows, this
      // appointment genuinely links to them — not a new contact scheme,
      // reusing the one that already exists.
      const contactIds = (event.attendees ?? [])
        .map((a) => a.email)
        .filter((email): email is string => Boolean(email))
        .map((email) => internalContactId(email));
      const appointment: Appointment = {
        title: event.summary ?? "(untitled event)",
        startAt: event.start?.dateTime ?? event.start?.date ?? new Date().toISOString(),
        endAt: event.end?.dateTime ?? event.end?.date ?? null,
        contactIds,
        locationId: null,
        status: event.status ?? null,
      };
      return { entityType: "appointment", externalId: event.id, data: appointment };
    });
  },
};
