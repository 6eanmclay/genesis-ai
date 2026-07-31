import type { IntegrationProvider } from "@prisma/client";
import type { IntegrationConnector } from "./types";
import { stripeConnector } from "./stripe";
import { paypalConnector } from "./paypal";
import { googleCalendarConnector } from "./googleCalendar";
import { quickbooksConnector } from "./quickbooks";
import { mailchimpConnector } from "./mailchimp";

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
