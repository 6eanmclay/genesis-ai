// Implementation roadmap Milestone 1 — one common shape for a shipping
// address regardless of which payment provider collected it, so the
// owner-facing order view (Milestone 4) and any future fulfillment routing
// never have to branch on paymentProvider to read it. Stripe and PayPal
// return genuinely different field names/nesting for the same real-world
// data; normalizing happens once, here, at the two real write sites
// (the Stripe webhook, the PayPal capture handler), not downstream.

export interface OrderShippingAddress {
  name: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  country: string;
}

// Stripe's Checkout Session `collected_information.shipping_details` shape
// (present when `shipping_address_collection` was set on session
// creation) — verified against the installed Stripe SDK's own types
// before writing this, not assumed from an older API version's shape.
export function fromStripeShippingDetails(
  shippingDetails:
    | {
        name?: string | null;
        address?: {
          line1?: string | null;
          line2?: string | null;
          city?: string | null;
          state?: string | null;
          postal_code?: string | null;
          country?: string | null;
        } | null;
      }
    | null
    | undefined
): OrderShippingAddress | null {
  const address = shippingDetails?.address;
  if (!address?.line1 || !address.city || !address.postal_code || !address.country) return null;
  return {
    name: shippingDetails?.name ?? null,
    line1: address.line1,
    line2: address.line2 ?? null,
    city: address.city,
    state: address.state ?? null,
    postalCode: address.postal_code,
    country: address.country,
  };
}

// PayPal Orders API v2's `purchase_units[].shipping` shape (present when
// `shipping_preference: "GET_FROM_FILE"` was set on order creation).
export function fromPaypalShipping(
  shipping:
    | {
        name?: { full_name?: string | null } | null;
        address?: {
          address_line_1?: string | null;
          address_line_2?: string | null;
          admin_area_2?: string | null; // city
          admin_area_1?: string | null; // state/province
          postal_code?: string | null;
          country_code?: string | null;
        } | null;
      }
    | null
    | undefined
): OrderShippingAddress | null {
  const address = shipping?.address;
  if (!address?.address_line_1 || !address.admin_area_2 || !address.postal_code || !address.country_code) return null;
  return {
    name: shipping?.name?.full_name ?? null,
    line1: address.address_line_1,
    line2: address.address_line_2 ?? null,
    city: address.admin_area_2,
    state: address.admin_area_1 ?? null,
    postalCode: address.postal_code,
    country: address.country_code,
  };
}
