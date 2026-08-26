import type { IntegrationProvider } from "@prisma/client";
import type { FulfillmentConnector } from "./types";
import { printfulFulfillmentConnector } from "./printful";

// Same "map of N, only a handful implemented" shape as
// lib/integrations/registry.ts, deliberately reused rather than invented
// fresh — adding a second fulfillment partner is one entry here, nothing
// else in lib/fulfillment/strategy.ts or the onboarding flow needs to
// change.
const FULFILLMENT_CONNECTORS: FulfillmentConnector[] = [printfulFulfillmentConnector];

export function getFulfillmentConnectors(): FulfillmentConnector[] {
  return FULFILLMENT_CONNECTORS;
}

/**
 * The connector a product came through, by the provider recorded on it.
 *
 * Read off the row rather than re-derived — the same correction adopt.ts
 * carries: `createsListings ? "PRINTFUL" : null` was right exactly until a
 * second print-on-demand partner existed.
 */
export function getFulfillmentConnector(
  provider: IntegrationProvider | null
): FulfillmentConnector | null {
  if (!provider) return null;
  return FULFILLMENT_CONNECTORS.find((connector) => connector.provider === provider) ?? null;
}
