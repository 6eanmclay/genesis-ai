import EasyPost from "@easypost/api";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { ConnectResult, IntegrationConnector, SyncedRecord } from "./types";
import type { Shipment } from "@/lib/businessModel/entities";
import { toStatusView } from "./types";
import { encryptCredentials, decryptCredentials } from "./credentials";

// Priority 2 (shipping, 2026-08-09) — "USPS/shipping integration so a paid
// order can go all the way through fulfillment, label/tracking" (Sean).
// USPS itself has no direct self-serve REST API for a small business to
// buy real retail labels — EasyPost is the real, standard way apps get
// real USPS (and other carrier) rates/labels/tracking through one REST
// API, confirmed against EasyPost's own current docs and the installed
// SDK's own type definitions before writing this (this codebase's own
// standing "verify against real docs/installed types, not training-data
// memory" discipline — see AGENTS.md). The IntegrationProvider value stays
// USPS (already reserved in the schema as a future connector) because
// that's how Sean and the owner actually think about this connection —
// EasyPost is the real mechanism underneath, named honestly in the setup
// docs and displayName below, not hidden.

// Phase 2 (2026-08-19) — EasyPost, called EasyPost.
//
// This connector was named "USPS" and its form asked for a "USPS API key". The
// merchant does not have one and never will: the provider is EASYPOST, which
// issues its own account key and buys USPS postage on the merchant's behalf.
// Asking someone for a credential that does not exist is a good way to make
// them think the product is broken.
//
// THE ENUM VALUE IS NOW EASYPOST TOO (2026-08-20). It was left as USPS at first
// on the assumption that live rows depended on it — checking production showed
// zero StoreIntegration rows, zero execution logs and zero tracked orders using
// it, so the objection did not hold. Renamed with ALTER TYPE ... RENAME VALUE,
// which relabels in place and rewrites no data.
//
// USPS still appears in this codebase as a CARRIER name (shipping.ts filters
// rates by carrier === "USPS"), which is correct and untouched — EasyPost is who
// Genesis talks to, USPS is who carries the parcel.
//
// THE API KEY IS A SANCTIONED EXCEPTION, not laziness: EasyPost offers no OAuth
// authorization flow for this use, so there is no delegated handoff to prefer.

export type EasyPostCredentials = {
  schemaVersion: 1;
  apiKey: string;
};

function getClient(apiKey: string) {
  return new EasyPost(apiKey);
}

// The cheapest honest proof a submitted key is real: ask EasyPost for the
// account's own API keys list, which requires a genuinely valid key to
// succeed. No cheaper no-op "whoami" endpoint exists in the SDK's own
// types.
async function verifyApiKey(apiKey: string): Promise<void> {
  const client = getClient(apiKey);
  await client.ApiKey.all();
}


/** The shape this connector needs from an EasyPost tracker. */
export interface TrackerLike {
  tracking_code?: string | null;
  carrier?: string | null;
  status?: string | null;
  status_detail?: string | null;
  est_delivery_date?: string | null;
  tracking_details?: Array<{
    datetime?: string | null;
    message?: string | null;
    status?: string | null;
    tracking_location?: { city?: string | null; state?: string | null; country?: string | null } | null;
  }> | null;
}

/** Statuses that mean the parcel is not simply "on its way". */
const EXCEPTION_STATUSES = new Set(["failure", "error", "return_to_sender", "cancelled"]);

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function formatLocation(loc: { city?: string | null; state?: string | null; country?: string | null } | null | undefined): string | null {
  if (!loc) return null;
  const parts = [loc.city, loc.state, loc.country].filter((p): p is string => !!p && p.trim().length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * An EasyPost tracker, as a canonical shipment — pure, so delivery-status
 * handling is provable without an EasyPost account.
 *
 * NOTHING IS INVENTED. A parcel with no scans yet has null timestamps rather
 * than the order date standing in for them, and an unrecognised status is
 * carried through verbatim rather than being forced into a known bucket.
 */
export function mapTrackerToShipment(tracker: TrackerLike, orderId: string | null): Shipment {
  const status = tracker.status?.trim() || "unknown";
  const details = (tracker.tracking_details ?? []).filter((d) => d);

  // The newest scan by time, not by array position — carriers are not reliably
  // ordered, and "latest" is the one fact an owner actually reads.
  const scans = details
    .map((d) => ({ ...d, at: isoOrNull(d.datetime) }))
    .filter((d) => d.at !== null)
    .sort((a, b) => (a.at! < b.at! ? 1 : -1));
  const latest = scans[0] ?? null;

  // Delivery time comes from the scan that says delivered, never from "now" —
  // a sync running today must not claim the parcel arrived today.
  const deliveredScan = scans.find((d) => (d.status ?? "").toLowerCase() === "delivered") ?? null;

  return {
    trackingCode: tracker.tracking_code?.trim() || "",
    carrier: tracker.carrier?.trim() || null,
    status,
    statusDetail: tracker.status_detail?.trim() || null,
    estimatedDeliveryAt: isoOrNull(tracker.est_delivery_date),
    deliveredAt: deliveredScan?.at ?? (status === "delivered" ? (latest?.at ?? null) : null),
    lastScanAt: latest?.at ?? null,
    lastScanDescription: latest?.message?.trim() || null,
    lastScanLocation: formatLocation(latest?.tracking_location),
    orderId,
    isDelivered: status === "delivered",
    // "Not delivered yet" is not an exception. Only a real problem is.
    isException: EXCEPTION_STATUSES.has(status),
  };
}

export const easypostConnector: IntegrationConnector = {
  provider: "EASYPOST",
  displayName: "EasyPost (shipping labels & tracking)",
  requiredPermission: PERMISSIONS.ORDERS_MANAGE,
  capabilities: {
    // A LEGITIMATE EXCEPTION, per Sean's rule. The real provider is EasyPost,
    // which issues API keys and offers no OAuth flow for this use. Forcing an
    // OAuth shape here would be inventing one the provider does not have.
    authKind: "api_key",
    apiKeyExceptionReason:
      "EasyPost (the actual provider behind this connector) authenticates with an account API key and offers no OAuth authorization flow.",
    scopes: [],
    reads: ["shipment"],
    writes: ["purchases shipping labels, which spends the merchant's real money"],
  },

  async connect(storeId, userId, params) {
    if (params?.apiKey) {
      const apiKey = params.apiKey.trim();
      await verifyApiKey(apiKey);

      const credentials: EasyPostCredentials = { schemaVersion: 1, apiKey };
      const encryptedCredentials = encryptCredentials(credentials);

      await prisma.storeIntegration.upsert({
        where: { storeId_provider: { storeId, provider: "EASYPOST" } },
        create: {
          storeId,
          provider: "EASYPOST",
          status: "CONNECTED",
          externalAccountId: "easypost",
          credentials: encryptedCredentials,
          connectedByUserId: userId,
          connectedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          status: "CONNECTED",
          credentials: encryptedCredentials,
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
      fields: [{ name: "apiKey", label: "EasyPost API Key (EasyPost → Account Settings → API Keys)", type: "password" }],
    } satisfies ConnectResult;
  },

  async verify(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "EASYPOST" } },
    });
    if (!integration?.credentials) {
      return { ok: false, error: "Not connected" };
    }
    const credentials = decryptCredentials<EasyPostCredentials>(integration.credentials);
    if (!credentials?.apiKey) {
      return { ok: false, error: "Not connected" };
    }

    try {
      await verifyApiKey(credentials.apiKey);
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


  /**
   * Delivery status for every parcel this store has a tracking number for.
   *
   * WHAT THIS ADDS THAT GENESIS DID NOT HAVE. Buying a label already stored a
   * tracking number on the Order — the promise that something shipped. Nothing
   * ever learned what happened next. This is the difference between "you have a
   * tracking number" and "that parcel was delivered on Tuesday", which is the
   * only version an owner can act on.
   *
   * READ-ONLY. It buys nothing and changes nothing at EasyPost; label purchase
   * stays where it is, an explicit owner-triggered action that spends real
   * money (lib/execution/executables/shipping.ts), untouched by this.
   *
   * Keyed by tracking code, so a re-sync updates the same BusinessRecord in
   * place rather than accumulating a row per poll.
   */
  async sync(storeId): Promise<SyncedRecord[]> {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "EASYPOST" } },
    });
    if (integration?.status !== "CONNECTED" || !integration.credentials) return [];

    const credentials = decryptCredentials<EasyPostCredentials>(integration.credentials);
    if (!credentials?.apiKey) return [];
    const client = getClient(credentials.apiKey);

    // Bounded, newest first: a sync is a routine background pass, not a
    // full-history crawl, and an old delivered parcel does not change again.
    const orders = await prisma.order.findMany({
      where: { storeId, trackingNumber: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, trackingNumber: true },
    });

    const records: SyncedRecord[] = [];
    for (const order of orders) {
      const trackingCode = order.trackingNumber;
      if (!trackingCode) continue;
      try {
        const page = (await client.Tracker.all({ tracking_code: trackingCode })) as {
          trackers?: TrackerLike[];
        };
        const tracker = page?.trackers?.[0];
        if (!tracker) continue;
        records.push({
          entityType: "shipment",
          externalId: trackingCode,
          data: mapTrackerToShipment(tracker, order.id),
        });
      } catch {
        // One unreadable tracking code must not fail the whole sync. The
        // parcel simply has no shipment record this pass, which is honest —
        // better than aborting and leaving every other parcel unknown too.
        continue;
      }
    }
    return records;
  },

  async disconnect(storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "EASYPOST" } },
    });
    if (!integration) return;

    // No revoke call for a bare API key — regenerating it in the EasyPost
    // dashboard is how a merchant would fully cut access, same posture as
    // PayPal's own disconnect() comment.
    await prisma.storeIntegration.update({
      where: { id: integration.id, storeId },
      data: { status: "DISCONNECTED", credentials: Prisma.DbNull },
    });
  },

  async status(storeId) {
    // Phase 0 — never returns the credentials blob.
    return toStatusView(
      await prisma.storeIntegration.findUnique({
        where: { storeId_provider: { storeId, provider: "EASYPOST" } },
      })
    );
  },
};
