import { prisma } from "@/lib/prisma";
import type { ProductSourceKind } from "@prisma/client";
import { methodProfile, isOwnerCapability, type OwnerCapability } from "./methodProfile";
import { currentPolicy, rungPolicy, type ProgressionPolicy } from "./progressionPolicy";

// Evidence about a business and its products, and the reading of it.
//
// Three separate things live here and the separation is the architecture:
//
//   capitalPosture()  — what the owner has SAID. Never inferred.
//   productEvidence() — what actually HAPPENED. Contains no thresholds.
//   earnedRungs()     — how policy READS that evidence. The only place
//                       thresholds appear.
//
// Collapsing any two of them is how a tuning change starts rewriting history.

// --- capital ---------------------------------------------------------------

/**
 * What the owner has told Genesis they can invest.
 *
 * THREE STATES, AND THEY MUST NEVER COLLAPSE. Unstated and explicitly-zero
 * behave identically for every decision, and are not the same fact: one is worth
 * asking about and the other has already been answered. Asking somebody who
 * already told you nothing is how a partner starts sounding like a form.
 *
 * Which is why this is a discriminated union rather than a number.
 */
export type CapitalPosture =
  | { state: "unstated"; currency: string; capabilities: OwnerCapability[] }
  | {
      state: "stated";
      currency: string;
      investableCents: number;
      statedAt: Date;
      capabilities: OwnerCapability[];
    };

/**
 * What feasibility is allowed to spend.
 *
 * Identical for `unstated` and a stated zero, deliberately: Genesis behaves
 * conservatively either way. The distinction survives in `state`, not here.
 */
export function spendableCents(posture: CapitalPosture): number {
  return posture.state === "stated" ? posture.investableCents : 0;
}

export async function capitalPosture(storeId: string): Promise<CapitalPosture> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: {
      currency: true,
      investableCapitalCents: true,
      capitalStatedAt: true,
      ownerCapabilities: true,
    },
  });

  const capabilities = store.ownerCapabilities.filter(isOwnerCapability);

  // Both columns are required for a stated posture. A figure with no statedAt is
  // not a statement anybody made, and is treated as unstated rather than
  // believed — the safer of the two readings, and the one that keeps asking.
  if (store.investableCapitalCents === null || store.capitalStatedAt === null) {
    return { state: "unstated", currency: store.currency, capabilities };
  }
  return {
    state: "stated",
    currency: store.currency,
    investableCents: store.investableCapitalCents,
    statedAt: store.capitalStatedAt,
    capabilities,
  };
}

/**
 * Record what the owner said. The ONLY writer of capital posture.
 *
 * Zero is a real answer and is recorded as one, with a timestamp — that is what
 * makes it different from never having been asked.
 */
export async function stateCapital(
  storeId: string,
  investableCents: number,
  capabilities?: OwnerCapability[]
): Promise<void> {
  await prisma.store.updateMany({
    where: { id: storeId },
    data: {
      investableCapitalCents: Math.max(0, Math.round(investableCents)),
      capitalStatedAt: new Date(),
      ...(capabilities ? { ownerCapabilities: capabilities } : {}),
    },
  });
}

// --- evidence --------------------------------------------------------------

/**
 * What actually happened to one product, in this business.
 *
 * Facts only. There is not a threshold in this type or in the function that
 * builds it, and there must never be one: the moment evidence knows what "enough"
 * means, tuning "enough" rewrites the past.
 */
export interface ProductEvidence {
  productId: string;
  /** The business's own currency, carried so no caller has to assume one. */
  currency: string;
  /** SUM of quantity over paid orders. Units, not orders. */
  unitsSold: number;
  refundedUnits: number;
  /** Distinct paid orders. A different question from unitsSold, and kept. */
  orderCount: number;
  firstSoldAt: Date | null;
  /** First sale to now, floored at 1 so a rate is always computable. */
  windowDays: number;
  unitsPerWeek: number;
  netRevenueCents: number;
  /** NULL where the product's cost is unknown. Never zero. */
  netMarginCents: number | null;
  /** Per unit, from known margin. NULL for the same reason. */
  marginPerUnitCents: number | null;
  returnRate: number;
}

const MS_PER_DAY = 86_400_000;

export async function productEvidence(
  storeId: string,
  productId: string
): Promise<ProductEvidence> {
  const [store, product, orders] = await Promise.all([
    prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { currency: true } }),
    prisma.product.findFirst({ where: { id: productId, storeId }, select: { costInCents: true } }),
    prisma.order.findMany({
      where: { storeId, productId },
      select: {
        productId: true,
        quantity: true,
        amountInCents: true,
        status: true,
        createdAt: true,
        shippingCostInCents: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return buildEvidence({
    productId,
    currency: store.currency,
    costInCents: product?.costInCents ?? null,
    orders,
  });
}

interface EvidenceOrder {
  quantity: number;
  amountInCents: number;
  status: string;
  createdAt: Date;
  shippingCostInCents: number | null;
}

/**
 * The arithmetic, in one place — pure.
 *
 * Both the single-product and whole-store readers call this, so the batched
 * version cannot drift from the single one. Two copies of a margin calculation
 * is two chances to get money wrong.
 */
function buildEvidence(input: {
  productId: string;
  currency: string;
  costInCents: number | null;
  orders: EvidenceOrder[];
}): ProductEvidence {
  const { productId, currency, costInCents, orders } = input;
  const paid = orders.filter((order) => order.status === "paid");
  const refunded = orders.filter((order) => order.status === "refunded");

  const unitsSold = paid.reduce((sum, order) => sum + order.quantity, 0);
  const refundedUnits = refunded.reduce((sum, order) => sum + order.quantity, 0);
  const netRevenueCents = paid.reduce((sum, order) => sum + order.amountInCents, 0);
  const shippingSpentCents = paid.reduce((sum, order) => sum + (order.shippingCostInCents ?? 0), 0);

  const firstSoldAt =
    paid.length > 0
      ? paid.reduce((earliest, o) => (o.createdAt < earliest ? o.createdAt : earliest), paid[0].createdAt)
      : null;
  const windowDays = firstSoldAt
    ? Math.max(1, Math.ceil((Date.now() - firstSoldAt.getTime()) / MS_PER_DAY))
    : 0;
  const unitsPerWeek = windowDays > 0 ? unitsSold / (windowDays / 7) : 0;

  // UNKNOWN COST MEANS UNKNOWN MARGIN, not a margin of zero and not a margin
  // equal to revenue. A product nobody recorded a cost for cannot be shown to be
  // profitable, and every threshold that reads margin refuses it rather than
  // treating the absence as good news.
  const netMarginCents =
    costInCents === null ? null : netRevenueCents - costInCents * unitsSold - shippingSpentCents;

  const totalHandled = unitsSold + refundedUnits;

  return {
    productId,
    currency,
    unitsSold,
    refundedUnits,
    orderCount: paid.length,
    firstSoldAt,
    windowDays,
    unitsPerWeek,
    netRevenueCents,
    netMarginCents,
    marginPerUnitCents:
      netMarginCents === null || unitsSold === 0 ? null : Math.round(netMarginCents / unitsSold),
    returnRate: totalHandled === 0 ? 0 : refundedUnits / totalHandled,
  };
}

/**
 * Evidence for every product in a business, in one pass.
 *
 * Replaces a per-product loop (2026-08-20). `businessStage()` and
 * `findGraduationOpportunities()` both walked every product calling
 * `productEvidence()`, which is three queries each — invisible at fifty products
 * and a page nobody can load at five thousand. This is three queries total,
 * whatever the catalogue size.
 *
 * Shares `buildEvidence` with the single-product reader, deliberately: two
 * copies of a margin calculation is two chances to get money wrong.
 */
export async function storeProductEvidence(storeId: string): Promise<Map<string, ProductEvidence>> {
  const [store, products, orders] = await Promise.all([
    prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { currency: true } }),
    prisma.product.findMany({ where: { storeId }, select: { id: true, costInCents: true } }),
    prisma.order.findMany({
      where: { storeId, productId: { not: null } },
      select: {
        productId: true,
        quantity: true,
        amountInCents: true,
        status: true,
        createdAt: true,
        shippingCostInCents: true,
      },
    }),
  ]);

  const byProduct = new Map<string, EvidenceOrder[]>();
  for (const order of orders) {
    if (!order.productId) continue;
    const existing = byProduct.get(order.productId);
    if (existing) existing.push(order);
    else byProduct.set(order.productId, [order]);
  }

  const evidence = new Map<string, ProductEvidence>();
  for (const product of products) {
    evidence.set(
      product.id,
      buildEvidence({
        productId: product.id,
        currency: store.currency,
        costInCents: product.costInCents,
        orders: byProduct.get(product.id) ?? [],
      })
    );
  }
  return evidence;
}

// --- policy applied to evidence --------------------------------------------

/**
 * Which rungs this product's evidence would justify — the ONLY place thresholds
 * are read.
 *
 * Never a promise that anything is affordable. Earning a rung and being able to
 * pay for it are different questions, answered by different functions, and
 * conflating them is how an owner gets told to spend money they do not have.
 */
export function earnedRungs(
  evidence: ProductEvidence,
  policy: ProgressionPolicy = currentPolicy()
): number[] {
  const earned: number[] = [];
  // Ascending, and each rung requires the one below it: a product cannot earn
  // its own factory without first having earned a case.
  for (const rung of [...policy.rungs].sort((a, b) => a.rung - b.rung)) {
    const previousEarned = rung.rung === 1 || earned.includes(rung.rung - 1);
    if (!previousEarned) break;
    const meets =
      evidence.unitsSold >= rung.minUnitsSold &&
      evidence.windowDays >= rung.minWindowDays &&
      evidence.returnRate <= rung.maxReturnRate &&
      // Unknown margin never satisfies a threshold.
      evidence.netMarginCents !== null &&
      evidence.netMarginCents >= rung.minNetMarginCents;
    if (!meets) break;
    earned.push(rung.rung);
  }
  return earned;
}

// --- business stage --------------------------------------------------------

export type BusinessStage = "exploring" | "selling" | "proven" | "committing";

/**
 * Where this business is, derived from evidence and policy every time it is
 * asked.
 *
 * There is no column for this and there must never be one. A stored stage drifts
 * from the evidence the moment either changes, and becomes something to maintain
 * rather than something that is true.
 *
 * Stage says what is on the table. It never decides a specific product — that is
 * the product's own evidence.
 */
export async function businessStage(
  storeId: string,
  policy: ProgressionPolicy = currentPolicy()
): Promise<BusinessStage> {
  const products = await prisma.product.findMany({
    where: { storeId },
    select: { id: true, sourceKind: true },
  });

  // Already sourcing above rung 0 — the business has committed to something,
  // whatever its sales look like today.
  if (products.some((product) => methodProfile(product.sourceKind).rung >= 1)) {
    return "committing";
  }

  const paidOrders = await prisma.order.count({ where: { storeId, status: "paid" } });
  if (paidOrders === 0) return "exploring";

  // ONE pass over the whole catalogue (2026-08-20). This walked every product
  // issuing three queries each; at fifty products that is invisible and at five
  // thousand it is a page nobody can load.
  const evidence = await storeProductEvidence(storeId);
  for (const productEvidenceEntry of evidence.values()) {
    if (earnedRungs(productEvidenceEntry, policy).length > 0) return "proven";
  }
  return "selling";
}

/** The rung a product currently sits at. */
export function currentRung(kind: ProductSourceKind): number {
  return methodProfile(kind).rung;
}
