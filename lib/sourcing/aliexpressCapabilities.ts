// WHAT ALIEXPRESS HAS ACTUALLY GRANTED US, AND WHAT EACH GRANT UNLOCKS.
//
// ============ WHY THIS IS A MODULE AND NOT A CONSTANT =====================
//
// AliExpress does not hand out one undifferentiated "API access". An app is
// approved for capability groups, and an app can be approved for some and
// refused others — the affiliate group and the dropshipping (DS) group are
// separately gated, and the DS group's order methods are gated again beyond
// that. So "can Genesis do X with AliExpress" has a different answer per X, and
// that answer changes over the life of the application rather than being fixed
// when this file was written.
//
// The failure this prevents is the one where a capability is refused and the
// code finds out by making a call that returns an unrecognisable error in front
// of an owner. Declaring the grant means a refused capability is a known state
// with something honest to say, exactly as `blockedOn` is for the whole source.
//
// ============ THE LIFECYCLE THIS IS BUILT TOWARD ==========================
//
// Sean's end state, and every stage's dependency named:
//
//   business understanding                     -- already built
//     -> "What could you sell?"                -- already built
//     -> J4 recommendations                    -- already built
//     -> browse / swipe                        -- needs SEARCH
//     -> product analysis                      -- needs PRODUCT_DETAIL
//     -> owner approval                        -- already built (adopt.ts)
//     -> product creation                      -- already built
//     -> sourcing                              -- needs FREIGHT
//     -> fulfillment                           -- needs ORDER + TRACKING
//
// Everything up to and including approval already exists and is proven against
// Printful. What AliExpress adds is a second source shape underneath it. Naming
// the whole ladder here means a later grant is a configuration change and a
// method call, not a redesign.

/** The capability groups Genesis would use, coarsest first. */
export type AliexpressCapability =
  /** Find candidate products from the business's own words. */
  | "search"
  /** Everything about one product: images, variants, specs, real price. */
  | "product_detail"
  /** What shipping a specific item to a specific place actually costs. */
  | "freight"
  /** Place a real order with the supplier. */
  | "order"
  /** Follow that order to the customer's door. */
  | "tracking";

export const ALL_ALIEXPRESS_CAPABILITIES: AliexpressCapability[] = [
  "search",
  "product_detail",
  "freight",
  "order",
  "tracking",
];

export interface CapabilitySpec {
  capability: AliexpressCapability;
  /** Which of AliExpress's separately-approved API groups this sits in. */
  apiGroup: "affiliate" | "dropshipping";
  /**
   * The method Genesis would call.
   *
   * VERIFIED WHERE MARKED. AliExpress's own API reference is behind a developer
   * login this project does not have, so these come from its public getting-
   * started material and from established client libraries. The ones not
   * independently confirmed say so, because a method name invented from a
   * pattern is exactly the sort of thing that looks right until the first call.
   */
  method: string;
  methodVerified: boolean;
  /**
   * Does this need a per-account OAuth token, or do app credentials suffice?
   *
   * THE ARCHITECTURAL LINE. The affiliate group authenticates with the app key
   * and secret alone — one platform credential, no merchant involvement, which
   * is what makes search usable the moment the app is approved. The
   * dropshipping group authenticates as an AliExpress ACCOUNT, so it needs an
   * OAuth grant and a token per account, and somebody has to own that account.
   * That is not a bigger version of the same integration; it is a different one
   * sharing a signature.
   */
  needsOAuth: boolean;
  /** What the owner gets. Written for the application form, not for us. */
  whatItEnables: string;
}

export const ALIEXPRESS_CAPABILITY_SPECS: Record<AliexpressCapability, CapabilitySpec> = {
  search: {
    capability: "search",
    apiGroup: "affiliate",
    method: "aliexpress.affiliate.product.query",
    methodVerified: true,
    needsOAuth: false,
    whatItEnables:
      "Genesis matches products against what the owner has told it about their business, so 'What could you sell?' returns candidates rather than an apology.",
  },
  product_detail: {
    capability: "product_detail",
    apiGroup: "affiliate",
    method: "aliexpress.affiliate.productdetail.get",
    methodVerified: true,
    needsOAuth: false,
    whatItEnables:
      "The owner can inspect one candidate properly — images, variants, specifications and the real current price — before deciding, instead of judging it from a thumbnail.",
  },
  freight: {
    capability: "freight",
    // AFFILIATE, because that is the group Genesis can use without an
    // account. The dropshipping group has its own and better freight methods
    // (aliexpress.logistics.buyer.freight.calculate), but they authenticate
    // per account -- so if only the affiliate group is granted, this is the
    // one that works, and naming the other here would overstate the grant.
    apiGroup: "affiliate",
    method: "aliexpress.affiliate.product.shipping.get",
    methodVerified: true,
    needsOAuth: false,
    whatItEnables:
      "Genesis can tell the owner what an item costs to ship to their customers before they commit to selling it, so margin is a fact rather than a hope.",
  },
  order: {
    capability: "order",
    apiGroup: "dropshipping",
    method: "aliexpress.ds.order.create",
    methodVerified: true,
    needsOAuth: true,
    whatItEnables:
      "When a customer buys, Genesis places the supplier order automatically instead of the owner re-typing it.",
  },
  tracking: {
    capability: "tracking",
    apiGroup: "dropshipping",
    // CORRECTED 2026-08-27. This said `aliexpress.ds.order.tracking.get`,
    // which was a name derived from the naming pattern and marked unverified
    // for exactly that reason. The real method is in the logistics family, not
    // the ds one, and no amount of pattern-matching would have got there --
    // which is the argument for marking a guess as a guess rather than letting
    // it read as fact.
    method: "aliexpress.logistics.ds.trackinginfo.query",
    methodVerified: true,
    needsOAuth: true,
    whatItEnables:
      "The customer is told where their parcel is, and the order's delivery state in Genesis reflects reality rather than an assumption.",
  },
};

/**
 * What this deployment has been granted.
 *
 * ============ THE DEFAULT IS SEARCH, AND ONLY SEARCH ====================
 *
 * Not because search is safe to assume, but because search is the ONE
 * capability with a live call site that already tells its own truth: a refused
 * search comes back as InsufficientIsvPermissions and is mapped to
 * `not_connected` with AliExpress's own words attached. The system finds out
 * honestly, at the moment it matters, without needing to be told in advance.
 *
 * Nothing beyond search has that. Their call sites do not exist yet, so an
 * assumed grant there would be a claim with nothing to check it — a capability
 * advertised to an owner that has never been approved by anyone. Those must be
 * declared, and are absent until they are.
 *
 * Set after AliExpress replies, to exactly what they actually approved:
 *
 *   ALIEXPRESS_GRANTED_CAPABILITIES=search,product_detail,freight
 *
 * `all` is accepted as shorthand for a full grant. `none` is accepted too, for
 * the honest case where AliExpress approved the app and refused every group.
 */
export function grantedCapabilities(): AliexpressCapability[] {
  const raw = process.env.ALIEXPRESS_GRANTED_CAPABILITIES?.trim();
  if (!raw) return ["search"];
  if (raw.toLowerCase() === "none") return [];
  if (raw.toLowerCase() === "all") return [...ALL_ALIEXPRESS_CAPABILITIES];

  const requested = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  // An unrecognised name is DROPPED, not passed through. A typo that became a
  // granted capability would be a capability nothing implements, and the call
  // it unlocked would fail in front of an owner.
  return ALL_ALIEXPRESS_CAPABILITIES.filter((capability) => requested.includes(capability));
}

export function hasCapability(capability: AliexpressCapability): boolean {
  return grantedCapabilities().includes(capability);
}

/**
 * Why a capability is unavailable, in the owner's terms.
 *
 * Three genuinely different reasons, because they have three different next
 * actions — and collapsing them into "not available" would leave the owner
 * unable to tell which of them, if any, is theirs to do anything about.
 */
export function capabilityUnavailableReason(capability: AliexpressCapability): string {
  const spec = ALIEXPRESS_CAPABILITY_SPECS[capability];
  if (spec.needsOAuth) {
    return (
      `${capability} needs AliExpress's dropshipping API, which authorises per AliExpress account rather than per app — ` +
      `so it needs both AliExpress's approval of that API group and an authorised account to act through.`
    );
  }
  return (
    `${capability} needs AliExpress's ${spec.apiGroup} API group, which this app has not been granted. ` +
    `That approval is AliExpress's to give.`
  );
}

/** Everything asked for but not granted, for the operator-facing record. */
export function deniedCapabilities(): { capability: AliexpressCapability; reason: string }[] {
  const granted = grantedCapabilities();
  return ALL_ALIEXPRESS_CAPABILITIES.filter((c) => !granted.includes(c)).map((capability) => ({
    capability,
    reason: capabilityUnavailableReason(capability),
  }));
}
