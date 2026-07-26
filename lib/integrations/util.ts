import { headers } from "next/headers";
import type { IntegrationProvider } from "@prisma/client";

// Shared by every OAuth-style connector — extracted out of stripe.ts during
// PH-06 so PayPal (and any future redirect-based connector) doesn't
// duplicate the same base-URL/callback-URL logic stripe.ts used to define
// locally.
export async function getBaseUrl(): Promise<string> {
  const headersList = await headers();
  const host = headersList.get("host");
  const protocol = host?.startsWith("localhost") ? "http" : "https";
  return `${protocol}://${host}`;
}

// The one place the generic callback route's URL shape
// (app/api/integrations/[provider]/callback/route.ts) is spelled out, so a
// connector never hardcodes its own copy of the literal path.
export function integrationCallbackUrl(baseUrl: string, provider: IntegrationProvider): string {
  return `${baseUrl}/api/integrations/${provider.toLowerCase()}/callback`;
}
