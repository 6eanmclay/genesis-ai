import type { Contact, Item, Transaction } from "@/lib/businessModel/entities";

// TALKING TO SQUARE — the half that can be proven without a Square account.
//
// Verified against Square's own documentation on 2026-08-27. Every non-obvious
// claim names where it came from, because three of them are the sort of thing
// that is easy to assume wrongly.
//
// ============ WHAT THE DOCS ACTUALLY SAY ==================================
//
// SQUARE-VERSION IS A REQUIRED HEADER, and it is dated rather than numbered.
// Square ships a new one roughly monthly and an omitted header does not mean
// "latest" — it means whatever default Square picks, which is not a decision to
// leave to them. Pinning it is what stops a Square release quietly changing a
// response shape underneath us.
//   https://developer.squareup.com/docs/build-basics/versioning-overview
//
// MONEY IS ALREADY IN THE SMALLEST UNIT. Square's Money object carries `amount`
// as an integer of the currency's minor unit — cents for USD — so it needs no
// conversion, and "helpfully" multiplying by 100 would inflate every figure a
// hundredfold. This is the opposite of most APIs and is worth stating.
//   https://developer.squareup.com/reference/square/objects/Money
//
// ACCESS TOKENS EXPIRE AFTER 30 DAYS, and code-flow refresh tokens DO NOT
// expire and DO NOT rotate. That is the reverse of Xero, whose refresh tokens
// rotate on every use — the two connectors sit side by side in this codebase
// and getting them the wrong way round is a silent death about a month later.
//   https://developer.squareup.com/docs/oauth-api/overview

/** Pinned. Square's latest as of 2026-08-27; it ships roughly monthly. */
export const SQUARE_API_VERSION = "2026-07-15";

export const SQUARE_PRODUCTION_HOST = "https://connect.squareup.com";
export const SQUARE_SANDBOX_HOST = "https://connect.squareupsandbox.com";

/**
 * The permissions Genesis asks for, and nothing beyond them.
 *
 * ALL READ, NO WRITE. Square is a system the business already operates; the
 * non-goal this codebase has held since Phase 3 is "leave the underlying
 * software responsible for its own operational workflows". Genesis reads to
 * understand, and asking for a WRITE scope it never uses would be asking a
 * merchant to grant something on the off-chance.
 *   https://developer.squareup.com/docs/oauth-api/square-permissions
 */
export const SQUARE_SCOPES = [
  "MERCHANT_PROFILE_READ",
  "ORDERS_READ",
  "ITEMS_READ",
  "PAYMENTS_READ",
  "CUSTOMERS_READ",
] as const;

export function squareHost(useSandbox: boolean): string {
  return useSandbox ? SQUARE_SANDBOX_HOST : SQUARE_PRODUCTION_HOST;
}

export function squareAuthorizeUrl(params: {
  useSandbox: boolean;
  clientId: string;
  state: string;
  /** Square requires the redirect to match the one registered on the app. */
  redirectUri: string;
}): string {
  const url = new URL(`${squareHost(params.useSandbox)}/oauth2/authorize`);
  url.searchParams.set("client_id", params.clientId);
  // Square wants scopes SPACE-separated in the query string. A comma-separated
  // list is accepted by the URL builder and rejected by Square.
  url.searchParams.set("scope", SQUARE_SCOPES.join(" "));
  url.searchParams.set("session", "false");
  url.searchParams.set("state", params.state);
  url.searchParams.set("redirect_uri", params.redirectUri);
  return url.toString();
}

export function squareTokenUrl(useSandbox: boolean): string {
  return `${squareHost(useSandbox)}/oauth2/token`;
}

export function squareRevokeUrl(useSandbox: boolean): string {
  return `${squareHost(useSandbox)}/oauth2/revoke`;
}

// ============ FAILURES ====================================================

export type SquareFailure =
  | { kind: "auth"; detail: string }
  | { kind: "rate_limit"; detail: string }
  /** The merchant did not grant a permission this call needs. */
  | { kind: "insufficient_scope"; detail: string }
  | { kind: "provider"; detail: string };

interface SquareErrorBody {
  errors?: { category?: string; code?: string; detail?: string; field?: string }[];
}

/**
 * Square's error envelope, mapped to what it means for an owner.
 *
 * Square answers with an `errors` ARRAY and a category/code pair. The category
 * is the useful axis: AUTHENTICATION_ERROR and RATE_LIMIT_ERROR are
 * unambiguous, while a 403 with INSUFFICIENT_SCOPES means the merchant
 * connected but did not grant something — a different conversation from "your
 * connection broke", and the one most likely to be misreported.
 *   https://developer.squareup.com/reference/square/objects/Error
 */
export function classifySquareFailure(httpStatus: number, body: unknown): SquareFailure {
  const errors = (typeof body === "object" && body !== null ? (body as SquareErrorBody).errors : null) ?? [];
  const first = errors[0];
  const detail =
    first?.detail?.trim() ||
    first?.code ||
    `Square returned HTTP ${httpStatus}`;

  const category = first?.category ?? "";
  const code = first?.code ?? "";

  if (code === "INSUFFICIENT_SCOPES" || code === "FORBIDDEN") {
    return { kind: "insufficient_scope", detail };
  }
  if (category === "AUTHENTICATION_ERROR" || httpStatus === 401) {
    return { kind: "auth", detail };
  }
  if (category === "RATE_LIMIT_ERROR" || httpStatus === 429) {
    return { kind: "rate_limit", detail };
  }
  if (httpStatus === 403) return { kind: "insufficient_scope", detail };
  return { kind: "provider", detail };
}

// ============ MAPPING SQUARE'S SHAPES INTO THE FOUNDATION'S ===============

export interface SquareMoney {
  amount?: number | string;
  currency?: string;
}

/**
 * Cents from a Square Money, or null.
 *
 * ALREADY THE SMALLEST UNIT — see this file's header. Returns null rather than
 * zero when absent, because a missing amount and a genuinely free line are
 * different facts and only one of them should be summed.
 */
export function moneyToCents(money: SquareMoney | null | undefined): number | null {
  if (!money || money.amount == null) return null;
  const amount = typeof money.amount === "string" ? Number(money.amount) : money.amount;
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount);
}

export interface SquareCustomer {
  id?: string;
  given_name?: string;
  family_name?: string;
  company_name?: string;
  email_address?: string;
  created_at?: string;
  updated_at?: string;
}

export function customerToContact(customer: SquareCustomer): Contact | null {
  if (!customer.id) return null;
  const person = [customer.given_name, customer.family_name].filter(Boolean).join(" ").trim();
  // A company with no contact name is still a real customer, so the company
  // name is a fallback rather than being dropped.
  const name = person || customer.company_name?.trim() || null;
  const created = customer.created_at ?? customer.updated_at ?? null;
  return {
    name,
    email: customer.email_address?.trim() || null,
    // Square customers are people who bought something. "customer" is the role,
    // and the vocabulary is open so this can gain others later.
    roles: ["customer"],
    firstSeenAt: created ?? new Date(0).toISOString(),
    lastSeenAt: customer.updated_at ?? created ?? new Date(0).toISOString(),
  };
}

export interface SquarePayment {
  id?: string;
  amount_money?: SquareMoney;
  status?: string;
  created_at?: string;
  customer_id?: string;
  order_id?: string;
  refunded_money?: SquareMoney;
}

export function paymentToTransaction(payment: SquarePayment): Transaction | null {
  if (!payment.id) return null;
  const cents = moneyToCents(payment.amount_money);
  // A payment with no readable amount is not a transaction worth recording —
  // it would sum as zero and quietly drag every average down.
  if (cents === null) return null;
  return {
    amountInCents: cents,
    currency: (payment.amount_money?.currency ?? "USD").toLowerCase(),
    // A REFUND IS NOT A SALE. Square reports both through the same resource,
    // and recording a refund as a sale would overstate revenue twice — once by
    // counting it, once by not subtracting it.
    type: moneyToCents(payment.refunded_money) ? "refund" : "sale",
    date: payment.created_at ?? new Date(0).toISOString(),
    contactId: payment.customer_id ?? null,
    itemIds: payment.order_id ? [payment.order_id] : [],
    status: payment.status?.toLowerCase() ?? null,
  };
}

export interface SquareCatalogObject {
  id?: string;
  type?: string;
  is_deleted?: boolean;
  item_data?: {
    name?: string;
    description?: string;
    category_id?: string;
    variations?: {
      id?: string;
      item_variation_data?: { sku?: string; price_money?: SquareMoney };
    }[];
  };
}

export function catalogObjectToItem(object: SquareCatalogObject): Item | null {
  if (!object.id || object.type !== "ITEM" || !object.item_data?.name) return null;
  // Square puts price and SKU on the VARIATION, not the item. The first
  // variation is the representative one; an item with none has no price, which
  // is recorded as unknown rather than as free.
  const variation = object.item_data.variations?.[0]?.item_variation_data;
  return {
    name: object.item_data.name,
    sku: variation?.sku?.trim() || null,
    priceInCents: moneyToCents(variation?.price_money),
    category: object.item_data.category_id ?? null,
    // `is_deleted` is Square's soft delete. Absent means present.
    active: object.is_deleted === true ? false : true,
    // Square tracks inventory through a separate API this connector does not
    // request a scope for. Null is the honest answer, not zero.
    quantityAvailable: null,
  };
}
