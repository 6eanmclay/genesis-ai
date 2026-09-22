import { configuredAppOrigin } from "@/lib/config/appOrigin";

// WHERE GENESIS LIVES, ANSWERED WITHOUT A REQUEST.
//
// ============ WHY getBaseUrl CANNOT DO THIS (2026-09-01) ===============
//
// lib/integrations/util.ts's getBaseUrl reads the incoming Host header, which
// is exactly right for an OAuth callback — the provider must come back to the
// origin the person actually used. It is useless to a background job, which
// has no request to read.
//
// The merchant's new-sale email is sent from the queue. It needs a link to the
// order, and a link is only worth putting in an email if it is right.
//
// ============ AND WHY IT MAY RETURN NOTHING ===========================
//
// A guessed origin produces a link that 404s, or worse, points somewhere that
// is not this deployment. An owner who clicks a broken link in a sale
// notification learns not to trust the next one.
//
// So this returns null when nothing authoritative is configured, and the email
// omits the link rather than inventing it — the same rule the shipping address
// block already follows, where an absent address renders nothing rather than an
// empty box.

/**
 * The canonical origin for links in email, or null when nothing says.
 *
 * ONE RESOLVER SINCE 2026-09-22 (migration phase 1). This used to read the
 * environment itself, in a different order from canonicalBaseUrl() — so
 * setting NEXTAUTH_URL moved the links in email while leaving PayPal's webhook
 * registration pointing elsewhere. Both now ask lib/config/appOrigin.ts, which
 * documents the precedence and why Vercel's own variable is not configuration.
 *
 * The null is still the point of this function, and it is not the shared
 * helper's decision: an email link that cannot be built correctly is OMITTED
 * rather than guessed, because an owner who clicks a broken link in a sale
 * notification learns not to trust the next one.
 */
export function emailOrigin(): string | null {
  return configuredAppOrigin();
}

/**
 * A link straight to one order, or null when the origin is unknown.
 *
 * The business-scoped route rather than the legacy one. `/dashboard/orders/:id`
 * resolves whichever business the ACCOUNT last made active, so a link sent
 * about business A can open an order in the context of business B — or bounce
 * to the chooser. `/b/:slug/orders/:id` names the business, which is what a
 * link in an email has to do.
 */
export function orderUrl(storeSlug: string, orderId: string): string | null {
  const origin = emailOrigin();
  return origin ? `${origin}/b/${storeSlug}/orders/${orderId}` : null;
}
