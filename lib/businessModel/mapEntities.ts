import type { Certainty, MapDomainView, MapNode } from "./businessMap";

// WHAT IS ACTUALLY INSIDE A BRANCH.
//
// ============ THE MIDDLE LAYER IS GONE (2026-09-02) ====================
//
// This file used to export `branchesFor`, which grouped a domain's nodes by
// kind so an owner walked J4 -> Commerce -> Products -> one product.
//
// Sean: "I don't think we need the intermediate category level anymore...
// Once I enter a branch, I want to immediately see the actual things inside
// it."
//
// He is right, and the reason is worth keeping: the grouping level had no
// information on it. "Products · 21 recorded" is a fact about the list, not
// about the business, and an owner paid a tap for it. So the level is deleted
// rather than hidden, and what it cost is spent on the things themselves.
//
// ============ ORGANISED, STILL — JUST NOT NAVIGATED ===================
//
// The grouping is not thrown away, only demoted from a level to an ordering.
// Entities come out sorted by kind (in the order the assembler first mentions
// each kind), so products sit beside products in the carousel and the sense of
// "J4 has organised this" survives without a screen of its own. Each card
// carries its own kind, so the label the group used to provide is still there,
// on the thing it describes.
//
// ============ PROSPECTS ARE HONEST, NOT DECORATIVE ====================
//
// Unchanged from the branch version, because it was never about grouping. A
// prospect is something that COULD inform this domain and does not yet: it
// carries `certainty: "unknown"` and says so, which is what lets an owner
// watch the map fill in rather than wonder why a platform they use is absent.

export interface MapEntity {
  id: string;
  label: string;
  certainty: Certainty;
  /** The status line: "from your data", "Not connected", and so on. */
  state: string;
  /** A sentence about this thing, or what connecting it would add. */
  detail: string | null;
  /** What kind of thing it is — "Product", "Asset". Null when unclassified. */
  kind: string | null;
  /** A real picture of it, or null. Never a placeholder. */
  image: string | null;
  /** What J4 knows about it, read off fields that exist. */
  facts: { label: string; value: string }[];
  /** Set when this entity stands for a service Genesis knows about. */
  serviceId: string | null;

  /**
   * Whether an owner can genuinely connect this right now.
   *
   * A SEPARATE FIELD, NOT INFERRED FROM serviceId (2026-09-02). Having an id
   * in the catalogue is not the same as having a connector: several entries
   * carry `connector: null` and say so. A card that read "Genesis cannot
   * connect this yet" and then offered a Connect button would be exactly the
   * state mismatch Sean ruled out — "don't offer an action that doesn't make
   * sense for the current provider state."
   */
  connectable: boolean;
  /** The row behind it, for looking up what else is known about it. */
  recordId: string | null;
}

/** Something that could inform a domain but is not connected yet. */
export interface MapProspect {
  id: string;
  label: string;
  /** Whether Genesis could connect it at all. */
  available: boolean;
  connected: boolean;
  /** The provider's own words, or the platform's. Never written here. */
  detail: string;
  serviceId: string | null;
}

export function wordFor(certainty: Certainty): string {
  if (certainty === "known") return "from your data";
  if (certainty === "inferred") return "J4 worked this out";
  return "not known yet";
}

/**
 * Everything inside one domain, flat and in a considered order.
 *
 * PURE, so every rule above is provable by calling it — which is the only way
 * a rule like "kinds stay together" survives the next redesign.
 */
export function entitiesFor(
  domain: MapDomainView,
  prospects: MapProspect[] = [],
): MapEntity[] {
  const entities: MapEntity[] = [];

  // ---- prospects first: they are the invitation, and they are what grows ---
  for (const p of prospects) {
    entities.push({
      id: `prospect:${p.id}`,
      label: p.label,
      certainty: p.connected ? "known" : "unknown",
      // THE EXISTING CONNECTION LANGUAGE, WORD FOR WORD. Sean: "Keep the
      // existing connection/status language." These three strings are the same
      // ones the chooser shows, so a service reads identically in both places.
      state: p.connected
        ? "Connected — J4 uses this"
        : p.available
          ? "Not connected"
          : "Genesis cannot connect this yet",
      detail: p.detail || null,
      kind: "Connection",
      connectable: p.available && !p.connected,
      image: null,
      // A prospect has no facts until it is connected and reports something.
      // Inventing "Followers: —" for an unconnected account is exactly the
      // pretence this map refuses.
      facts: [],
      serviceId: p.serviceId,
      recordId: null,
    });
  }

  // ---- then what is genuinely recorded, kinds kept together ---------------
  const order: string[] = [];
  const byKind = new Map<string, MapNode[]>();
  for (const node of domain.nodes) {
    const key = node.kind?.trim() || domain.label;
    const list = byKind.get(key);
    if (list) list.push(node);
    else {
      byKind.set(key, [node]);
      order.push(key);
    }
  }

  for (const key of order) {
    for (const node of byKind.get(key)!) {
      entities.push({
        id: node.id,
        label: node.label,
        certainty: node.certainty,
        state: wordFor(node.certainty),
        // NOT THE KIND AGAIN. Seen in a screenshot (2026-09-02): a product
        // card read "PRODUCT" as its chip and then "Product" as its
        // description, because the assembler writes the same word into both
        // for records that have no sentence of their own. A line that repeats
        // the chip above it is not a description.
        detail: node.detail === node.kind ? null : node.detail,
        // A KIND ONLY WHERE THE ASSEMBLER GENUINELY SET ONE — never measured
        // off the detail sentence.
        kind: node.kind,
        image: node.image,
        facts: node.facts,
        serviceId: null,
        connectable: false,
        recordId: node.recordId,
      });
    }
  }

  return entities;
}
