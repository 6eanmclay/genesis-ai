import type { BusinessUnderstanding } from "./understanding";
import type { OwnerFactsWithProvenance } from "./ownerFacts";
import type { RecordProvenance } from "@prisma/client";
import { formatMoney } from "@/lib/money";

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
// column, and revenue is arithmetic over real orders.
//
// ============ CORRECTED 2026-09-17 ====================================
//
// This paragraph used to say `TikTok → Content → Engagement → Traffic` is not
// drawn "because there is no social connector, no content entity and no
// traffic attribution anywhere in the schema". Two of those three are still
// true. **The third stopped being true on 2026-09-01**, when 759459b shipped
// `StoreVisit` and froze attribution onto `Order` — and the sentence went on
// justifying an absent node for sixteen days.
//
// So TRAFFIC IS NOW DRAWN, and only the part the data actually establishes:
// a referring host, a landing path, and an order that carries the attribution
// frozen at purchase. `TikTok → Content → Engagement` remains undrawn, because
// a connector and a content entity still do not exist.
//
// The distinction this preserves is the one that made it its own domain rather
// than part of `social`: Genesis knows a visitor arrived from facebook.com
// because Genesis served the page, not because anybody connected Facebook.

/**
 * The three attribution kinds, in the owner's words.
 *
 * `direct_unknown` is deliberately not called "Direct" alone. A visitor with no
 * Referer header might have typed the address, followed a bookmark, or come
 * from an app that strips it — the recorder cannot tell, and the label must not
 * claim it can. classify.ts names the kind that way for the same reason.
 */
const ATTRIBUTION_KIND_MAP_LABEL: Record<string, string> = {
  explicit_tracking: "From a tracked link",
  observed_referral: "Referred by another site",
  direct_unknown: "Direct or unknown",
};

const ATTRIBUTION_KIND_MAP_DETAIL: Record<string, string> = {
  explicit_tracking: "The link itself named where it came from.",
  observed_referral: "Another site sent them, and the browser said which.",
  direct_unknown:
    "No referrer was sent. Typed, bookmarked, or from an app that strips it — Genesis cannot tell which, and does not guess.",
};

/** How well Genesis actually knows a thing. Never collapsed for presentation. */
export type Certainty = "known" | "inferred" | "unknown";

/** Which part of the business a node belongs to. */
export const MAP_DOMAINS = [
  "business",
  "commerce",
  "customers",
  "financials",
  "goals",
  // TRAFFIC IS NOT SOCIAL, AND THE SEPARATION IS THE POINT (2026-09-17).
  //
  // `social` is what a CONNECTED provider tells us — reach, followers,
  // engagement — and it is empty until an account is connected. `traffic` is
  // what OUR OWN storefront observed, and it needs no provider at all: Genesis
  // serves the page, so the arrival is ours to see. Folding the two together
  // would make an owner think their Facebook account is why J4 can see
  // facebook.com referrals, which is exactly backwards.
  "traffic",
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
  // NAMED FOR WHERE IT COMES FROM. "Traffic" alone would sit next to "Social"
  // reading like another connected feed; this says whose telemetry it is, which
  // is the distinction Sean asked to be visible in the presentation itself.
  //
  // ============ AND IT HAS TO SURVIVE BEING DRAWN (2026-09-17) =========
  //
  // This read "Traffic (your own site)" for a day. The map truncates a branch
  // label at 15 characters, so what an owner actually saw on the one branch
  // this milestone existed to expose was "Traffic (your…" — which carries
  // neither the word nor the distinction, and reads as something broken.
  // The intent was right and the drawing defeated it.
  //
  // "Your traffic" is 12 and fits. The possessive is doing the same work the
  // parenthetical was: beside "Social", which is someone else's platform, this
  // one is the owner's own. Every branch label must fit, and the map suite
  // asserts that none of them is drawn truncated.
  traffic: "Your traffic",
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
  // ============ TWO NEW KINDS, EACH NAMING ITS OWN COLUMN =============
  //
  // The rule above is that an edge kind must name the column or computation it
  // rests on. Both of these do, and both rest on our own telemetry rather than
  // on any provider.
  landed_on: "StoreVisit.landingPath — the page this traffic actually arrived on",
  // NOT "this source produced this revenue". The attribution is frozen onto
  // the order at purchase from the visit that preceded it, and 10 of 17
  // production orders carry it; the other 7 have none and get no edge rather
  // than a guessed one.
  attributed_to: "Order.attributionKind/Source, frozen at purchase from StoreVisit",
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

  /**
   * A picture of this thing, when one genuinely exists.
   *
   * Assets carry `storageUrl`. Products do not — the canonical item shape has
   * no image field, and their photograph lives on the Product row — so the
   * presentation layer resolves those separately rather than this inventing
   * one. Null means there is no picture, never a placeholder.
   */
  image: string | null;

  /**
   * WHAT CLASS OF THING THIS IS — "Product", "Asset", "Customer".
   *
   * Separate from `detail` because the two stopped being the same thing when
   * cards became information-rich (2026-09-02): an asset's detail is now J4's
   * own one-line reading of the file, which is a sentence, not a category. The
   * carousel keeps kinds together and prints the kind on each card, and neither
   * job can be done by measuring a sentence.
   *
   * Null for a genuine one-off — the business description, all-time revenue —
   * where there is no class, only the thing.
   */
  kind: string | null;

  /**
   * WHAT J4 KNOWS ABOUT THIS THING, as label/value pairs (2026-09-02).
   *
   * Sean: "The Business Map shouldn't just tell me that something exists. It
   * should be a place where I can actually understand what J4 knows about that
   * thing... what it is, where it came from, what J4 inferred about it, how
   * confident J4 is, what business entity it relates to."
   *
   * Every pair is read off a field that exists on the record. Nothing is
   * computed for display, nothing is filled in when absent — an asset with no
   * summary contributes no summary line rather than an empty one, because a
   * blank row implies J4 looked and found nothing when it never looked.
   */
  facts: { label: string; value: string }[];
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

  /**
   * Product photographs, keyed by product id.
   *
   * PASSED IN RATHER THAN LOOKED UP, because this assembler does no IO and is
   * not going to start. The canonical item shape has no image field — a
   * product's photograph lives on its own Product row — so the caller reads
   * them and hands them over. Absent means the product has no photograph, and
   * the card then shows none rather than a stand-in.
   */
  productImages?: Record<string, string>;
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
  extra: Partial<Pick<MapNode, "detail" | "provenance" | "recordId" | "recordKind" | "image" | "facts" | "kind">> = {}
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
    image: extra.image ?? null,
    kind: extra.kind ?? null,
    facts: extra.facts ?? [],
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
      kind: "Person",
    }));
  }
  for (const member of p.people.members) {
    add(node("business", `member:${member.email}`, member.name ?? member.email, "known", {
      detail: member.role,
      kind: "Person",
    }));
  }

  // ---- Commerce ----
  for (const item of p.offerings.items) {
    const data = item.data as Record<string, unknown>;
    const productId = item.id.replace("internal:item:", "");
    // A PRICE WITH NO CURRENCY IS NOT A PRICE. This rendered a bare "25.00"
    // on the card an owner opens to see what J4 knows about a product.
    // No currency means no store row, so the fact is omitted rather than
    // shown with a symbol nobody chose.
    const price = typeof data.priceInCents === "number" && u.currency !== null
      ? formatMoney(data.priceInCents, u.currency)
      : null;
    add(node("commerce", `item:${item.id}`, labelOf(item), certaintyOf(item.provenance), {
      detail: "Product",
      kind: "Product",
      provenance: item.provenance,
      recordId: item.id,
      // The canonical item shape has no image field, so the photograph comes
      // from the caller keyed by the underlying product id — never invented.
      image: input.productImages?.[productId] ?? null,
      facts: knownOf([
        ["Price", price],
        // A DATABASE ID IS NOT A STOCK CODE (2026-09-02, seen in a screenshot).
        //
        // A Genesis-native product has no SKU, so internalMapper fills the
        // canonical field with `product.id` to satisfy the shape. Printing
        // that under the heading "SKU" tells an owner they have a stock code
        // they never set — a cuid presented as their own commercial data. So
        // the row appears only when the value is genuinely something other
        // than the record's own identifier.
        ["SKU", data.sku === productId ? null : data.sku],
        ["Category", data.category],
        ["On sale in your storefront", data.active === true ? "Yes" : data.active === false ? "No" : null],
        ["In stock", data.quantityAvailable],
      ]),
    }));
  }

  // ---- Customers ----
  for (const top of p.customers.topContacts) {
    const contact = top.contact;
    // DELIBERATELY THIN. Sean: "Same for customers, except obviously the
    // presentation should be appropriate for customer information and
    // privacy." What they have spent with this business is the owner's own
    // commercial record; the rest of what Genesis holds about a person does
    // not belong on a card that sits open on a landing screen.
    add(node("customers", `contact:${contact.id}`, customerLabelOf(contact), certaintyOf(contact.provenance), {
      detail: "Customer",
      kind: "Customer",
      provenance: contact.provenance,
      recordId: contact.id,
      facts: knownOf([
        // Same rule: what a customer spent is money, and it was reaching the
      // card as an unlabelled figure.
      [
        "Spent with you",
        top.totalSpentInCents && u.currency !== null
          ? formatMoney(top.totalSpentInCents, u.currency)
          : null,
      ],
      ]),
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
      kind: "Goal",
      provenance: goal.provenance,
      recordId: goal.id,
    }));
  }
  for (const challenge of p.challenges) {
    add(node("goals", `challenge:${challenge.id}`, labelOf(challenge), certaintyOf(challenge.provenance), {
      detail: "Challenge",
      kind: "Challenge",
      provenance: challenge.provenance,
      recordId: challenge.id,
    }));
  }

  // ---- Traffic: what our own storefront observed ----
  //
  // ============ EVERY NODE HERE IS A COUNTED ROW ======================
  //
  // No node is drawn from an assumption. A host appears because StoreVisit
  // recorded that host; a landing path appears because a visit landed there;
  // an attributed-orders node appears because Order carries attribution frozen
  // at purchase. There is no modelling, no ratio and no ranking.
  //
  // FOUR RULES INHERITED FROM lib/dashboard/visitorSources.ts rather than
  // re-decided here, because they were settled against production data:
  //
  //   direct_unknown is shown, and leads when it dominates — it is 62% of
  //     production traffic, and a map that showed only the nameable third
  //     would be the more flattering picture and the false one;
  //   a host is the host it is — m.facebook.com is its own node, never folded
  //     into facebook.com;
  //   orders are counted by attributionKind, never by attributionSource,
  //     because a direct-attributed order has no source by design;
  //   StoreVisit is the source of truth, never the StoreTrafficDay rollup,
  //     which is empty and correctly so.
  //
  // CERTAINTY IS "known" THROUGHOUT. These are counts of rows we wrote when
  // the request arrived — not inferences — and `direct_unknown` is a KNOWN
  // fact about what the browser sent, not an uncertain one. The uncertainty is
  // in the world, and the evidence column says so in the node's own detail.
  {
    const t = u.traffic;
    if (t.totalVisits > 0) {
      add(node("traffic", "traffic:visits", `${t.totalVisits} visit${t.totalVisits === 1 ? "" : "s"}`, "known", {
        detail:
          t.firstSeenAt && t.lastSeenAt
            ? `Recorded by your own storefront between ${t.firstSeenAt.toLocaleDateString()} and ${t.lastSeenAt.toLocaleDateString()}. No connected account involved.`
            : "Recorded by your own storefront. No connected account involved.",
        kind: "Storefront visits",
      }));

      // HOW THEY WERE ATTRIBUTED, including the unattributable ones.
      for (const row of t.byKind) {
        add(node("traffic", `traffic:kind:${row.kind}`, `${ATTRIBUTION_KIND_MAP_LABEL[row.kind]} — ${row.visits}`, "known", {
          detail: ATTRIBUTION_KIND_MAP_DETAIL[row.kind],
          kind: "How the visit was attributed",
        }));
      }

      // THE HOSTS THEMSELVES, exactly as observed.
      for (const row of t.sources) {
        add(node("traffic", `traffic:source:${row.source}`, `${row.source} — ${row.visits}`, "known", {
          detail: "A referring host your storefront actually saw. Recorded as sent, never grouped with a similar one.",
          kind: "Referring host",
        }));
      }

      // WHERE THEY LANDED — captured since 759459b and surfaced for the first
      // time here and in the marketing read.
      for (const row of t.landingPaths) {
        add(node("traffic", `traffic:landing:${row.path}`, `${row.path} — ${row.visits}`, "known", {
          detail: "Where arrivals actually landed. Path only; a landing URL would carry somebody else's query string.",
          kind: "Landing page",
        }));
      }

      // AND WHAT CAME OF IT, only where an order genuinely carries attribution.
      if (t.attributedOrders > 0) {
        add(node("traffic", "traffic:attributed-orders", `${t.attributedOrders} order${t.attributedOrders === 1 ? "" : "s"} traced to a visit`, "known", {
          detail: `Of ${t.totalOrders} order${t.totalOrders === 1 ? "" : "s"}. The rest carry no attribution and are not guessed at.`,
          kind: "Attributed orders",
        }));
      }
    }
  }

  // ---- Social ----
  for (const account of p.socialAccounts) {
    add(node("social", `social:${account.id}`, labelOf(account), certaintyOf(account.provenance), {
      detail: "Social account",
      kind: "Social account",
      provenance: account.provenance,
      recordId: account.id,
    }));
  }

  // ---- Connections ----
  for (const system of p.connectedSystems) {
    add(node("connections", `system:${system.provider}`, system.provider, "known", {
      detail: system.isStale ? "Connected, not syncing" : "Connected",
      kind: "Connected system",
    }));
  }

  // ---- Creation ----
  for (const asset of p.assets) {
    // EVERY FIELD HERE EXISTS ON AssetSchema. summary is J4's own reading of
    // the file, extractionConfidence is how sure it was, relatedEntityType is
    // what it hangs off, origin is where it came from. Nothing is inferred at
    // this layer — it is carried.
    const data = asset.data as Record<string, unknown>;
    const confidence = typeof data.extractionConfidence === "number"
      ? `${Math.round(data.extractionConfidence * 100)}%`
      : null;
    add(node("creation", `asset:${asset.id}`, labelOf(asset), certaintyOf(asset.provenance), {
      detail: typeof data.summary === "string" && data.summary.trim() ? data.summary : null,
      kind: "Asset",
      provenance: asset.provenance,
      recordId: asset.id,
      image: typeof data.storageUrl === "string" && data.fileType === "photo" ? data.storageUrl : null,
      facts: knownOf([
        ["What it is", data.category],
        ["File", data.fileType],
        ["Where it came from", data.origin],
        ["Role", data.role],
        ["J4's confidence reading it", confidence],
        ["Relates to", data.relatedEntityType],
      ]),
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
      kind: "What J4 has learned",
      recordId: belief.id,
      recordKind: "belief",
      facts: knownOf([
        ["How sure J4 is", `${Math.round(belief.confidence * 100)}%`],
        ["Times it has held up", belief.evidenceCount],
        ["Maturity", belief.maturity],
      ]),
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
  // DELIBERATELY NOT "connect an account". Nothing needs connecting for this —
  // it fills the first time somebody visits the storefront, and saying
  // otherwise would teach the owner the opposite of how it works.
  traffic: "Nobody has visited your storefront yet. This fills on its own — no account to connect.",
  social: "No social account is connected, so J4 knows nothing about your reach.",
  connections: "Nothing is connected yet.",
  creation: "Nothing has been designed or uploaded yet.",
  learned: "J4 has not worked anything out on its own yet. This fills as it watches.",
};

/**
 * Keep only the pairs that have a real value.
 *
 * A card with "Confidence: —" says J4 measured something and got nothing. A
 * card without the line says J4 has no confidence score for this, which is the
 * truth. So absent fields are dropped rather than rendered empty.
 */
function knownOf(pairs: [string, unknown][]): { label: string; value: string }[] {
  const kept: { label: string; value: string }[] = [];
  for (const [label, raw] of pairs) {
    if (raw === null || raw === undefined) continue;
    const value = typeof raw === "number" ? String(raw) : String(raw).trim();
    if (value.length === 0) continue;
    kept.push({ label, value });
  }
  return kept;
}

/**
 * What a customer is called on the map when they never gave a name.
 *
 * ============ WHY NOT THEIR EMAIL (2026-09-02) ========================
 *
 * Sean: "I don't want an email address exposed on the Business Map landing
 * screen just because a customer doesn't have a name... The Business Map is
 * becoming the visual representation of everything J4 knows about the
 * business. We should be intentional about what information gets surfaced at
 * each level."
 *
 * It was never a decision to show it — it was an accident of the id scheme.
 * An order-derived contact has `name: null`, so `labelOf` fell through to
 * `record.id`, and `internalContactId` builds that id as
 * `internal:contact:<email>`. The address arrived on the landing screen by way
 * of a primary key.
 *
 * ============ AND WHY NOT "Customer #1234" ============================
 *
 * He allowed a numbered form "if we have a safe non-email identifier". We do
 * not: Genesis has no customer numbering, and these records are keyed by email
 * precisely because there is nothing else. A number derived from a cuid or
 * from a position in this list would look like an identifier the owner could
 * look up somewhere, and would be one J4 invented. So the plain word, and the
 * spend beside it, which is real.
 */
export const ANONYMOUS_CUSTOMER_LABEL = "Customer";

/**
 * A person's own name, or nothing that identifies them.
 *
 * The `@` guard matters: some contact rows carry the address in `name` as
 * well, so trusting `name` alone would put it back on the card by another
 * route.
 */
function customerLabelOf(contact: { id: string; data: Record<string, unknown> }): string {
  const name = contact.data.name;
  if (typeof name === "string" && name.trim().length > 0 && !name.includes("@")) {
    return name.trim();
  }
  return ANONYMOUS_CUSTOMER_LABEL;
}

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
