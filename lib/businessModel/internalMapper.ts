import type { Order, Product } from "@prisma/client";
import type { CanonicalRecord } from "./entities";

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
      type: order.status === "refunded" ? "refund" : "sale",
      date: order.createdAt.toISOString(),
      contactId: internalContactId(order.buyerEmail),
      itemIds: order.productId ? [internalItemId(order.productId)] : [],
      status: order.status,
    },
    syncedAt: new Date(),
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
    },
    syncedAt: new Date(),
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
    };
  });
}
