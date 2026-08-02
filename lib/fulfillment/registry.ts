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
