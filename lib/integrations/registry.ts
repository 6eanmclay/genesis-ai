import type { IntegrationProvider } from "@prisma/client";
import type { IntegrationConnector } from "./types";
import { stripeConnector } from "./stripe";
import { paypalConnector } from "./paypal";
import { googleCalendarConnector } from "./googleCalendar";
import { quickbooksConnector } from "./quickbooks";
import { mailchimpConnector } from "./mailchimp";
import { printfulConnector } from "./printful";
import { facebookConnector } from "./facebook";
import { instagramConnector } from "./instagram";
import { tiktokConnector } from "./tiktok";
import { easypostConnector } from "./easypost";

// Adding a new integration means writing a connector module and adding one
// line here — nothing else in the framework needs to know it exists. The 3
// Phase 3 Milestone 2 proof integrations (Connector Framework) added below
// exercise 3 different auth patterns without needing anything beyond this.
const CONNECTORS: Partial<Record<IntegrationProvider, IntegrationConnector>> = {
  STRIPE: stripeConnector,
  PAYPAL: paypalConnector,
  GOOGLE_CALENDAR: googleCalendarConnector,
  QUICKBOOKS: quickbooksConnector,
  MAILCHIMP: mailchimpConnector,
  // Onboarding v2 — this is only the OAuth auth backbone; what it's used
  // FOR (fulfillment catalog browsing/pricing/ordering) goes through
  // lib/fulfillment/registry.ts instead, never through this file.
  PRINTFUL: printfulConnector,
  // Social Connections & Business Intelligence (2026-08-09).
  FACEBOOK: facebookConnector,
  INSTAGRAM: instagramConnector,
  TIKTOK: tiktokConnector,
  // Priority 2 (shipping, 2026-08-09) — real USPS rates/labels/tracking
  // via EasyPost. See lib/integrations/usps.ts's own comment for why the
  // provider is named USPS even though EasyPost is the real mechanism.
  // The provider enum still reads USPS; the connector is EasyPost. See
  // lib/integrations/easypost.ts for why the enum value was not churned.
  USPS: easypostConnector,
};

export function getConnector(provider: IntegrationProvider): IntegrationConnector {
  const connector = CONNECTORS[provider];
  if (!connector) {
    throw new Error(`No connector registered for provider "${provider}"`);
  }
  return connector;
}

export function getConnectorByName(provider: string): IntegrationConnector {
  const upper = provider.toUpperCase();
  if (!(upper in CONNECTORS)) {
    throw new Error(`Unknown integration provider "${provider}"`);
  }
  return getConnector(upper as IntegrationProvider);
}
