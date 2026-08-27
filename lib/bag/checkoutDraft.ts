import { prisma } from "@/lib/prisma";
import type { IntegrationProvider } from "@prisma/client";
import type { OrderPricing } from "@/lib/pricing/orderPricing";
import type { ResolvedBagLine } from "./resolveBag";

// THE CONTRACT, WRITTEN DOWN ONCE.
//
// A draft is created at exactly one moment — the customer clicking Continue to
// payment — and never edited afterwards. Browsing, adding, removing and
// changing quantities all happen in a cookie and touch no database at all.
//
// WHY IT EXISTS: neither provider can carry a bag back to us. PayPal gives us
// one 127-character custom_id, of which storeId and productId alone already
// spend 51. Both rails carry this row's id instead, which also makes them
// identical — the same fix that made pricing one function rather than two.
//
// WHY IT IS FROZEN: this is what the customer agreed to and what the provider
// charged. A merchant editing a price, or a promotion expiring, while somebody
// is on PayPal must not change what the order records — the money has already
// moved at the figure kept here.

/**
 * 48 hours: comfortably past Stripe's 24-hour session and PayPal's ~3-hour
 * order, so a draft can never expire under a customer who is still deciding.
 */
export const DRAFT_TTL_HOURS = 48;

/** One line of the bag, frozen. The shape stored in CheckoutDraft.lines. */
export interface DraftLine {
  /** Null only if the caller had none; a deleted product keeps its id here. */
  productId: string | null;
  /**
   * CAPTURED, not read back through a relation. A product deleted between here
   * and the webhook must not take the record of what somebody bought with it.
   */
  productName: string;
  quantity: number;
  unitPriceInCents: number;
  listInCents: number;
  discountInCents: number;
  subtotalInCents: number;
  promotionId: string | null;
  promotionLabel: string | null;
}

/**
 * The bag's lines and its pricing, married into what gets stored.
 *
 * PURE, so the freezing itself is provable without a database — and so the
 * arithmetic the CHECK constraints enforce can be asserted before Postgres
 * ever sees it.
 *
 * The two arrays are matched BY POSITION, which is safe because priceOrder
 * returns its lines in the order it was given them. Asserted rather than
 * trusted: a mismatch here would put one product's name against another's
 * price on a real receipt.
 */
export function freezeLines(lines: ResolvedBagLine[], pricing: OrderPricing): DraftLine[] {
  if (lines.length !== pricing.lines.length) {
    throw new Error(
      `Bag and pricing disagree about how many lines there are (${lines.length} vs ${pricing.lines.length})`
    );
  }
  return lines.map((line, i) => {
    const priced = pricing.lines[i];
    if (priced.productId !== null && priced.productId !== line.productId) {
      throw new Error("Bag and pricing lines are not in the same order");
    }
    return {
      productId: line.productId,
      productName: line.name,
      quantity: priced.quantity,
      unitPriceInCents: priced.unitPriceInCents,
      listInCents: priced.listInCents,
      discountInCents: priced.discountInCents,
      subtotalInCents: priced.subtotalInCents,
      promotionId: priced.discount?.promotionId ?? null,
      promotionLabel: priced.discount?.label ?? null,
    };
  });
}

export interface CreateDraftParams {
  storeId: string;
  lines: ResolvedBagLine[];
  pricing: OrderPricing;
  shipping?: {
    address: unknown;
    carrier: string | null;
    service: string | null;
    rateId: string | null;
  } | null;
  now?: Date;
}

/**
 * Freeze this bag as a contract and return its id.
 *
 * A NEW ROW EVERY TIME. A customer who goes back and tries again gets a fresh
 * draft rather than an edited one — editing in place would race a provider
 * already reading it, and the earlier row simply expires.
 */
export async function createCheckoutDraft(params: CreateDraftParams): Promise<string> {
  const now = params.now ?? new Date();
  const lines = freezeLines(params.lines, params.pricing);
  const pricing = params.pricing;

  const draft = await prisma.checkoutDraft.create({
    data: {
      storeId: params.storeId,
      status: "OPEN",
      lines: lines as unknown as object,
      listSubtotalInCents: pricing.listSubtotalInCents,
      discountInCents: pricing.discountInCents,
      shippingInCents: pricing.shippingInCents,
      totalInCents: pricing.totalInCents,
      // Only when ONE promotion accounts for the whole discount. Several sales
      // across different lines leave this null on purpose; each line above
      // carries its own.
      appliedPromotionId: pricing.discount?.promotionId ?? null,
      appliedPromotionLabel: pricing.discount?.label ?? null,
      appliedPromotionCode: pricing.discount?.code ?? null,
      appliedPromotionKind: pricing.discount?.kind ?? null,
      shippingAddress: (params.shipping?.address as object | null) ?? undefined,
      selectedShippingCarrier: params.shipping?.carrier ?? null,
      selectedShippingService: params.shipping?.service ?? null,
      selectedShippingRateId: params.shipping?.rateId ?? null,
      expiresAt: new Date(now.getTime() + DRAFT_TTL_HOURS * 60 * 60 * 1000),
    },
    select: { id: true },
  });
  return draft.id;
}

/**
 * Record which rail this draft went to, and stop treating it as editable.
 *
 * From here the row is evidence: a draft that reached this state and never
 * converted is the only trace that somebody tried to buy something.
 */
export async function markPaymentStarted(params: {
  storeId: string;
  draftId: string;
  provider: IntegrationProvider;
  externalSessionId: string;
}): Promise<void> {
  // Store-scoped, and only from OPEN — so a redelivered redirect cannot drag a
  // converted draft backwards into an unpaid state.
  await prisma.checkoutDraft.updateMany({
    where: { id: params.draftId, storeId: params.storeId, status: "OPEN" },
    data: {
      status: "PAYMENT_STARTED",
      paymentProvider: params.provider,
      externalSessionId: params.externalSessionId,
    },
  });
}

export interface LoadedDraft {
  id: string;
  status: "OPEN" | "PAYMENT_STARTED" | "CONVERTED" | "ABANDONED";
  lines: DraftLine[];
  listSubtotalInCents: number;
  discountInCents: number;
  shippingInCents: number;
  totalInCents: number;
  appliedPromotionId: string | null;
  appliedPromotionLabel: string | null;
  appliedPromotionCode: string | null;
  appliedPromotionKind: "SALE" | "CODE" | null;
  shippingAddress: unknown;
  selectedShippingCarrier: string | null;
  selectedShippingService: string | null;
  selectedShippingRateId: string | null;
  orderId: string | null;
}

/**
 * A draft, by id, for one store.
 *
 * ALWAYS STORE-SCOPED. A draft id travels in provider metadata and in a URL,
 * and an id is not proof of ownership — the same rule the PayPal custom_id and
 * the promotion lookup already follow. Returns null rather than throwing: the
 * caller is usually a webhook holding real money, and its job is to write an
 * order regardless.
 */
export async function loadDraft(storeId: string, draftId: string | null | undefined): Promise<LoadedDraft | null> {
  if (!draftId) return null;
  const row = await prisma.checkoutDraft.findFirst({
    where: { id: draftId, storeId },
  });
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    lines: (row.lines as unknown as DraftLine[]) ?? [],
    listSubtotalInCents: row.listSubtotalInCents,
    discountInCents: row.discountInCents,
    shippingInCents: row.shippingInCents,
    totalInCents: row.totalInCents,
    appliedPromotionId: row.appliedPromotionId,
    appliedPromotionLabel: row.appliedPromotionLabel,
    appliedPromotionCode: row.appliedPromotionCode,
    appliedPromotionKind: row.appliedPromotionKind,
    shippingAddress: row.shippingAddress,
    selectedShippingCarrier: row.selectedShippingCarrier,
    selectedShippingService: row.selectedShippingService,
    selectedShippingRateId: row.selectedShippingRateId,
    orderId: row.orderId,
  };
}

/**
 * Does what the provider settled match what this draft promised?
 *
 * PURE, and it does not "reconcile" anything. A mismatch is recorded so it can
 * be found; silently trusting either number is how a wrong charge becomes
 * invisible. Null when the provider did not tell us, which is not a mismatch.
 */
export function draftTotalMismatch(
  draftTotalInCents: number,
  settledTotalInCents: number | null | undefined
): { draft: number; settled: number } | null {
  if (typeof settledTotalInCents !== "number" || !Number.isFinite(settledTotalInCents)) return null;
  if (settledTotalInCents === draftTotalInCents) return null;
  return { draft: draftTotalInCents, settled: settledTotalInCents };
}
