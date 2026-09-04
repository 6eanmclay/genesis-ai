import type { BusinessMap, MapDomainKey } from "./businessMap";

// WHAT "FOCUS THIS" MEANS ON A MAP THAT SHOWS DOMAINS (2026-09-03).
//
// P2 gave J4 `focus.nodeIds` and nothing rendered them. Wiring that up turned
// out not to be "put a ring around a circle", and the reason is worth stating
// because it is not visible from the contract:
//
// BusinessMapCanvas draws the NINE DOMAINS as its ring. Individual entities
// only exist once a domain is opened, in the carousel. So focusing
// `product:<id>` is TWO STAGES - open that node's domain, then highlight it
// among the entities - and this is the pure part of that decision.
//
// PURE, AND THE MAP IS STILL THE AUTHORIZATION. Same rule as
// selectionContext.ts: an id that is not in this store's map is not found,
// whether it belongs to another store, to nothing, or to a typo. Nothing here
// parses an id for meaning or trusts its shape.
//
// PRESENTATION ONLY. This computes what to SHOW. It reads the map and returns
// ids; it writes nothing, persists nothing, and touches neither the map's data
// nor the understanding.

export interface FocusPlan {
  /**
   * The domain to open, or null when nothing valid was asked for.
   *
   * Taken from the FIRST valid node, because a comparison spanning domains has
   * to start somewhere and the order J4 named them in is the only signal there
   * is about which matters most.
   */
  domain: MapDomainKey | null;
  /**
   * Every valid node id to highlight, in the order requested.
   *
   * Ids outside the opened domain are kept rather than filtered: the carousel
   * only renders the open domain's entities, so they simply match nothing.
   * Dropping them here would mean this function and the carousel disagreed
   * about what was asked for.
   */
  nodeIds: string[];
}

/** How many things may be focused at once before it stops meaning anything. */
const MAX_FOCUSED = 5;

export function focusPlan(map: BusinessMap, requested: unknown): FocusPlan {
  if (!Array.isArray(requested)) return { domain: null, nodeIds: [] };

  const byId = new Map(map.nodes.map((node) => [node.id, node]));

  const nodeIds: string[] = [];
  let domain: MapDomainKey | null = null;
  const seen = new Set<string>();

  for (const raw of requested) {
    if (typeof raw !== "string") continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    const node = byId.get(raw);
    if (!node) continue;
    if (domain === null) domain = node.domain;
    nodeIds.push(node.id);
    if (nodeIds.length >= MAX_FOCUSED) break;
  }

  // Nothing valid asked for is no focus at all, and the surface is left
  // alone. There is deliberately no guard for it: `domain` is only ever
  // assigned beside a pushed id, so an empty result already carries a null
  // domain. A sabotage proved the guard that used to sit here could not
  // fail, which makes it decoration rather than protection.
  return { domain, nodeIds };
}
