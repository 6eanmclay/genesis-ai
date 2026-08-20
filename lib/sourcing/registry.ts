import type { ProductSource } from "./types";
import { printfulSource } from "./printful";
import { aliexpressSource } from "./aliexpress";

// Every source Genesis can find products through.
//
// The same "map of N, a handful implemented" shape as
// lib/integrations/registry.ts and lib/fulfillment/registry.ts, on purpose:
// adding a supplier is one entry here and one file implementing ./types.ts.
// Nothing in discovery, recommendation or adoption knows a supplier's name.
const SOURCES: ProductSource[] = [printfulSource, aliexpressSource];

export function getProductSources(): ProductSource[] {
  return SOURCES;
}

/** Sources with nothing outstanding. Everything else is named, not hidden. */
export function getReadySources(): ProductSource[] {
  return SOURCES.filter((source) => source.blockedOn.length === 0);
}

export function getProductSource(key: string): ProductSource | null {
  return SOURCES.find((source) => source.key === key) ?? null;
}

/**
 * What is stopping each unready source, for the operator-facing list.
 *
 * Exists so "why did discovery only search one supplier" is answerable without
 * reading code — the same reason lib/integrations/catalog.ts names what a
 * connector is waiting on rather than quietly omitting it.
 */
export function describeBlockedSources(): { key: string; displayName: string; blockedOn: string[] }[] {
  return SOURCES.filter((s) => s.blockedOn.length > 0).map((s) => ({
    key: s.key,
    displayName: s.displayName,
    blockedOn: s.blockedOn,
  }));
}
