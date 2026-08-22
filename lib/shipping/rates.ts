import EasyPost from "@easypost/api";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/money";
import { decryptCredentials } from "@/lib/integrations/credentials";
import type { EasyPostCredentials } from "@/lib/integrations/easypost";

// Live shipping rates at checkout (2026-08-20).
//
// THE BOUNDARY THIS FILE EXISTS TO HOLD. EasyPost credentials are PER STORE.
// Every rate quoted, every label bought and every dollar of postage spent comes
// from the connected merchant's own EasyPost account and wallet. Genesis has no
// platform-wide EasyPost key and must never acquire one: a platform key would
// mean Genesis silently funding a customer's postage out of its own balance,
// with no consent and no accounting.
//
// There is deliberately NO fallback here. If a store has not connected
// EasyPost, rating fails with a reason — it does not quietly use someone
// else's account. `resolveStoreEasyPostClient` is the only way to get a client
// in this codebase's checkout path, and it takes a storeId, always.
//
// Read-only: rating creates a Shipment at EasyPost to obtain quotes, which
// costs nothing. Buying the label is a separate, explicit, owner-triggered act.

/** Why a store cannot be quoted right now. Never a silent empty list. */
export type RateFailure =
  | "not_connected"
  | "no_credentials"
  | "no_parcel_data"
  | "no_origin_address"
  | "carrier_returned_none"
  | "provider_error";

export interface ShippingOption {
  /** EasyPost rate id — carried through checkout so the exact quote is bought. */
  rateId: string;
  carrier: string;
  service: string;
  /** What the customer will be charged, in cents. */
  amountInCents: number;
  /** Carrier's own delivery estimate, when it gives one. Null is common. */
  estimatedDays: number | null;
  /** A human line for the checkout list — built from real values only. */
  label: string;
}

export type RateResult =
  | { ok: true; options: ShippingOption[] }
  | { ok: false; reason: RateFailure; detail?: string };

export interface DestinationAddress {
  name?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  state?: string | null;
  postalCode: string;
  country: string;
}

export interface ParcelDimensions {
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
}

/**
 * The parcel for a product — pure, so "we cannot rate this" is testable.
 *
 * Returns null rather than a default when weight is missing. A guessed weight
 * produces a real price on a real customer's order, and being wrong there is
 * worse than declining to quote.
 */
export function parcelForProduct(product: {
  weightOz: number | null;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
}): ParcelDimensions | null {
  const { weightOz, lengthIn, widthIn, heightIn } = product;
  if (weightOz === null || weightOz <= 0) return null;
  // Dimensions matter less than weight for most domestic services, and
  // carriers accept a rate request without them — but EasyPost wants numbers,
  // so a product with weight and no box gets the smallest sane envelope rather
  // than being refused outright. Weight is the one thing never invented.
  return {
    weightOz,
    lengthIn: lengthIn && lengthIn > 0 ? lengthIn : 6,
    widthIn: widthIn && widthIn > 0 ? widthIn : 4,
    heightIn: heightIn && heightIn > 0 ? heightIn : 2,
  };
}

export interface EasyPostRateLike {
  id?: string | null;
  carrier?: string | null;
  service?: string | null;
  rate?: string | null;
  delivery_days?: number | null;
  est_delivery_days?: number | null;
}

/** Turn a service code into something a shopper recognises. */
export function humanService(service: string): string {
  return service
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * EasyPost rates as checkout options — pure, and the place every honesty rule
 * about pricing lives.
 *
 * Cheapest first, because that is the order a shopper reads. A rate with no
 * usable price is dropped rather than shown at zero.
 */
export function toShippingOptions(rates: EasyPostRateLike[], currency: string): ShippingOption[] {
  const options: ShippingOption[] = [];

  for (const rate of rates) {
    if (!rate?.id || !rate.carrier || !rate.service) continue;
    const parsed = Number.parseFloat(rate.rate ?? "");
    if (!Number.isFinite(parsed) || parsed <= 0) continue;

    // Rates are decimal dollars as strings. Rounding to cents at the boundary
    // keeps every downstream number an integer.
    const amountInCents = Math.round(parsed * 100);
    const days = rate.delivery_days ?? rate.est_delivery_days ?? null;
    const service = humanService(rate.service);

    options.push({
      rateId: rate.id,
      carrier: rate.carrier,
      service,
      amountInCents,
      estimatedDays: typeof days === "number" && days > 0 ? days : null,
      // No estimate is stated as no estimate. Carriers frequently omit it, and
      // inventing "3-5 days" would be a promise the carrier never made.
      label:
        typeof days === "number" && days > 0
          ? `${rate.carrier} ${service} — ${formatMoney(amountInCents, currency)}, about ${days} day${days === 1 ? "" : "s"}`
          : `${rate.carrier} ${service} — ${formatMoney(amountInCents, currency)}`,
    });
  }

  return options.sort((a, b) => a.amountInCents - b.amountInCents || a.carrier.localeCompare(b.carrier));
}

/**
 * The ONLY way this codebase obtains an EasyPost client for checkout.
 *
 * Takes a storeId and reads that store's own connected credentials. There is no
 * variant that reads an environment variable, because a platform-wide key is
 * precisely the thing that must not exist.
 */
export async function resolveStoreEasyPostClient(
  storeId: string
): Promise<{ ok: true; client: InstanceType<typeof EasyPost> } | { ok: false; reason: RateFailure }> {
  const integration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId, provider: "EASYPOST" } },
  });

  if (!integration || integration.status !== "CONNECTED") {
    return { ok: false, reason: "not_connected" };
  }
  if (!integration.credentials) return { ok: false, reason: "no_credentials" };

  const credentials = decryptCredentials<EasyPostCredentials>(integration.credentials);
  if (!credentials?.apiKey) return { ok: false, reason: "no_credentials" };

  return { ok: true, client: new EasyPost(credentials.apiKey) };
}

export interface StoreReturnAddressLike {
  name: string;
  phone?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  state?: string | null;
  postalCode: string;
  country: string;
}

/**
 * Live options for shipping one product to one destination.
 *
 * Every failure is named. A checkout that cannot quote must say why — "no
 * shipping options" with no reason is indistinguishable from a broken
 * integration, and the owner is the only person who can fix any of these.
 */
export async function quoteShippingForProduct(params: {
  storeId: string;
  productId: string;
  destination: DestinationAddress;
}): Promise<RateResult> {
  const [product, store] = await Promise.all([
    prisma.product.findFirst({
      where: { id: params.productId, storeId: params.storeId, active: true },
      select: { weightOz: true, lengthIn: true, widthIn: true, heightIn: true },
    }),
    prisma.store.findUnique({ where: { id: params.storeId }, select: { returnAddress: true, currency: true } }),
  ]);

  if (!product) return { ok: false, reason: "no_parcel_data", detail: "Product not found" };

  const parcel = parcelForProduct(product);
  if (!parcel) {
    return {
      ok: false,
      reason: "no_parcel_data",
      detail: "This product has no shipping weight set, so live rates can't be calculated.",
    };
  }

  const origin = store?.returnAddress as unknown as StoreReturnAddressLike | null;
  if (!origin?.line1 || !origin?.postalCode) {
    return {
      ok: false,
      reason: "no_origin_address",
      detail: "This store has no return address set, so carriers can't quote from anywhere.",
    };
  }

  // Per-store credentials. See this file's header for why there is no fallback.
  const resolved = await resolveStoreEasyPostClient(params.storeId);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  try {
    const shipment = await resolved.client.Shipment.create({
      to_address: {
        name: params.destination.name ?? undefined,
        street1: params.destination.line1,
        street2: params.destination.line2 ?? undefined,
        city: params.destination.city,
        state: params.destination.state ?? undefined,
        zip: params.destination.postalCode,
        country: params.destination.country,
      },
      from_address: {
        name: origin.name,
        phone: origin.phone ?? undefined,
        street1: origin.line1,
        street2: origin.line2 ?? undefined,
        city: origin.city,
        state: origin.state ?? undefined,
        zip: origin.postalCode,
        country: origin.country,
      },
      parcel: {
        weight: parcel.weightOz,
        length: parcel.lengthIn,
        width: parcel.widthIn,
        height: parcel.heightIn,
      },
    });

    const options = toShippingOptions((shipment?.rates ?? []) as EasyPostRateLike[], store?.currency ?? "USD");
    if (options.length === 0) {
      return {
        ok: false,
        reason: "carrier_returned_none",
        detail:
          shipment?.messages?.length
            ? shipment.messages.map((m: { message?: string }) => m.message).filter(Boolean).join("; ")
            : "No carrier returned a rate for this address and package.",
      };
    }
    return { ok: true, options };
  } catch (error) {
    return {
      ok: false,
      reason: "provider_error",
      detail: error instanceof Error ? error.message.slice(0, 200) : "Rating failed",
    };
  }
}

// --- Buying the rate the customer actually paid for -------------------------

export interface SelectedService {
  carrier: string | null;
  service: string | null;
}

export type RateChoice<T extends EasyPostRateLike = EasyPostRateLike> =
  | { ok: true; rate: T; matchedSelection: boolean }
  | { ok: false; reason: "no_rates" }
  | { ok: false; reason: "selection_unavailable"; wanted: string; offered: string[] };

/**
 * Which rate should this label be bought at? — pure.
 *
 * THE DEFECT THIS EXISTS TO FIX (2026-08-20). The label purchase filtered to
 * USPS and bought the cheapest, ignoring `Order.selectedShippingService`
 * entirely — the service the customer chose at checkout and was charged for. A
 * customer who paid for Priority Mail Express got Ground Advantage, the delivery
 * promise made to them was quietly broken, and the difference landed in the
 * store's margin without anybody deciding that.
 *
 * When the order carries a selection, that selection is what gets bought. When
 * the carrier is not offering it any more, this REFUSES rather than substituting
 * — silently downgrading a paid-for service is the defect, not the fallback.
 *
 * When there is no selection at all (an ordinary checkout, no live shipping)
 * the old behaviour stands: the cheapest USPS rate, which is what the owner has
 * always been buying.
 */
export function chooseRate<T extends EasyPostRateLike>(rates: T[], selected: SelectedService): RateChoice<T> {
  const usable = rates.filter(
    (r) => r?.id && r.carrier && r.service && Number.isFinite(Number.parseFloat(r.rate ?? ""))
  );
  if (usable.length === 0) return { ok: false, reason: "no_rates" };

  const wantCarrier = selected.carrier?.trim();
  const wantService = selected.service?.trim();

  if (wantCarrier && wantService) {
    // Compared through humanService because that is the form the customer was
    // shown and the form stored on the order — "GroundAdvantage" at the carrier,
    // "Ground Advantage" on the order. Matching raw against stored would never
    // hit, which would turn every live-shipping order into a refusal.
    const match = usable.find(
      (r) =>
        r.carrier!.toLowerCase() === wantCarrier.toLowerCase() &&
        humanService(r.service!).toLowerCase() === humanService(wantService).toLowerCase()
    );
    if (match) return { ok: true, rate: match, matchedSelection: true };
    return {
      ok: false,
      reason: "selection_unavailable",
      wanted: `${wantCarrier} ${humanService(wantService)}`,
      offered: usable.map((r) => `${r.carrier} ${humanService(r.service!)}`),
    };
  }

  // No selection: the pre-existing behaviour, unchanged.
  const usps = usable.filter((r) => r.carrier === "USPS");
  const pool: T[] = usps.length > 0 ? usps : [];
  if (pool.length === 0) return { ok: false, reason: "no_rates" };
  const cheapest = pool.reduce((lowest, r) =>
    Number.parseFloat(r.rate ?? "") < Number.parseFloat(lowest.rate ?? "") ? r : lowest
  );
  return { ok: true, rate: cheapest, matchedSelection: false };
}
