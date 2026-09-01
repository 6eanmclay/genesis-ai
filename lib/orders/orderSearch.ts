import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

// FINDING ONE ORDER OUT OF ALL OF THEM.
//
// ============ WHAT A MERCHANT ACTUALLY HAS IN THEIR HAND ===============
//
// The orders list shows the hundred most recent and offers no way to search,
// which is fine at seven orders and useless at seven hundred. The question is
// what somebody fulfilling an order actually knows when they go looking:
//
//   a customer emails about "my bracelet"          -> product name
//   a customer emails from their own address       -> buyer email
//   a customer signs their name                    -> the shipping name
//   a support thread quotes an order number        -> the order id
//   a carrier query quotes a tracking number       -> tracking
//   Stripe shows a payment reference               -> the provider's own id
//
// All six are searched, because a merchant does not know which of them they
// happen to be holding, and a search that only matched email would send them
// back to scrolling.
//
// ============ THE NAME IS NOT A COLUMN =================================
//
// There is no Order.customerName. The name lives inside the shippingAddress
// JSON, because that is where checkout puts it, and it is queried through a
// JSON path rather than copied into a column — a second copy is a second thing
// to keep true, and this one would be wrong the moment an address is corrected.
//
// ============ AND STORE SCOPING IS NOT OPTIONAL ========================
//
// storeId is a required parameter, not a filter a caller may forget. There is
// no overload without it and no default. A merchant searching their own orders
// can never be handed somebody else's, whatever they type — including another
// store's order id, which is the obvious thing to try.

/** One row of results, shaped for a list rather than a detail view. */
export interface OrderSearchHit {
  id: string;
  productName: string;
  quantity: number;
  buyerEmail: string;
  customerName: string | null;
  status: string;
  fulfillmentStatus: string;
  trackingNumber: string | null;
  createdAt: Date;
  amountInCents: number;
  /** Which field matched, so the list can say why a row is there. */
  matchedOn: MatchField;
}

export type MatchField =
  | "order id"
  | "customer email"
  | "customer name"
  | "product"
  | "tracking number"
  | "payment reference";

/** How many rows one search returns. Bounded so a broad term stays a page. */
export const SEARCH_LIMIT = 50;

/** Below this, a query matches too much to be a search. */
export const MIN_QUERY_LENGTH = 2;

export interface OrderSearchResult {
  hits: OrderSearchHit[];
  /** True when the cap was reached and more exist. */
  more: boolean;
  /** Echoed back so a surface can say what it searched for. */
  query: string;
}

function nameOf(shippingAddress: Prisma.JsonValue | null): string | null {
  if (!shippingAddress || typeof shippingAddress !== "object" || Array.isArray(shippingAddress)) {
    return null;
  }
  const name = (shippingAddress as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/**
 * Why this row came back.
 *
 * Recomputed from the row rather than tracked through the query, because a
 * single OR cannot say which branch matched. Ordered most-specific first: an
 * id or a tracking number is an exact thing somebody typed, a product name is
 * the vaguest, and labelling a row "product" when they pasted an order id
 * would read as a bad match.
 */
export function matchFieldFor(
  query: string,
  row: { id: string; buyerEmail: string; productName: string; trackingNumber: string | null;
         externalOrderId: string; shippingAddress: Prisma.JsonValue | null;
         items?: { productName: string }[] },
): MatchField {
  const q = query.toLowerCase();
  if (row.id.toLowerCase().includes(q)) return "order id";
  if (row.trackingNumber?.toLowerCase().includes(q)) return "tracking number";
  if (row.buyerEmail.toLowerCase().includes(q)) return "customer email";
  if (nameOf(row.shippingAddress)?.toLowerCase().includes(q)) return "customer name";
  if (row.externalOrderId.toLowerCase().includes(q)) return "payment reference";
  return "product";
}

/**
 * Search one business's orders.
 *
 * Never throws on a useless query — an empty or one-character term returns no
 * hits rather than an error, because a search box that errors as you type is
 * worse than one that waits.
 */
export async function searchOrders(
  storeId: string,
  query: string,
  options: { limit?: number } = {},
): Promise<OrderSearchResult> {
  const trimmed = query.trim();
  const limit = options.limit ?? SEARCH_LIMIT;
  if (trimmed.length < MIN_QUERY_LENGTH) {
    return { hits: [], more: false, query: trimmed };
  }

  const contains = { contains: trimmed, mode: "insensitive" as const };

  // ============ THE NAME NEEDS RAW SQL, AND ONLY THE NAME ==========
  //
  // Found by testing rather than by reading: Prisma's JSON filter
  // `string_contains` has no `mode: "insensitive"` — that option exists for
  // string COLUMNS and not for JSON paths. So searching "gabriel" did not find
  // "Gabriel Mendies" while "endie" did, which is the worst kind of half-working:
  // it looks like the search is fine until somebody types a name the way people
  // actually type names.
  //
  // Postgres can do it with ILIKE on the extracted field. Raw for this ONE
  // predicate rather than raw for the whole search, so everything Prisma
  // expresses correctly stays in Prisma — and parameterised, never interpolated,
  // because this string comes from a search box.
  const nameMatches = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Order"
     WHERE "storeId" = ${storeId}
       AND "shippingAddress"->>'name' ILIKE ${`%${trimmed}%`}
     LIMIT ${limit + 1}
  `;
  const nameMatchIds = nameMatches.map((r) => r.id);

  const rows = await prisma.order.findMany({
    where: {
      // FIRST AND NOT NEGOTIABLE. Everything below is an OR; this is the AND
      // that makes the OR safe.
      storeId,
      OR: [
        { id: contains },
        { buyerEmail: contains },
        { productName: contains },
        { trackingNumber: contains },
        { externalOrderId: contains },
        // The name checkout recorded. Matched case-insensitively by the raw
        // query above and joined back in by id — the ids are already
        // store-scoped by that query's own WHERE, so this cannot widen the
        // search beyond this business even if it returned something unexpected.
        ...(nameMatchIds.length > 0 ? [{ id: { in: nameMatchIds } }] : []),
        // ============ THE LINE ITEMS, NOT JUST THE SUMMARY ======
        //
        // Order.productName is "…and 1 more" on a multi-product order, so a
        // merchant searching for the second product would find nothing while
        // holding an order that contains it.
        { items: { some: { productName: contains } } },
      ],
    },
    orderBy: { createdAt: "desc" },
    // One more than asked for, so "there are more" is a fact rather than a
    // guess from a full page.
    take: limit + 1,
    select: {
      id: true, productName: true, quantity: true, buyerEmail: true,
      status: true, fulfillmentStatus: true, trackingNumber: true,
      createdAt: true, amountInCents: true, externalOrderId: true,
      shippingAddress: true,
      items: { select: { productName: true } },
    },
  });

  const more = rows.length > limit;
  return {
    query: trimmed,
    more,
    hits: rows.slice(0, limit).map((row) => ({
      id: row.id,
      productName: row.productName,
      quantity: row.quantity,
      buyerEmail: row.buyerEmail,
      customerName: nameOf(row.shippingAddress),
      status: row.status,
      fulfillmentStatus: row.fulfillmentStatus,
      trackingNumber: row.trackingNumber,
      createdAt: row.createdAt,
      amountInCents: row.amountInCents,
      matchedOn: matchFieldFor(trimmed, row),
    })),
  };
}
