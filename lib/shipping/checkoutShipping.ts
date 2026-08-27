import { prisma } from "@/lib/prisma";
import { ownerPacksThis } from "./whoShips";
import { carrierAvailability } from "./carriers";
import { uspsIsConfigured } from "./usps/client";
import { quoteShippingForProduct, type DestinationAddress, type ShippingOption } from "./rates";

// Customer-chosen shipping at checkout (2026-08-20).
//
// GATED, DELIBERATELY. A store that has not connected EasyPost, or a product
// with no shipping weight, checks out exactly as it did before this existed —
// straight to Stripe, no address step, no rates. Shipping selection appears
// only where it can actually work, so shipping this cannot degrade a storefront
// that is selling fine today.
//
// THE PRICE IS NEVER TAKEN FROM THE BROWSER. The customer's device sends back a
// rate ID and nothing else that touches money; the amount charged is re-fetched
// from the carrier server-side and matched to that ID. A page that could name
// its own shipping price could name $0.

export interface SelectedShipping {
  rateId: string;
  carrier: string;
  service: string;
  amountInCents: number;
  estimatedDays: number | null;
}

/**
 * Can this product be quoted live for shipping at all?
 *
 * Three things must hold: SOMETHING can quote a rate, the store can take the
 * money, and the product has a real weight. Any missing means the old checkout
 * path, which is a working checkout — not a degraded one.
 *
 * "Something can quote a rate" used to read "the merchant connected their own
 * EasyPost account", and that was the whole problem: across sixteen production
 * businesses not one had, so this returned false everywhere and a fully built
 * shipping flow was reachable by nobody. Genesis's own USPS credentials now
 * satisfy it for every store — see lib/shipping/carriers.ts.
 */
export async function productSupportsLiveShipping(storeId: string, productId: string): Promise<boolean> {
  const [easypost, stripe, product] = await Promise.all([
    prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "EASYPOST" } },
      select: { status: true },
    }),
    // STRIPE IS REQUIRED TOO, and leaving it out was a real customer-facing
    // dead end (found 2026-08-20 by tracing the PayPal checkout path).
    //
    // checkoutWithShipping calls createStripeCheckoutSession DIRECTLY — it does
    // not go through selectProvider — because a chosen shipping service has to
    // become a Stripe shipping_options line. So a store with EasyPost connected
    // and PayPal but no Stripe passed this check, showed the customer the whole
    // live-shipping flow, took a full delivery address, quoted real carrier
    // rates, and then failed on the buy with "Something went wrong on our end".
    //
    // The customer did the most work available and got the least useful error,
    // and the owner had no way to know it was happening. Gating here means the
    // storefront simply offers the ordinary checkout instead, which works.
    prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "STRIPE" } },
      select: { status: true },
    }),
    prisma.product.findFirst({
      where: { id: productId, storeId, active: true },
      select: { weightOz: true, sourceKind: true },
    }),
  ]);

  // A RATE SOURCE, not a specific vendor. USPS on Genesis's credentials counts,
  // and so does a merchant's own EasyPost account — whichever is present.
  const availability = carrierAvailability({
    uspsConfigured: uspsIsConfigured(),
    easypostConnected: easypost?.status === "CONNECTED",
  });
  if (availability.rates === "NONE") return false;

  // STRIPE IS STILL REQUIRED, unchanged. A chosen shipping service has to
  // become a Stripe shipping_options line, so a store without Stripe would take
  // the customer through the whole address-and-rates flow and then fail on the
  // buy — the exact dead end this check was extended for in 2026-08-20.
  if (stripe?.status !== "CONNECTED") return false;
  if (!product) return false;

  // THE OWNER HAS TO BE THE ONE SHIPPING IT (2026-08-26).
  //
  // These rates are quoted against the OWNER'S OWN EasyPost account, and the
  // label bought afterwards is theirs to print and attach. For a print-on-demand
  // or dropshipped product the partner packs and posts it from their own
  // warehouse — so quoting the owner's postage would charge the customer for a
  // parcel nobody in this business will ever hold, and then offer the owner a
  // label for it.
  //
  // ProductSourceKind has said which is which since 2026-08-20 and nothing read
  // it. See lib/shipping/whoShips.ts.
  if (!ownerPacksThis(product.sourceKind)) return false;

  return typeof product.weightOz === "number" && product.weightOz > 0;
}

export type SelectionFailure =
  | { ok: false; reason: "rate_expired"; options: ShippingOption[] }
  | { ok: false; reason: "unavailable"; detail?: string };

/**
 * Re-quote and confirm the customer's chosen rate — the security boundary.
 *
 * The browser tells us WHICH option was chosen. It never tells us what that
 * option costs. This re-asks the carrier and matches by id, so the amount
 * charged is always one the carrier just quoted to this destination for this
 * parcel.
 *
 * Carrier rates genuinely expire. A stale id is not an error to shout about —
 * it returns the fresh options so the customer can choose again, which is what
 * every real checkout does.
 */
export async function confirmSelectedRate(params: {
  storeId: string;
  productId: string;
  destination: DestinationAddress;
  rateId: string;
}): Promise<{ ok: true; selected: SelectedShipping } | SelectionFailure> {
  const quote = await quoteShippingForProduct({
    storeId: params.storeId,
    productId: params.productId,
    destination: params.destination,
  });

  if (!quote.ok) return { ok: false, reason: "unavailable", detail: quote.detail };

  const match = quote.options.find((option) => option.rateId === params.rateId);
  if (!match) return { ok: false, reason: "rate_expired", options: quote.options };

  return {
    ok: true,
    selected: {
      rateId: match.rateId,
      carrier: match.carrier,
      service: match.service,
      amountInCents: match.amountInCents,
      estimatedDays: match.estimatedDays,
    },
  };
}

/**
 * What travels to Stripe and comes back through the webhook.
 *
 * Stripe metadata values are capped at 500 characters, so the address is kept
 * to the fields an order actually needs. Carried this way because the customer
 * has already typed their address on the storefront — asking Stripe to collect
 * it again would mean typing it twice.
 */
export function toCheckoutMetadata(params: {
  storeId: string;
  productId: string;
  destination: DestinationAddress;
  selected: SelectedShipping;
  /** What the customer first typed, when verification changed it. */
  enteredAddress?: DestinationAddress | null;
  /** verified | unverified | not_checked. */
  addressVerification?: string | null;
}): Record<string, string> {
  return {
    storeId: params.storeId,
    productId: params.productId,
    shippingAddress: JSON.stringify({
      name: params.destination.name ?? null,
      line1: params.destination.line1,
      line2: params.destination.line2 ?? null,
      city: params.destination.city,
      state: params.destination.state ?? null,
      postalCode: params.destination.postalCode,
      country: params.destination.country,
    }).slice(0, 500),
    // BOTH ADDRESSES SURVIVE THE TRIP. `shippingAddress` above is the one being
    // shipped to; this is what the customer typed before it was standardised,
    // and is absent when nothing was changed.
    ...(params.enteredAddress
      ? { shippingAddressEntered: JSON.stringify(params.enteredAddress).slice(0, 500) }
      : {}),
    ...(params.addressVerification
      ? { shippingAddressVerification: params.addressVerification.slice(0, 40) }
      : {}),
    shippingRateId: params.selected.rateId,
    shippingCarrier: params.selected.carrier,
    shippingService: params.selected.service,
    shippingAmountInCents: String(params.selected.amountInCents),
    ...(params.selected.estimatedDays !== null
      ? { shippingEstDays: String(params.selected.estimatedDays) }
      : {}),
  };
}

export interface ParsedCheckoutShipping {
  /** The address being shipped to. */
  address: DestinationAddress | null;
  /** What the customer typed, when verification changed it. Null when unchanged. */
  enteredAddress: DestinationAddress | null;
  /** verified | unverified | not_checked. */
  addressVerification: "verified" | "unverified" | "not_checked" | null;
  carrier: string | null;
  service: string | null;
  rateId: string | null;
  amountInCents: number | null;
  estimatedDays: number | null;
}

/**
 * Read shipping back off a completed Checkout Session — pure.
 *
 * Everything is optional because most sessions have none of it: a store without
 * live shipping checks out exactly as before and produces no such metadata. A
 * malformed value becomes null rather than a guess, and no field is ever
 * inferred from another.
 */
export function parseCheckoutShipping(metadata: Record<string, string> | null | undefined): ParsedCheckoutShipping {
  const empty: ParsedCheckoutShipping = {
    address: null,
    enteredAddress: null,
    addressVerification: null,
    carrier: null,
    service: null,
    rateId: null,
    amountInCents: null,
    estimatedDays: null,
  };
  if (!metadata) return empty;

  let address: DestinationAddress | null = null;
  if (metadata.shippingAddress) {
    try {
      const raw = JSON.parse(metadata.shippingAddress) as Partial<DestinationAddress>;
      // An address missing the parts a carrier needs is not half an address, it
      // is no address.
      if (raw?.line1 && raw?.city && raw?.postalCode && raw?.country) {
        address = {
          name: raw.name ?? null,
          line1: raw.line1,
          line2: raw.line2 ?? null,
          city: raw.city,
          state: raw.state ?? null,
          postalCode: raw.postalCode,
          country: raw.country,
        };
      }
    } catch {
      address = null;
    }
  }

  // What the customer originally typed, present only when accepting a
  // suggestion changed it. Malformed becomes null: losing the audit copy must
  // never cost the address actually being shipped to.
  let enteredAddress: DestinationAddress | null = null;
  if (metadata.shippingAddressEntered) {
    try {
      const raw = JSON.parse(metadata.shippingAddressEntered) as Partial<DestinationAddress>;
      if (raw?.line1 && raw?.city && raw?.postalCode && raw?.country) {
        enteredAddress = {
          name: raw.name ?? null,
          line1: raw.line1,
          line2: raw.line2 ?? null,
          city: raw.city,
          state: raw.state ?? null,
          postalCode: raw.postalCode,
          country: raw.country,
        };
      }
    } catch {
      enteredAddress = null;
    }
  }

  // Only the three states the verifier can produce. Anything else is metadata
  // this code did not write, and is discarded rather than stored as a fact.
  const rawState = metadata.shippingAddressVerification;
  const addressVerification =
    rawState === "verified" || rawState === "unverified" || rawState === "not_checked"
      ? rawState
      : null;

  const amount = Number.parseInt(metadata.shippingAmountInCents ?? "", 10);
  const days = Number.parseInt(metadata.shippingEstDays ?? "", 10);

  return {
    address,
    enteredAddress,
    addressVerification,
    carrier: metadata.shippingCarrier || null,
    service: metadata.shippingService || null,
    rateId: metadata.shippingRateId || null,
    amountInCents: Number.isFinite(amount) && amount >= 0 ? amount : null,
    estimatedDays: Number.isFinite(days) && days > 0 ? days : null,
  };
}
