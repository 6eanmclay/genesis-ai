import EasyPost from "@easypost/api";
import { chooseRate, humanService, type EasyPostRateLike, type SelectedService } from "./rates";
import type { OrderShippingAddress } from "@/lib/orders/shippingAddress";

// Buying a real shipping label — the carrier interaction, and only that.
//
// Split out of lib/execution/executables/shipping.ts (2026-08-20) for the same
// reason lib/orders/orderConfirmation.ts takes an injectable sender: the carrier
// round trip is the ONE part of this path that genuinely cannot be proven
// without an external credential, and everything around it — which rate gets
// bought, what is recorded, what the owner is told, what happens when the
// purchase fails — can be. Keeping them in one function meant none of it was.
//
// The default buyer below IS the production path, moved verbatim apart from the
// rate choice. Nothing here is a test double; the seam exists so the parts that
// are provable can be proven.

export interface StoreOriginAddress {
  name: string;
  phone?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  state?: string | null;
  postalCode: string;
  country: string;
}

export interface LabelRequest {
  to: OrderShippingAddress;
  from: StoreOriginAddress;
  parcel: { weightOz: number; lengthIn?: number; widthIn?: number; heightIn?: number };
  /** What the customer chose and paid for at checkout, when they chose one. */
  selected: SelectedService;
}

export interface PurchasedLabel {
  carrier: string;
  service: string | null;
  trackingNumber: string;
  trackingUrl: string | null;
  labelUrl: string | null;
  /** What the LABEL cost the owner. Never what the customer was charged. */
  costInCents: number;
  /** True when this is the service the customer actually paid for. */
  matchedSelection: boolean;
}

export type LabelBuyer = (apiKey: string, request: LabelRequest) => Promise<PurchasedLabel>;

/**
 * A carrier could not sell the service this order was paid for.
 *
 * Its own class so the caller can tell it apart from a network failure: this one
 * is the owner's to resolve and must be said in their language, not retried.
 */
export class ServiceUnavailableError extends Error {}

/**
 * Pick the rate to buy, or refuse — shared by the real buyer and by anything
 * else that has rates in hand.
 *
 * Exported because the REFUSAL is the interesting half and it must not live
 * only inside the one function that needs an EasyPost credential to reach.
 * Substituting a slower service for one the customer paid for is the defect
 * this whole path exists to stop; a refusal that nobody can test is not a fix.
 */
export function selectRateForLabel<T extends EasyPostRateLike>(
  rates: T[],
  selected: SelectedService,
  messages?: { message?: string }[]
): T {
  const choice = chooseRate(rates, selected);
  if (choice.ok) return choice.rate;

  if (choice.reason === "selection_unavailable") {
    // Named in the owner's terms, because they are the only person who can do
    // anything about it — and never silently downgraded, which is the whole
    // point of refusing here.
    throw new ServiceUnavailableError(
      `This customer paid for ${choice.wanted}, and the carrier isn't offering it for this parcel right now. ` +
        `What is available: ${choice.offered.join(", ")}. Buying something slower would break the delivery they paid for, so nothing was bought.`
    );
  }

  throw new Error(
    messages?.length
      ? `No carrier could rate this shipment: ${messages.map((m) => m.message).filter(Boolean).join("; ")}`
      : "No carrier returned a rate for this shipment — check the addresses and package weight"
  );
}

export const buyLabelViaEasyPost: LabelBuyer = async (apiKey, request) => {
  const client = new EasyPost(apiKey);

  const shipment = await client.Shipment.create({
    to_address: {
      name: request.to.name ?? undefined,
      street1: request.to.line1,
      street2: request.to.line2 ?? undefined,
      city: request.to.city,
      state: request.to.state ?? undefined,
      zip: request.to.postalCode,
      country: request.to.country,
    },
    from_address: {
      name: request.from.name,
      phone: request.from.phone ?? undefined,
      street1: request.from.line1,
      street2: request.from.line2 ?? undefined,
      city: request.from.city,
      state: request.from.state ?? undefined,
      zip: request.from.postalCode,
      country: request.from.country,
    },
    parcel: {
      weight: request.parcel.weightOz,
      length: request.parcel.lengthIn,
      width: request.parcel.widthIn,
      height: request.parcel.heightIn,
    },
  });

  const rate = selectRateForLabel(shipment.rates ?? [], request.selected, shipment.messages);

  const bought = await client.Shipment.buy(shipment.id, rate);

  // What was actually charged, preferring the bought shipment's own selected
  // rate over the one we asked for. They are normally identical; when they are
  // not, the carrier's answer is the true one and the owner's books should say
  // what left their account.
  const chargedRate = bought.selected_rate?.rate ?? rate.rate ?? "0";
  const parsed = Number.parseFloat(String(chargedRate));

  return {
    // A CARRIER IS NEVER ASSUMED. This defaulted to "USPS", which meant a
    // parcel carried by anyone else was labelled wrongly on the owner's own
    // order screen — and the tracking link beside it went to the wrong
    // carrier's site. "Unknown" is the honest answer when the broker did not
    // say, and it is one nobody misreads as a fact.
    carrier: bought.selected_rate?.carrier ?? rate.carrier ?? "Unknown carrier",
    service: bought.selected_rate?.service
      ? humanService(String(bought.selected_rate.service))
      : rate.service
        ? humanService(rate.service)
        : null,
    trackingNumber: bought.tracking_code,
    trackingUrl: bought.tracker?.public_url ?? null,
    labelUrl: bought.postage_label?.label_url ?? null,
    costInCents: Number.isFinite(parsed) ? Math.round(parsed * 100) : 0,
    matchedSelection: Boolean(request.selected.carrier && request.selected.service),
  };
};
