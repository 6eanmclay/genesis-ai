import type { BusinessUnderstanding } from "./understanding";
import type { OwnerFactsWithProvenance } from "./ownerFacts";
import type { RecordProvenance } from "@prisma/client";

// WHAT J4 UNDERSTANDS ABOUT A BUSINESS, AS SOMETHING YOU CAN LOOK AT.
//
// ============ WHY THIS IS A READ AND NOT A TABLE (2026-09-01) ==========
//
// Every node and edge below is either a row that already exists or a foreign
// key that already joins two of them. `getBusinessProfile()` computes Genesis's
// own orders and products into the canonical shape on every read, so a stored
// map would be a cached copy of live data — the mirror-that-drifts failure this
// codebase keeps finding, except the thing that would drift is an owner's
// picture of their own business.
//
// Sean: "Do not persist the derived map." Nothing here writes.
//
// ============ THE THREE STATES, WHICH ARE THE POINT ===================
//
//   known        supported by actual business data — a row somebody created,
//                or arithmetic over the store's own orders
//   inferred     J4 concluded it. Real knowledge, and never silently promoted
//                into the first category
//   unknown      nothing recorded yet. A VALUE this assembler emits, not an
//                absence the UI renders by accident
//
// Sean: "This distinction is one of the core reasons we're building the map, so
// don't flatten those states for visual simplicity."
//
// The third one is the one a visualisation naturally destroys: a domain with no
// rows draws as nothing, and nothing looks identical to a domain that was never
// asked about. So `unknown` is explicit, carries its own sentence, and every
// domain is always present in the output.
//
// ============ AND EDGES ARE REAL RELATIONSHIPS ========================
//
// Sean: "relationships are real relationships, not decorative lines. Only draw
// an edge when the underlying data/model supports it."
//
// So `Product → Order → Revenue` is drawn: OrderItem.productId is a real
// column, and revenue is arithmetic over real orders. `TikTok → Content →
// Engagement → Traffic` is NOT drawn at any strength, because there is no
// social connector, no content entity and no traffic attribution anywhere in
// the schema. Those stay unavailable until the entities exist.

/** How well Genesis actually knows a thing. Never collapsed for presentation. */
export type Certainty = "known" | "inferred" | "unknown";

/** Which part of the business a node belongs to. */
export const MAP_DOMAINS = [
  "business",
  "commerce",
  "customers",
  "financials",
  "goals",
  "social",
  "connections",
  "creation",
  "learned",
] as const;
export type MapDomainKey = (typeof MAP_DOMAINS)[number];

export const DOMAIN_LABEL: Record<MapDomainKey, string> = {
  business: "Business",
  commerce: "Commerce",
  customers: "Customers",
  financials: "Financials",
  goals: "Goals",
  social: "Social",
  connections: "Connections",
  creation: "Creation",
  learned: "Learned",
};

/**
 * The relationships the map is allowed to draw, and the data that backs each.
 *
 * Every entry names the column or computation it rests on. An edge kind with
 * no such backing does not belong here — which is the check that keeps a
 * decorative line out of a picture an owner will make decisions from.
 */
export const MAP_EDGE_KINDS = {
  contains: "a domain and what is in it",
  ordered: "OrderItem.productId — this product was bought in this order",
  paid_by: "Order.buyerEmail — this customer placed this order",
  earned: "arithmetic over real orders — what those orders came to",
  fulfilled_by: "Product.fulfillmentProvider — who makes and ships it",
  derived_from: "Product.richContent.designId — the design this came from",
  describes: "a stated or inferred fact about the business itself",
} as const;
export type MapEdgeKind = keyof typeof MAP_EDGE_KINDS;

export interface MapNode {
  /** Stable within one map. `domain:commerce`, `product:<id>`. */
  id: string;
  domain: MapDomainKey;
  label: string;
  certainty: Certainty;
  /** A short honest line. For an unknown node, what is missing. */
  detail: string | null;
  /** Where the underlying fact came from, when it is a fact with a provenance. */
  provenance: RecordProvenance | null;
  /** The row this stands for, so nothing is drawn without something behind it. */
  recordId: string | null;
  /**
   * WHAT KIND OF THING THAT ID NAMES (2026-09-01).
   *
   * Found by the suite, which asserted every recordId resolved to a
   * BusinessRecord and two of them did not. Genesis's own products and
   * customers are not rows in that table — `internalMapper.ts` computes them
   * live into the canonical shape with ids like `internal:item:<productId>`,
   * and `statements.ts` already special-cases the prefix when resolving one.
   *
   * The map was quietly claiming a persisted record behind a computed one. It
   * still traces — a computed id resolves against Product or Order through
   * `recordExistsInStore` — but a reader must be able to tell which question to
   * ask, and "nothing is drawn without something behind it" is only checkable
   * if the kind of "something" is stated.
   */
  recordKind: "business_record" | "belief" | "computed" | null;
}

export interface MapEdge {
  from: string;
  to: string;
  kind: MapEdgeKind;
  /** The column or computation this edge rests on. Never decorative. */
  because: string;
}

export interface MapDomainView {
  key: MapDomainKey;
  label: string;
  /** `unknown` when the domain holds nothing yet. Always present regardless. */
  certainty: Certainty;
  /** What this domain currently amounts to, in a sentence an owner can read. */
  summary: string;
  nodes: MapNode[];
}

export interface BusinessMap {
  business: { name: string; slug: string | null };
  domains: MapDomainView[];
  edges: MapEdge[];
  /** Every node, flattened, for a renderer that wants one pass. */
  nodes: MapNode[];
  asOf: string;
}

/** Facts a domain can be built from, beyond the understanding object itself. */
export interface BusinessMapInput {
  understanding: BusinessUnderstanding;
  /** The six singleton facts WITH their origins. The whole point of Phase 2. */
  facts: OwnerFactsWithProvenance;
  slug?: string | null;
  /** Designs, which the profile does not carry. Absent is a real answer. */
  designCount?: number;
}

/**
 * Provenance decides certainty, and only these two answers exist.
 *
 * OWNER, CONNECTOR and DOCUMENT are all "somebody outside this system asserted
 * it" — the owner said so, a connected account reported it, a real document
 * stated it. DERIVED is arithmetic over the store's own rows, which is equally
 * not a guess.
 *
 * INFERENCE and GENERATED are J4's own conclusions. Legitimate knowledge, and
 * labelled as its own thing every time it is shown.
 *
 * A null provenance is INFERRED, not known. Rows written before the column
 * existed cannot prove where they came from, and the safe direction for an
 * unproven origin is the weaker claim.
 */
export function certaintyOf(provenance: RecordProvenance | null): Certainty {
  switch (provenance) {
    case "OWNER":
    case "CONNECTOR":
    case "DOCUMENT":
    case "DERIVED":
      return "known";
    case "INFERENCE":
    case "GENERATED":
      return "inferred";
    default:
      return "inferred";
  }
}

/** A domain is only as certain as its best node, and empty means unknown. */
function domainCertainty(nodes: MapNode[]): Certainty {
  if (nodes.length === 0) return "unknown";
  if (nodes.some((n) => n.certainty === "known")) return "known";
  if (nodes.some((n) => n.certainty === "inferred")) return "inferred";
  return "unknown";
}

function node(
  domain: MapDomainKey,
  id: string,
  label: string,
  certainty: Certainty,
  extra: Partial<Pick<MapNode, "detail" | "provenance" | "recordId" | "recordKind">> = {}
): MapNode {
  const recordId = extra.recordId ?? null;
  return {
    id: `${domain}:${id}`,
    domain,
    label,
    certainty,
    detail: extra.detail ?? null,
    provenance: extra.provenance ?? null,
    recordId,
    recordKind: extra.recordKind ?? (recordId ? kindOfId(recordId) : null),
  };
}

/** Which table an id can be resolved against. The prefix is the existing convention. */
function kindOfId(recordId: string): "business_record" | "computed" {
  return recordId.startsWith("internal:") ? "computed" : "business_record";
}

/** A fact node whose certainty comes from its own provenance. */
function factNode(
  domain: MapDomainKey,
  id: string,
  label: string,
  fact: { statement: string; provenance: RecordProvenance | null; recordId: string } | null
): MapNode | null {
  if (!fact) return null;
  return node(domain, id, label, certaintyOf(fact.provenance), {
    detail: fact.statement,
    provenance: fact.provenance,
    recordId: fact.recordId,
  });
}

/**
 * Assemble the map. Reads nothing itself — every input is already-assembled
 * understanding, so this stays a pure function a suite can hand fixtures to.
 */
export function businessMap(input: BusinessMapInput): BusinessMap {
  const { understanding: u, facts } = input;
  const p = u.profile;
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const add = (n: MapNode | null) => {
    if (n) nodes.push(n);
  };

  // ---- Business: what it says it is, and what J4 has concluded about it ----
  //
  // name/tagline/description are the owner's own columns, set through the
  // identity form — known, with no provenance row behind them because they are
  // not facts in the lifecycle sense.
  add(node("business", "name", p.identity.name, "known", { detail: "Business name" }));
  if (p.identity.tagline) {
    add(node("business", "tagline", p.identity.tagline, "known", { detail: "Tagline" }));
  }
  if (p.identity.description) {
    add(node("business", "description", "Description", "known", { detail: p.identity.description }));
  }
  // The six singleton facts, each wearing its own origin. In production today
  // every one of the four brand claims is INFERENCE, so these render as J4's
  // conclusions rather than as things the owner said — which is exactly the
  // distinction that was being lost before this milestone.
  add(factNode("business", "offering", "What it sells", facts.offering));
  add(factNode("business", "intent", "What it is for", facts.intent));
  for (const category of p.classification.businessCategories) {
    add(node("business", `category:${category.slug}`, category.label, "known", {
      detail: "Business category",
    }));
  }
  for (const location of p.locations) {
    add(node("business", `location:${location.id}`, labelOf(location), certaintyOf(location.provenance), {
      detail: "Location",
      provenance: location.provenance,
      recordId: location.id,
    }));
  }
  if (p.people.owner) {
    add(node("business", "owner", p.people.owner.name ?? p.people.owner.email, "known", {
      detail: "Owner",
    }));
  }
  for (const member of p.people.members) {
    add(node("business", `member:${member.email}`, member.name ?? member.email, "known", {
      detail: member.role,
    }));
  }

  // ---- Commerce ----
  for (const item of p.offerings.items) {
    add(node("commerce", `item:${item.id}`, labelOf(item), certaintyOf(item.provenance), {
      detail: "Product",
      provenance: item.provenance,
      recordId: item.id,
    }));
  }

  // ---- Customers ----
  for (const top of p.customers.topContacts) {
    const contact = top.contact;
    add(node("customers", `contact:${contact.id}`, labelOf(contact), certaintyOf(contact.provenance), {
      detail: "Customer",
      provenance: contact.provenance,
      recordId: contact.id,
    }));
  }

  // ---- Financials ----
  //
  // DERIVED by definition — arithmetic over the store's own orders. Recorded as
  // `known` for that reason and not because anybody asserted a total.
  const orderCount = u.recentBusiness.orders.allTimeOrderCount;
  if (p.revenue.allTimeInCents > 0 || orderCount > 0) {
    add(node("financials", "revenue", "Revenue", "known", {
      detail: `${p.revenue.allTimeInCents} cents, all time`,
    }));
    add(node("financials", "orders", "Orders", "known", {
      detail: `${orderCount} recorded`,
    }));
  }

  // ---- Goals ----
  for (const goal of p.goals) {
    add(node("goals", `goal:${goal.id}`, labelOf(goal), certaintyOf(goal.provenance), {
      detail: "Goal",
      provenance: goal.provenance,
      recordId: goal.id,
    }));
  }
  for (const challenge of p.challenges) {
    add(node("goals", `challenge:${challenge.id}`, labelOf(challenge), certaintyOf(challenge.provenance), {
      detail: "Challenge",
      provenance: challenge.provenance,
      recordId: challenge.id,
    }));
  }

  // ---- Social ----
  for (const account of p.socialAccounts) {
    add(node("social", `social:${account.id}`, labelOf(account), certaintyOf(account.provenance), {
      detail: "Social account",
      provenance: account.provenance,
      recordId: account.id,
    }));
  }

  // ---- Connections ----
  for (const system of p.connectedSystems) {
    add(node("connections", `system:${system.provider}`, system.provider, "known", {
      detail: system.isStale ? "Connected, not syncing" : "Connected",
    }));
  }

  // ---- Creation ----
  for (const asset of p.assets) {
    add(node("creation", `asset:${asset.id}`, labelOf(asset), certaintyOf(asset.provenance), {
      detail: "Asset",
      provenance: asset.provenance,
      recordId: asset.id,
    }));
  }
  if (input.designCount && input.designCount > 0) {
    add(node("creation", "designs", "Designs", "known", {
      detail: `${input.designCount} saved`,
    }));
  }

  // ---- Learned: what J4 worked out on its own ----
  for (const belief of u.beliefs) {
    // ALWAYS `inferred`, whatever else is true of it. A belief is something J4
    // worked out from repeated evidence — never something somebody asserted —
    // and a well-established one is still J4's conclusion.
    add(node("learned", `belief:${belief.id}`, belief.claim, "inferred", {
      detail: belief.maturity,
      recordId: belief.id,
      recordKind: "belief",
    }));
  }

  // ---- the edges, each backed by a real column -------------------------
  //
  // Only drawn where BOTH ends are present in this map. An edge to a node that
  // was never added would be a line to nothing, which is the decorative case.
  const present = new Set(nodes.map((n) => n.id));
  const link = (from: string, to: string, kind: MapEdgeKind) => {
    if (present.has(from) && present.has(to)) {
      edges.push({ from, to, kind, because: MAP_EDGE_KINDS[kind] });
    }
  };
  if (present.has("financials:orders") && present.has("financials:revenue")) {
    link("financials:orders", "financials:revenue", "earned");
  }
  for (const item of p.offerings.items) {
    // Product → Order exists as a column; the individual orders are not nodes
    // in this first map, so the honest edge is product to the orders node.
    link(`commerce:item:${item.id}`, "financials:orders", "ordered");
  }
  for (const top of p.customers.topContacts) {
    link(`customers:contact:${top.contact.id}`, "financials:orders", "paid_by");
  }

  const domains: MapDomainView[] = MAP_DOMAINS.map((key) => {
    const own = nodes.filter((n) => n.domain === key);
    return {
      key,
      label: DOMAIN_LABEL[key],
      certainty: domainCertainty(own),
      summary: summarise(key, own),
      nodes: own,
    };
  });

  return {
    business: { name: p.identity.name, slug: input.slug ?? null },
    domains,
    edges,
    nodes,
    asOf: u.asOf,
  };
}

/**
 * What a domain currently amounts to.
 *
 * The empty sentence is the important one. "Nothing yet" would be a shrug;
 * naming what would fill it is the difference between a gap an owner can act
 * on and a blank they read as a bug.
 */
function summarise(key: MapDomainKey, nodes: MapNode[]): string {
  if (nodes.length > 0) {
    const inferred = nodes.filter((n) => n.certainty === "inferred").length;
    const known = nodes.length - inferred;
    const parts: string[] = [];
    if (known > 0) parts.push(`${known} known`);
    if (inferred > 0) parts.push(`${inferred} J4 worked out`);
    return parts.join(", ");
  }
  return EMPTY_SUMMARY[key];
}

/** Said in the owner's terms: what is missing, not that a query returned zero. */
const EMPTY_SUMMARY: Record<MapDomainKey, string> = {
  business: "Nothing recorded about the business itself yet.",
  commerce: "Nothing listed for sale yet.",
  customers: "Nobody has bought anything yet.",
  financials: "No money has moved yet.",
  goals: "You have not told J4 what you are working towards.",
  social: "No social account is connected, so J4 knows nothing about your reach.",
  connections: "Nothing is connected yet.",
  creation: "Nothing has been designed or uploaded yet.",
  learned: "J4 has not worked anything out on its own yet. This fills as it watches.",
};

/** A record's own best label, without inventing one. */
function labelOf(record: { id: string; data: Record<string, unknown> }): string {
  const data = record.data;
  for (const key of ["name", "title", "statement", "label", "summary", "provider", "handle"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  // No invented name. The id is at least true.
  return record.id;
}
