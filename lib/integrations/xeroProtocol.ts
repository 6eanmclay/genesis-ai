import type { Contact, Document } from "@/lib/businessModel/entities";

// TALKING TO XERO — the half that can be proven without a Xero account.
//
// Verified against Xero's own documentation on 2026-08-27. Three findings below
// would each have been wrong if carried from memory, and one of them is the
// same mistake that took QuickBooks down here for eighteen days.
//
// ============ 1. THE SCOPES CHANGED, AND NEW APPS CANNOT USE THE OLD ONES ==
//
// Xero replaced two broad scopes with ten granular ones on 2 MARCH 2026. Apps
// created before then have until September 2027 to migrate; apps created ON OR
// AFTER have NO ACCESS TO THE BROAD SCOPES AT ALL.
//
// Genesis's app does not exist yet, so it will be created after that date and
// must use the granular set. Requesting `accounting.transactions` -- the scope
// every older tutorial and every pre-2026 memory names -- would simply fail.
//   https://www.apideck.com/blog/xero-scopes
//
// ============ 2. REFRESH TOKENS ROTATE ====================================
//
// "When a refresh token is exchanged, the previous access and refresh tokens
// are invalidated and new tokens are returned."
//
// This is the QuickBooks failure exactly: a connector that keeps refreshing
// with the token it started with works once, then dies with invalid_grant, and
// the death is silent because nothing was wrong at the moment of connecting.
// The access token lasts THIRTY MINUTES, so it dies fast.
//
// Xero allows a 30-minute grace period on the OLD token specifically so a
// failed round trip can be retried -- which is why a refresh that errors must
// not immediately discard what it has.
//
// ============ 3. A CONNECTION IS NOT AN ORGANISATION ======================
//
// One Xero authorization can cover MULTIPLE tenants (organisations), and every
// API call needs an explicit `Xero-Tenant-Id` header naming which one. There is
// no default. A token alone is not enough to read anything, which is unlike
// every other connector in this codebase.

export const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
export const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
export const XERO_REVOCATION_URL = "https://identity.xero.com/connect/revocation";
/** Lists the tenants one authorization actually covers. */
export const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
export const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";

/**
 * The granular scopes, post-March-2026.
 *
 * `offline_access` IS NOT OPTIONAL: without it Xero issues no refresh token at
 * all, and a connection that has to be re-consented every thirty minutes is not
 * a connection. The `.read` variants are deliberate -- Genesis reads a
 * business's accounting to explain it, and never writes back.
 */
export const XERO_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  // Organisation details and the items endpoint.
  "accounting.settings.read",
  "accounting.contacts.read",
  "accounting.invoices.read",
] as const;

export function xeroAuthorizeUrl(params: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(XERO_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  // Space-separated, per OAuth 2.0. Xero rejects a comma-separated list.
  url.searchParams.set("scope", XERO_SCOPES.join(" "));
  url.searchParams.set("state", params.state);
  return url.toString();
}

// ============ FAILURES ====================================================

export type XeroFailure =
  /** The grant is gone — revoked, or a rotated refresh token was reused. */
  | { kind: "auth"; detail: string }
  | { kind: "rate_limit"; detail: string }
  /** Authorized, but not for the organisation or data being asked for. */
  | { kind: "no_tenant"; detail: string }
  | { kind: "provider"; detail: string };

interface XeroErrorBody {
  error?: string;
  error_description?: string;
  Message?: string;
  Detail?: string;
}

/**
 * What Xero said, mapped to what it means for an owner.
 *
 * `invalid_grant` IS THE ONE THAT MATTERS. It is what a rotated-away refresh
 * token returns, and it is indistinguishable from a merchant revoking access.
 * Both mean the same thing to the owner — reconnect — so both map to `auth`.
 * What must NOT happen is reporting it as a provider outage, which would tell
 * an owner to wait for something that is never going to fix itself.
 */
export function classifyXeroFailure(httpStatus: number, body: unknown): XeroFailure {
  const error = (typeof body === "object" && body !== null ? (body as XeroErrorBody) : {}) as XeroErrorBody;
  const code = error.error ?? "";
  const detail =
    error.error_description?.trim() ||
    error.Detail?.trim() ||
    error.Message?.trim() ||
    code ||
    `Xero returned HTTP ${httpStatus}`;

  if (code === "invalid_grant" || code === "invalid_client" || httpStatus === 401) {
    return { kind: "auth", detail };
  }
  if (httpStatus === 429) return { kind: "rate_limit", detail };
  if (httpStatus === 403) return { kind: "no_tenant", detail };
  return { kind: "provider", detail };
}

// ============ THE ROTATION, AS A PURE DECISION ============================
//
// Extracted from the connector so it can be PROVEN rather than described. The
// first version of this logic was asserted by grepping the connector's source
// for a comment saying it was correct, which tests prose and not behaviour —
// and comment-stripping quite rightly broke it.

export interface XeroTokenPair {
  accessToken: string;
  refreshToken: string;
  /** Epoch millis, or null where Xero did not say. */
  expiresAt: number | null;
}

/**
 * Should the access token be renewed before it is used?
 *
 * A MINUTE OF MARGIN, because Xero's access token lasts thirty minutes and a
 * token that expires mid-request comes back as a 401 indistinguishable from a
 * revoked grant. `null` counts as expiring: an unknown expiry is not a licence
 * to assume it is fine.
 */
export function shouldRefresh(expiresAt: number | null, now: number): boolean {
  if (expiresAt === null) return true;
  return expiresAt - 60_000 <= now;
}

/**
 * The token pair to store after a refresh SUCCEEDS.
 *
 * THE NEW REFRESH TOKEN REPLACES THE OLD ONE. Xero invalidates the old pair on
 * every exchange, so a connector that keeps its original refresh token works
 * exactly once and then dies with invalid_grant. That is not hypothetical — it
 * is what happened to QuickBooks in this codebase, and `tokenLifetime:
 * "rotating"` exists as a field because of it.
 */
export function rotatedCredentials(
  response: { access_token?: string; refresh_token?: string; expires_in?: number },
  now: number,
): XeroTokenPair | null {
  if (!response.access_token || !response.refresh_token) return null;
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: response.expires_in ? now + response.expires_in * 1000 : null,
  };
}

/**
 * The token pair to keep after a refresh FAILS.
 *
 * KEEPS WHAT IT HAS. Xero honours the previous refresh token for a 30-minute
 * grace period specifically so a failed round trip can be retried, so
 * discarding here would turn a network blip into a dead connection that the
 * owner has to reconnect by hand.
 */
export function credentialsAfterFailedRefresh(current: XeroTokenPair): XeroTokenPair {
  return current;
}

// ============ TENANTS =====================================================

export interface XeroConnection {
  id?: string;
  tenantId?: string;
  tenantType?: string;
  tenantName?: string;
}

/**
 * The organisation to read from, out of everything the merchant authorised.
 *
 * PICKS THE FIRST *ORGANISATION*, not simply the first connection. Xero returns
 * other tenant types alongside them, and reading a non-organisation tenant as
 * if it were the business's books would produce confident nonsense. Null when
 * there is none, which is a real state — a merchant can complete consent
 * without granting an organisation.
 */
export function chooseTenant(connections: XeroConnection[]): XeroConnection | null {
  const organisations = connections.filter((c) => c.tenantId && c.tenantType === "ORGANISATION");
  return organisations[0] ?? null;
}

// ============ MAPPING XERO'S SHAPES INTO THE FOUNDATION'S =================

export interface XeroContact {
  ContactID?: string;
  Name?: string;
  EmailAddress?: string;
  IsCustomer?: boolean;
  IsSupplier?: boolean;
  UpdatedDateUTC?: string;
}

/**
 * Xero dates arrive as `/Date(1712345678000+0000)/` in some payloads and as
 * ISO 8601 in others. Both are handled; an unreadable one becomes null rather
 * than Invalid Date, which would serialise as `null` anyway but only after
 * poisoning any comparison it touched first.
 */
export function xeroDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const dotNet = raw.match(/^\/Date\((-?\d+)/);
  if (dotNet) {
    const ms = Number(dotNet[1]);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function xeroContactToContact(contact: XeroContact): Contact | null {
  if (!contact.ContactID) return null;
  // A Xero contact can be BOTH customer and supplier — a business that buys
  // from you and sells to you — which is exactly why `roles` is a list.
  const roles: string[] = [];
  if (contact.IsCustomer) roles.push("customer");
  if (contact.IsSupplier) roles.push("vendor");

  const seen = xeroDate(contact.UpdatedDateUTC) ?? new Date(0).toISOString();
  return {
    name: contact.Name?.trim() || null,
    email: contact.EmailAddress?.trim() || null,
    roles,
    firstSeenAt: seen,
    lastSeenAt: seen,
  };
}

export interface XeroInvoice {
  InvoiceID?: string;
  Type?: string;
  Total?: number;
  AmountDue?: number;
  Status?: string;
  Contact?: { ContactID?: string };
  DateString?: string;
  Date?: string;
  DueDateString?: string;
  DueDate?: string;
}

/** Xero's status vocabulary, in the Foundation's terms. */
function documentStatus(invoice: XeroInvoice): string | null {
  const status = invoice.Status?.toUpperCase();
  if (!status) return null;
  if (status === "PAID") return "paid";
  if (status === "VOIDED" || status === "DELETED") return "void";
  if (status === "DRAFT" || status === "SUBMITTED") return "draft";
  if (status === "AUTHORISED") {
    // AUTHORISED means issued and awaiting payment. Whether it is OVERDUE is
    // a fact about the due date, which Xero does not fold into Status.
    const due = xeroDate(invoice.DueDateString ?? invoice.DueDate);
    if (due && Date.parse(due) < Date.now()) return "overdue";
    return "pending";
  }
  return status.toLowerCase();
}

export function xeroInvoiceToDocument(invoice: XeroInvoice): Document | null {
  if (!invoice.InvoiceID) return null;
  // ACCREC is money owed TO the business; ACCPAY is money the business owes.
  // Recording a bill as an invoice would count an expense as revenue.
  const type = invoice.Type === "ACCPAY" ? "bill" : "invoice";
  return {
    type,
    // Xero returns Total in the currency's MAJOR unit as a decimal number --
    // 42.5 means $42.50 -- which is the opposite of Square. Multiplying is
    // correct here and would be a hundredfold error there.
    amountInCents: typeof invoice.Total === "number" && Number.isFinite(invoice.Total)
      ? Math.round(invoice.Total * 100)
      : null,
    status: documentStatus(invoice),
    contactId: invoice.Contact?.ContactID ?? null,
    issuedAt: xeroDate(invoice.DateString ?? invoice.Date),
    dueAt: xeroDate(invoice.DueDateString ?? invoice.DueDate),
  };
}
