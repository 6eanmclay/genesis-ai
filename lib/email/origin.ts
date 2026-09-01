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
 * NEXTAUTH_URL first: it is the value that already has to be correct for sign-in
 * to work, so a deployment where it is wrong is broken in a louder way than
 * this. VERCEL_PROJECT_PRODUCTION_URL second — Vercel sets it to the project's
 * stable production domain, which is the right target even when a job happens
 * to run on a preview deployment.
 *
 * Deliberately NOT VERCEL_URL: that is the per-deployment URL, unique to one
 * build, so a link built from it would rot the moment anything else shipped.
 */
export function emailOrigin(): string | null {
  const configured = process.env.NEXTAUTH_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

  return null;
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
