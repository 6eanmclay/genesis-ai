// THE PACKAGED WEIGHT OF A PRODUCT, IN THE ONE UNIT THE SYSTEM STORES.
//
// `Product.weightOz` has existed since 2026-08-20 and nothing has ever written
// it. Checkout rating reads it, the label form reads it, and every one of the
// 55 products in production has it null — so `productSupportsLiveShipping`
// returns false everywhere, the shipping step is unreachable for every store,
// and not one of the five real orders carries a shipping charge. A whole
// working subsystem is dark because one field had no way in.
//
// This is the way in. No new column, no packaging profiles: the merchant types
// pounds and ounces, and ounces is what is stored.
//
// WHY POUNDS AND OUNCES AT ALL. Ounces alone is the honest storage unit and a
// hostile input unit — a merchant weighing a boxed tensor ring on a kitchen
// scale reads "1 lb 4 oz", and asking them to submit 20 invites the arithmetic
// slip that becomes a wrong postage charge on a real customer's order.
//
// AND IT IS THE PACKAGED WEIGHT, NOT THE PRODUCT'S. What the carrier prices is
// the parcel: product, box, filler and tape. A merchant who enters the bare
// product weight under-quotes every order they ship, and eats the difference
// silently. The field says so wherever it is shown.

/** Ounces in a pound. Named rather than inlined, because 16 is not self-evident. */
export const OUNCES_PER_POUND = 16;

export type WeightParseResult =
  | { ok: true; weightOz: number }
  | { ok: false; error: string };

/**
 * Pounds and ounces as the merchant typed them, to the stored unit.
 *
 * Both parts optional so "12 oz" and "3 lb" are each a complete answer — a
 * merchant should never have to type a zero to say a parcel weighs under a
 * pound.
 */
export function parsePackagedWeight(
  poundsInput: string | null | undefined,
  ouncesInput: string | null | undefined
): WeightParseResult {
  const rawPounds = (poundsInput ?? "").trim();
  const rawOunces = (ouncesInput ?? "").trim();

  // BOTH BLANK IS A REAL ANSWER, not an error: it clears the weight, and a
  // product with no weight is simply one Genesis will not quote shipping for.
  // Refusing to let a merchant undo a mistake would be worse than the mistake.
  if (rawPounds === "" && rawOunces === "") return { ok: true, weightOz: 0 };

  const pounds = rawPounds === "" ? 0 : Number(rawPounds);
  const ounces = rawOunces === "" ? 0 : Number(rawOunces);

  if (!Number.isFinite(pounds) || !Number.isFinite(ounces)) {
    return { ok: false, error: "Enter the shipping weight as numbers." };
  }
  if (pounds < 0 || ounces < 0) {
    return { ok: false, error: "A shipping weight can't be negative." };
  }

  const weightOz = pounds * OUNCES_PER_POUND + ounces;

  if (weightOz === 0) {
    // Explicit zeros, unlike blanks, are somebody asserting a parcel weighs
    // nothing — which no carrier will price.
    return { ok: false, error: "A shipping weight of zero can't be used to get a rate." };
  }
  // 70 lb is the USPS domestic ceiling for every service. Beyond it no rate
  // comes back, so catching it here explains the problem where it was entered
  // rather than at checkout, in front of a customer.
  if (weightOz > 70 * OUNCES_PER_POUND) {
    return { ok: false, error: "That is over the 70 lb limit for domestic shipping." };
  }

  return { ok: true, weightOz };
}

/**
 * The stored unit, back to what the merchant typed.
 *
 * Round-trips: a value entered as 1 lb 4 oz is shown as 1 lb 4 oz, not 20 oz
 * and not 1.25 lb.
 */
export function toPoundsAndOunces(weightOz: number | null): { pounds: string; ounces: string } {
  if (weightOz === null || weightOz <= 0) return { pounds: "", ounces: "" };
  const pounds = Math.floor(weightOz / OUNCES_PER_POUND);
  const ounces = weightOz - pounds * OUNCES_PER_POUND;
  return {
    pounds: pounds > 0 ? String(pounds) : "",
    // Fractional ounces survive — a scale reading 4.6 oz is not rounded to 5,
    // because the carrier prices what it weighs.
    ounces: ounces > 0 ? String(Number(ounces.toFixed(2))) : "",
  };
}

/** How a stored weight reads in a sentence. */
export function describePackagedWeight(weightOz: number | null): string | null {
  if (weightOz === null || weightOz <= 0) return null;
  const { pounds, ounces } = toPoundsAndOunces(weightOz);
  if (pounds && ounces) return `${pounds} lb ${ounces} oz`;
  if (pounds) return `${pounds} lb`;
  return `${ounces} oz`;
}
