import type { Order, Product } from "@prisma/client";
import type { CanonicalRecord } from "./entities";
import { countsAsRevenue } from "@/lib/orders/orderStatus";

// Phase 3 Milestone 1 (J4 Foundation) — pure functions mapping the store's
// own already-live Order/Product data into the canonical shape, computed on
// every read rather than persisted as BusinessRecord rows. See
// reasoning.ts's queryRecords for why: this data is already live in
// Postgres, so persisting a synced copy would mean solving cache
// invalidation (when does a new Order trigger a write?) for data that
// doesn't need it. A real external connector's future mapToBusinessRecords()
// will produce objects in this exact same shape, just persisted instead of
// computed live — these functions are what prove that shape is right before
// any external connector exists.
//
// EVERYTHING HERE IS DERIVED PROVENANCE (2026-08-22), and that is a stronger
// claim than it sounds. DERIVED is not a hedge and not a synonym for "guessed":
// these records are arithmetic over Order and Product rows this platform owns
// outright, so they are exactly as trustworthy as those rows and need no
// qualifying language when J4 speaks about them. The one thing that would make
// them dishonest is a fabricated statedAt, so each carries the date its own
// underlying record actually carries — an order's createdAt, a product's
// updatedAt — never the moment the mapping happened to run.

export function internalContactId(email: string): string {
  return `internal:contact:${email}`;
}

export function internalTransactionId(orderId: string): string {
  return `internal:transaction:${orderId}`;
}

export function internalItemId(productId: string): string {
  return `internal:item:${productId}`;
}

export function mapOrdersToTransactions(
  orders: Order[]
): CanonicalRecord<"transaction">[] {
  return orders.map((order) => ({
    id: internalTransactionId(order.id),
    entityType: "transaction",
    sourceProvider: "internal",
    data: {
      amountInCents: order.amountInCents,
      currency: "usd",
      // ============ ONLY MONEY WE ACTUALLY HOLD IS A SALE (2026-08-30) ==
      //
      // Was `status === "refunded" ? "refund" : "sale"`, which counted a
      // disputed and even a charged-back order as revenue — the bank had taken
      // the money and every report still called it income.
      //
      // Reads the CURRENT status rather than remembering a verdict, so a
      // dispute that is won returns to `paid` and counts again by itself.
      type: countsAsRevenue(order.status) ? "sale" : "refund",
      date: order.createdAt.toISOString(),
      contactId: internalContactId(order.buyerEmail),
      itemIds: order.productId ? [internalItemId(order.productId)] : [],
      status: order.status,
    },
    syncedAt: new Date(),
    provenance: "DERIVED",
    provenanceDetail: "order",
    // When the sale happened, not when this mapping ran.
    statedAt: order.createdAt,
    statedById: null,
    modelExtracted: false,
  }));
}

export function mapProductsToItems(
  products: Product[]
): CanonicalRecord<"item">[] {
  return products.map((product) => ({
    id: internalItemId(product.id),
    entityType: "item",
    sourceProvider: "internal",
    data: {
      name: product.name,
      sku: product.id,
      priceInCents: product.priceInCents,
      category: null,
      active: product.active,
      // The storefront's own Product model has no stock/quantity concept
      // at all — an honest null, not a fabricated number.
      quantityAvailable: null,
    },
    syncedAt: new Date(),
    provenance: "DERIVED",
    provenanceDetail: "product",
    // When the owner last changed the product, which is when its price and
    // name were last actually asserted.
    statedAt: product.updatedAt,
    statedById: null,
    modelExtracted: false,
  }));
}

export function deriveContactsFromOrders(
  orders: Order[]
): CanonicalRecord<"contact">[] {
  const byEmail = new Map<string, Order[]>();
  for (const order of orders) {
    const existing = byEmail.get(order.buyerEmail);
    if (existing) {
      existing.push(order);
    } else {
      byEmail.set(order.buyerEmail, [order]);
    }
  }

  return [...byEmail.entries()].map(([email, buyerOrders]) => {
    const dates = buyerOrders.map((o) => o.createdAt.getTime());
    return {
      id: internalContactId(email),
      entityType: "contact",
      sourceProvider: "internal",
      data: {
        name: null,
        email,
        roles: ["customer"],
        firstSeenAt: new Date(Math.min(...dates)).toISOString(),
        lastSeenAt: new Date(Math.max(...dates)).toISOString(),
      },
      syncedAt: new Date(),
      provenance: "DERIVED",
      provenanceDetail: "order",
      // A customer is asserted by their most recent order, not their first —
      // the latest one is the evidence that this is still a real customer.
      statedAt: new Date(Math.max(...dates)),
      statedById: null,
      modelExtracted: false,
    };
  });
}
