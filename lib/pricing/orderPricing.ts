// WHAT AN ORDER COSTS. ONE FUNCTION, AND UNTIL NOW THERE WAS NONE.
//
// Before this file the merchandise subtotal did not exist as a value anywhere
// in Genesis. It *was* `product.priceInCents`, read raw from Prisma and handed
// to a payment provider at exactly two call sites, in two different shapes:
//
//   Stripe   unit_amount: product.priceInCents        (Stripe then adds
//            + a separate shipping_rate_data line      shipping and returns
//                                                      amount_total)
//   PayPal   value: (product.priceInCents / 100).toFixed(2)
//            (and no shipping at all)
//
// So there was no place a discount could be applied that both rails would
// honour, and no expression anywhere that a test could pin down as "the total".
//
// This is that missing place. PURE — no database, no provider, no clock. It is
// handed what has already been resolved and returns the breakdown; every rail,
// every review screen and every stored order reads its numbers from here.
//
// ============================ MANY LINES (2026-08-26) ======================
//
// A shopping bag holds several products, so this prices LINES. The single-
// product shape it started with is kept exactly — `unitPriceInCents` still
// works and still produces byte-identical output — because 150 assertions
// depend on it and, more importantly, because a one-line bag genuinely IS the
// old checkout. If those two ever disagree, this file is wrong.
//
// TWO KINDS OF DISCOUNT, AND THEY COMPETE RATHER THAN COMPOUND:
//
//   LINE candidates are sales. A store-wide sale covers every line; a selective
//   sale covers the lines it names. Each line takes its own best one.
//
//   ORDER candidates are codes. A code is entered once and applies to the whole
//   merchandise subtotal.
//
// The sum of the line discounts is compared against the best order discount and
// the larger wins outright. Two well-meant 20% offers still give away 20%, not
// 36%, and a code never stacks on top of a sale.
//
// TWO RULES REMAIN STRUCTURAL RATHER THAN CHECKED ELSEWHERE:
//
//   Shipping is never discounted. It passes through untouched and is added
//   after the discount, so no percentage can ever reach it.
//
//   A discount can never exceed what is being discounted. Both the charged
//   subtotal and the RECORDED discount are clamped, per line and in total, so
//   an order can neither go negative nor record having taken more off than the
//   goods cost.

/** Percentage off, or a flat sum off. What every promotion is one of. */
export type DiscountType = "PERCENTAGE" | "FIXED_AMOUNT";

/**
 * Where a discount came from.
 *
 * SALE is the merchant's standing offer and applies by itself; CODE is a
 * customer typing something in. Kept apart because they are answerable to
 * different questions later — "was this on sale" and "did that campaign get
 * used" are not the same report.
 */
export type DiscountKind = "SALE" | "CODE";

/**
 * A discount that has ALREADY been established as applicable.
 *
 * Eligibility — active, in date, in scope, this store — is settled before
 * anything reaches this file. What arrives here is a shortlist of offers that
 * genuinely apply; this function's only remaining job is arithmetic and
 * choosing between them.
 */
export interface DiscountCandidate {
  kind: DiscountKind;
  promotionId: string;
  /** What the customer is shown: the sale's name, or the code as typed. */
  label: string;
  /** Present for a CODE, null for a SALE. Recorded on the order verbatim. */
  code: string | null;
  discountType: DiscountType;
  /** 1-100 for PERCENTAGE, else null. */
  percentOff: number | null;
  /** Cents for FIXED_AMOUNT, else null. */
  amountOffInCents: number | null;
}

/** The discount that actually won, and what it took off. */
export interface AppliedDiscount {
  kind: DiscountKind;
  promotionId: string;
  label: string;
  code: string | null;
  /** Always >= 0 and never more than what it was applied to. */
  amountInCents: number;
}

/** One product in the bag, as the caller describes it. */
export interface PriceOrderLineInput {
  /** Absent only in the single-product shape, which has no bag to identify. */
  productId?: string;
  unitPriceInCents: number;
  quantity?: number;
  /** Sales that apply to THIS product. Empty for a product not on sale. */
  candidates?: DiscountCandidate[];
}

/** One product in the bag, priced. */
export interface PricedLine {
  productId: string | null;
  unitPriceInCents: number;
  quantity: number;
  /** unit x quantity, before anything is taken off. */
  listInCents: number;
  /** What came off THIS line. Never more than listInCents. */
  discountInCents: number;
  /** listInCents - discountInCents. Never negative. */
  subtotalInCents: number;
  /**
   * Which promotion discounted this line.
   *
   * Present for a line's own sale AND for a line's share of an order-level
   * code, so an OrderItem can always say why it cost what it cost.
   */
  discount: AppliedDiscount | null;
}

export interface OrderPricing {
  /** Every product, priced. One entry in the single-product shape. */
  lines: PricedLine[];
  /** Merchandise at list price, before anything is taken off. */
  listSubtotalInCents: number;
  /** Everything taken off, however many promotions contributed. */
  discountInCents: number;
  /**
   * The single promotion responsible for the whole discount.
   *
   * Populated whenever exactly one promotion accounts for it — which is every
   * code, every store-wide sale, and every single-product order. NULL when
   * several different sales discounted different lines, because naming one of
   * them would be picking a winner that does not exist; `appliedPromotionIds`
   * carries all of them and each line carries its own.
   */
  discount: AppliedDiscount | null;
  /** Every promotion that contributed, so a mixed bag still attributes. */
  appliedPromotionIds: string[];
  /** What the goods are actually charged at. Never negative. */
  merchandiseSubtotalInCents: number;
  /** Untouched by any discount, by design. */
  shippingInCents: number;
  /** What the customer pays. */
  totalInCents: number;
}

export interface PriceOrderInput {
  /**
   * THE SINGLE-PRODUCT SHAPE, unchanged and still supported.
   *
   * Kept rather than migrated because a one-line bag is not "a special case of
   * the bag" — it is the checkout that has been taking real money since before
   * bags existed, and its behaviour must not shift by a cent. When this is
   * given, `candidates` below are that line's candidates.
   */
  unitPriceInCents?: number;
  /**
   * One today in the single-product shape — the checkout sold a single product
   * and Order.quantity defaults to 1.
   */
  quantity?: number;
  /** Line-level candidates in the single-product shape. */
  candidates?: DiscountCandidate[];

  /** THE BAG. Every product and its own applicable sales. */
  lines?: PriceOrderLineInput[];
  /** Codes, which apply to the whole order rather than to any one line. */
  orderCandidates?: DiscountCandidate[];

  /** What the customer chose to pay for delivery, or 0. */
  shippingInCents?: number;
}

/**
 * What one candidate would take off a given subtotal.
 *
 * CLAMPED AT BOTH ENDS. A 120%-off promotion or a $50 code on a $20 product
 * takes off exactly the subtotal and no more — which is what makes a negative
 * total structurally impossible rather than something a later check has to
 * catch. A malformed candidate (a PERCENTAGE with no percentage) takes off
 * nothing, because the safe reading of "we do not know this discount" is that
 * the customer pays the normal price, not that they pay nothing.
 */
export function discountAmountFor(candidate: DiscountCandidate, subtotalInCents: number): number {
  if (subtotalInCents <= 0) return 0;

  let raw: number;
  if (candidate.discountType === "PERCENTAGE") {
    const percent = candidate.percentOff;
    if (percent === null || !Number.isFinite(percent) || percent <= 0) return 0;
    // Rounded, not floored: a 15% discount on $24.99 is $3.75, and the half
    // cent belongs to whichever side rounding sends it — consistently, so the
    // review screen and the charge cannot disagree by a cent.
    raw = Math.round((subtotalInCents * percent) / 100);
  } else {
    const amount = candidate.amountOffInCents;
    if (amount === null || !Number.isFinite(amount) || amount <= 0) return 0;
    raw = Math.round(amount);
  }

  return Math.min(Math.max(raw, 0), subtotalInCents);
}

/**
 * The best candidate for one amount, or null when none is worth anything.
 *
 * BEST SINGLE WINS, and a tie goes to the standing SALE so the outcome is
 * deterministic rather than dependent on the order of a query. A candidate
 * worth nothing is not "applied": recording a $0.00 discount on an order would
 * make a promotion look used when it changed no money.
 */
function bestOf(candidates: DiscountCandidate[], subtotalInCents: number): AppliedDiscount | null {
  let best: AppliedDiscount | null = null;
  for (const candidate of candidates) {
    const amountInCents = discountAmountFor(candidate, subtotalInCents);
    if (amountInCents <= 0) continue;
    if (
      best === null ||
      amountInCents > best.amountInCents ||
      (amountInCents === best.amountInCents && candidate.kind === "SALE" && best.kind !== "SALE")
    ) {
      best = {
        kind: candidate.kind,
        promotionId: candidate.promotionId,
        label: candidate.label,
        code: candidate.code,
        amountInCents,
      };
    }
  }
  return best;
}

/**
 * Split one amount across weighted parts so the parts sum to it EXACTLY.
 *
 * An order-level code has to be recorded per line, because an OrderItem that
 * cannot say what it cost is not a record of anything. Proportional rounding
 * loses or gains cents — three lines splitting a 10c discount by thirds gives
 * 3+3+3 — so the remainder is handed to the largest line rather than dropped.
 * Without this the line subtotals would not add up to the charge, and the
 * discrepancy would appear in a real customer's receipt.
 */
export function distributeProportionally(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);

  // CAPPED FIRST, and this is what makes the function terminate at all. An
  // earlier version handed out the remainder in repeated passes, refusing to
  // push any line past its own value — which spins forever the moment `total`
  // exceeds `sum`, because there is nowhere left to put the leftover. Caught by
  // this file's own "no line is discounted past its own value" assertion, which
  // hung rather than failed.
  //
  // priceOrder already clamps a discount to the subtotal before calling this,
  // so total > sum cannot arise there. A shared helper still has to be honest
  // about it rather than relying on its only caller staying careful.
  const capped = Math.min(total, sum);

  const shares = weights.map((w) => Math.floor((capped * w) / sum));
  let remainder = capped - shares.reduce((a, b) => a + b, 0);

  // Flooring loses at most one cent per line, so a single pass always settles
  // it — and every line provably has room, because floor(capped * w / sum) is
  // strictly below w whenever capped is below sum, and exactly w when it is not.
  //
  // Largest weight first, so the leftover cents land where they are least
  // visible as a proportion of the line.
  const order = weights.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w);
  for (const { i } of order) {
    if (remainder <= 0) break;
    if (shares[i] < weights[i]) {
      shares[i] += 1;
      remainder -= 1;
    }
  }
  return shares;
}

/**
 * THE ORDER'S PRICE. Every rail and every screen reads its numbers from here.
 */
export function priceOrder(input: PriceOrderInput): OrderPricing {
  // ONE NORMALISATION, so there is a single code path below rather than a bag
  // path and a legacy path that can drift apart.
  const inputLines: PriceOrderLineInput[] =
    input.lines ??
    (input.unitPriceInCents !== undefined
      ? [{ unitPriceInCents: input.unitPriceInCents, quantity: input.quantity, candidates: input.candidates }]
      : []);

  const lines = inputLines.map((line) => {
    const quantity = Math.max(1, Math.floor(line.quantity ?? 1));
    const unitPriceInCents = Math.max(0, Math.round(line.unitPriceInCents));
    return {
      productId: line.productId ?? null,
      unitPriceInCents,
      quantity,
      listInCents: unitPriceInCents * quantity,
      candidates: line.candidates ?? [],
    };
  });

  const listSubtotalInCents = lines.reduce((sum, l) => sum + l.listInCents, 0);
  const shippingInCents = Math.max(0, Math.round(input.shippingInCents ?? 0));

  // --- what the sales would take off, line by line -------------------------
  const lineWinners = lines.map((l) => bestOf(l.candidates, l.listInCents));
  const salesTotal = lineWinners.reduce((sum, d) => sum + (d?.amountInCents ?? 0), 0);

  // --- what the best code would take off the whole order -------------------
  const codeWinner = bestOf(input.orderCandidates ?? [], listSubtotalInCents);
  const codeTotal = codeWinner?.amountInCents ?? 0;

  // THEY COMPETE. A tie goes to the sales, matching bestOf's own tie-break:
  // the standing offer is what the merchant already committed to.
  const codeWins = codeTotal > salesTotal;

  let pricedLines: PricedLine[];
  let discountInCents: number;

  if (codeWins && codeWinner) {
    // The code replaces every line discount outright — it does not add to them.
    const shares = distributeProportionally(codeTotal, lines.map((l) => l.listInCents));
    pricedLines = lines.map((l, i) => ({
      productId: l.productId,
      unitPriceInCents: l.unitPriceInCents,
      quantity: l.quantity,
      listInCents: l.listInCents,
      discountInCents: shares[i],
      subtotalInCents: l.listInCents - shares[i],
      // The same code named on every line it touched, with that line's share.
      discount: shares[i] > 0 ? { ...codeWinner, amountInCents: shares[i] } : null,
    }));
    discountInCents = codeTotal;
  } else {
    pricedLines = lines.map((l, i) => {
      const won = lineWinners[i];
      const amount = won?.amountInCents ?? 0;
      return {
        productId: l.productId,
        unitPriceInCents: l.unitPriceInCents,
        quantity: l.quantity,
        listInCents: l.listInCents,
        discountInCents: amount,
        subtotalInCents: l.listInCents - amount,
        discount: won,
      };
    });
    discountInCents = salesTotal;
  }

  // Every promotion that actually moved money, deduplicated and in line order.
  const appliedPromotionIds = [
    ...new Set(pricedLines.filter((l) => l.discount).map((l) => l.discount!.promotionId)),
  ];

  // ONE PROMOTION OR NONE. Naming one of several would be picking a winner that
  // does not exist — every line still carries its own, and appliedPromotionIds
  // carries all of them.
  const singlePromotion = appliedPromotionIds.length === 1;
  const representative = pricedLines.find((l) => l.discount)?.discount ?? null;
  const discount: AppliedDiscount | null =
    singlePromotion && representative && discountInCents > 0
      ? { ...representative, amountInCents: discountInCents }
      : null;

  const merchandiseSubtotalInCents = Math.max(0, listSubtotalInCents - discountInCents);

  return {
    lines: pricedLines,
    listSubtotalInCents,
    discountInCents,
    discount,
    appliedPromotionIds,
    merchandiseSubtotalInCents,
    // Added AFTER the discount, and never part of what a percentage is taken
    // from. This is the only reason "discounts do not apply to shipping" needs
    // no enforcement anywhere else.
    shippingInCents,
    totalInCents: merchandiseSubtotalInCents + shippingInCents,
  };
}
