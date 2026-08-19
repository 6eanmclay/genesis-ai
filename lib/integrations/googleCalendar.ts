import { prisma } from "@/lib/prisma";
import { beginOAuthHandoff } from "./oauthState";
import { PERMISSIONS } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { ConnectResult, IntegrationConnector, SyncedRecord } from "./types";
import { toStatusView } from "./types";
import { getBaseUrl, integrationCallbackUrl } from "./util";
import { encryptCredentials, decryptCredentials } from "./credentials";
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

async function refreshAccessToken(credentials: GoogleCalendarCredentials): Promise<string> {
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
    throw new Error(`Google token refresh failed (${res.status})`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  return data.access_token;
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
      const accessToken = await refreshAccessToken(credentials);
      const res = await fetch(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1",
        { headers: { Authorization: `Bearer ${accessToken}` } }
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
    // No revoke call — Google's token.revoke endpoint could be added here
    // later; the merchant can also revoke access directly from their
    // Google Account's own connected-apps settings.
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
    const accessToken = await refreshAccessToken(credentials);

    const url = new URL(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events"
    );
    url.searchParams.set("timeMin", new Date().toISOString());
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
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
