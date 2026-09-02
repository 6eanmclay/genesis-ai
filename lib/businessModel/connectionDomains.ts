import { CONNECTOR_CATALOG, type ConnectionCategory } from "@/lib/integrations/catalog";
import type { MapDomainKey } from "./businessMap";

// WHAT CONNECTING A SERVICE WOULD ADD TO J4'S UNDERSTANDING.
//
// ============ THE QUESTION THIS ANSWERS (2026-09-01) ===================
//
// Sean: "The user shouldn't have to wonder 'Why would I connect this?' The
// Business Map should visually explain the relationship: Connect Instagram ->
// J4 can understand your Social business data."
//
// So a connection is never presented as "Instagram is connected". It is
// presented as which BRANCH OF THE MAP it feeds — which is a structural fact
// about where its data would land, not a claim about what the provider can do.
//
// ============ AND THAT DISTINCTION IS THE WHOLE CARE OF THIS FILE ======
//
// Sean, in the same message: "don't invent capabilities for providers we
// haven't connected yet."
//
// Nothing here says what Instagram would report, how often, or how far back.
// Genesis does not know that for any provider it has not connected, and a
// sentence promising it would be exactly the fabrication the map exists to
// avoid. What it says is: this is a social service, so its data belongs on the
// Social branch. That is true before a single call is made.
//
// The catalogue's own `connector: null` already means "coming soon", and it is
// carried through verbatim rather than reinterpreted — a service Genesis cannot
// connect yet must not look connectable.

/**
 * Which branch of the map a category of service feeds.
 *
 * A MIRROR of `ConnectionCategory`, and cross-checked at runtime by
 * scripts/verify-business-map-db.ts — ARCHITECTURE.md's standing rule. A
 * category with no entry here would render a connection that explains nothing,
 * which is the one thing this file exists to prevent.
 */
export const CATEGORY_DOMAIN: Record<ConnectionCategory, MapDomainKey> = {
  social_media: "social",
  finance_accounting: "financials",
  customers_crm: "customers",
  marketing: "customers",
  communication: "customers",
  business_systems: "commerce",
  developer_api: "connections",
};

export interface ConnectableService {
  id: string;
  name: string;
  /** The branch this would feed. */
  domain: MapDomainKey;
  /**
   * Whether Genesis can connect it at all today.
   *
   * Straight from the catalogue's `connector: null`. Not a judgement made here.
   */
  available: boolean;
  /** True when THIS business has already connected it. */
  connected: boolean;
}

/**
 * The services the map can offer, and what each would add.
 *
 * DERIVED FROM THE CATALOGUE, never a second list. A list written here would
 * drift from the connectors that actually exist, and the first symptom would be
 * offering a merchant something Genesis cannot do.
 */
export function connectableServices(connectedProviders: string[]): ConnectableService[] {
  const connected = new Set(connectedProviders);
  return CONNECTOR_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    domain: CATEGORY_DOMAIN[entry.category],
    available: entry.connector !== null,
    connected: entry.provider !== null && connected.has(entry.provider),
  }));
}

/**
 * One sentence saying what a connection adds, in the owner's terms.
 *
 * Names the branch and nothing else. No frequency, no history depth, no list of
 * fields — none of which Genesis knows for a provider it has not connected.
 */
export function whatItAdds(service: ConnectableService, domainLabel: string): string {
  return service.connected
    ? `Connected. Feeds what J4 knows about ${domainLabel}.`
    : `Would let J4 understand your ${domainLabel}.`;
}
