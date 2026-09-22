import { headers } from "next/headers";
import type { IntegrationProvider } from "@prisma/client";
import { configuredAppOrigin } from "@/lib/config/appOrigin";

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
 * THE ORIGIN IS RESOLVED IN ONE PLACE (2026-09-22, migration phase 1). This
 * read VERCEL_PROJECT_PRODUCTION_URL directly while emailOrigin() read
 * NEXTAUTH_URL first, so the same question had two answers and no single knob
 * moved both. lib/config/appOrigin.ts is now that knob; see its comment for
 * why Vercel's variable cannot be trusted as configuration during a domain
 * migration.
 *
 * Falls back to the request host when nothing is configured, which is what
 * local development relies on and is unchanged.
 */
export async function canonicalBaseUrl(): Promise<string> {
  return configuredAppOrigin() ?? getBaseUrl();
}
