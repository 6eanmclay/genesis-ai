import type { Certainty, MapDomainView, MapNode } from "./businessMap";

// THE LAYER BETWEEN A DOMAIN AND A THING.
//
// ============ WHY THIS EXISTS (2026-09-01) ============================
//
// Sean: "J4 → Commerce → Products / Orders / Money / etc. Then the user can
// select one: Commerce → Products → individual products."
//
// The map had two levels — domains, then every node at once. Twenty-one
// products fanned off Commerce is a hairball, and it is also the wrong shape:
// an owner thinks "products" before they think about one product.
//
// ============ AND WHY IT IS DERIVED, NOT DECLARED =====================
//
// No new data. `MapNode.detail` already says what kind of thing each node is —
// the assembler writes "Product", "Customer", "Goal", "Asset" — so the middle
// layer is a grouping of what is already there. A new entity type gets a
// middle branch for free, and cannot be forgotten in a second list.
//
// A group of ONE is not a group. It would put an owner through an extra tap to
// reach a single thing, so a lone node is promoted to the middle layer itself.
//
// ============ PROSPECTS ARE HONEST, NOT DECORATIVE ====================
//
// Sean: "J4 → Social reveals Instagram · Facebook · TikTok · X" — even though
// none is connected, and "Do not pretend J4 knows information it doesn't
// have."
//
// A prospect is a branch for something that COULD inform this domain and does
// not yet. It carries `certainty: "unknown"` and says so. That is what lets an
// owner watch the map fill in: the same branch that reads "not known yet"
// today becomes a real one later, in place.

export interface MapBranch {
  id: string;
  label: string;
  certainty: Certainty;
  /** The line under the title on a card. */
  state: string;
  /** A sentence about what this is, or what it would add. */
  detail: string | null;
  /** Individual things under this branch. Empty for a leaf. */
  children: MapBranch[];
  /** Set when this branch stands for a connectable service. */
  serviceId: string | null;
  /** The row this stands for, when it is one thing rather than a group. */
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

function wordFor(certainty: Certainty): string {
  if (certainty === "known") return "from your data";
  if (certainty === "inferred") return "J4 worked this out";
  return "not known yet";
}

/**
 * The middle layer for one domain.
 *
 * PURE, so every rule above is provable by calling it — which is the only way
 * a rule like "a group of one is not a group" survives a redesign.
 */
export function branchesFor(
  domain: MapDomainView,
  prospects: MapProspect[] = [],
): MapBranch[] {
  const branches: MapBranch[] = [];

  // ---- prospects first: they are the invitation, and they are what grows ---
  for (const p of prospects) {
    branches.push({
      id: `prospect:${p.id}`,
      label: p.label,
      certainty: p.connected ? "known" : "unknown",
      state: p.connected
        ? "Connected"
        : p.available
          ? "Not connected"
          : "Genesis cannot connect this yet",
      detail: p.detail || null,
      // A prospect has no children until it is connected and reports something.
      // Inventing "Content → Engagement" for an unconnected account is exactly
      // the pretence this map refuses.
      children: [],
      serviceId: p.serviceId,
      recordId: null,
    });
  }

  // ---- then what is genuinely recorded, grouped by kind -------------------
  const groups = new Map<string, MapNode[]>();
  for (const node of domain.nodes) {
    const key = node.detail?.trim() || domain.label;
    const list = groups.get(key);
    if (list) list.push(node);
    else groups.set(key, [node]);
  }

  for (const [kind, nodes] of groups) {
    if (nodes.length === 1) {
      // A GROUP OF ONE IS NOT A GROUP.
      const only = nodes[0];
      branches.push({
        id: only.id,
        label: only.label,
        certainty: only.certainty,
        state: wordFor(only.certainty),
        detail: only.detail,
        children: [],
        serviceId: null,
        recordId: only.recordId,
      });
      continue;
    }
    branches.push({
      id: `group:${domain.key}:${kind}`,
      // Plain plural, from the kind the assembler already wrote.
      label: `${kind}s`,
      certainty: nodes.some((n) => n.certainty === "known")
        ? "known"
        : nodes.some((n) => n.certainty === "inferred")
          ? "inferred"
          : "unknown",
      state: `${nodes.length} recorded`,
      detail: null,
      children: nodes.map((n) => ({
        id: n.id,
        label: n.label,
        certainty: n.certainty,
        state: wordFor(n.certainty),
        detail: n.detail,
        children: [],
        serviceId: null,
        recordId: n.recordId,
      })),
      serviceId: null,
      recordId: null,
    });
  }

  return branches;
}
