import { headers } from "next/headers";
import type { IntegrationProvider } from "@prisma/client";

// Shared by every OAuth-style connector — extracted out of stripe.ts during
// PH-06 so PayPal (and any future redirect-based connector) doesn't
// duplicate the same base-URL/callback-URL logic stripe.ts used to define
// locally.
export async function getBaseUrl(): Promise<string> {
  const headersList = await headers();
  const host = headersList.get("host");
  // LOOPBACK IS LOOPBACK BY ADDRESS, NOT BY SPELLING (2026-08-27).
  //
  // This tested `startsWith("localhost")`, so a dev server on 127.0.0.1 — the
  // same machine, reached by number instead of name — was handed https. The
  // redirect_url given to the provider then pointed at a scheme nothing was
  // listening on, and the callback could not come back.
  //
  // Found by the Creation Station browser suite, whose harness binds 127.0.0.1.
  // Production is https either way, so this was only ever a local-development
  // failure — which is exactly the kind that costs an afternoon.
  const protocol = host && /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host) ? "http" : "https";
  return `${protocol}://${host}`;
}

// The one place the generic callback route's URL shape
// (app/api/integrations/[provider]/callback/route.ts) is spelled out, so a
// connector never hardcodes its own copy of the literal path.
export function integrationCallbackUrl(baseUrl: string, provider: IntegrationProvider): string {
  return `${baseUrl}/api/integrations/${provider.toLowerCase()}/callback`;
}

/**
 * The URL a provider should call back to for the lifetime of a subscription —
 * not "whatever host this request came in on".
 *
 * getBaseUrl() derives the host from the request, which is right for an OAuth
 * redirect (the browser has to come back to where it started) and wrong for
 * anything durable. A merchant who connects PayPal from a preview deployment
 * would otherwise have a refund webhook registered against that preview's
 * hostname — it works until the deployment is rotated, and then their refunds
 * silently stop arriving with nothing anywhere saying why.
 *
 * VERCEL_PROJECT_PRODUCTION_URL is the project's own production domain and is
 * present automatically on every Vercel deployment, so this needs no new
 * configuration. Falls back to the request host locally, where there is no
 * canonical domain to prefer.
 */
export async function canonicalBaseUrl(): Promise<string> {
  const domain = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (domain) return domain.startsWith("http") ? domain : `https://${domain}`;
  return getBaseUrl();
}
