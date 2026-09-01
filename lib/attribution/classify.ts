// WHERE A VISITOR CAME FROM, AND HOW WE KNOW.
//
// ============ THE WHOLE RULE, WITH NO JUDGEMENT LEFT IN IT (2026-09-01) =
//
// Sean: "Never infer a platform merely because we think the visitor probably
// came from there." So this file has no table mapping hosts to platforms, no
// list of "places people usually post links", and no heuristics. It reads what
// the request actually supplied and classifies it into exactly three kinds.
//
//   explicit_tracking   an intentional tracking identifier supplied the source
//   observed_referral   the browser supplied a Referer we could parse to a host
//   direct_unknown      no reliable source exists. Recorded as that, honestly.
//
// Precedence is strict and in that order. Explicit beats observed because
// somebody deliberately said so; observed beats direct because a header is
// evidence and an absence is not.
//
// ============ linktr.ee STAYS linktr.ee ================================
//
// The rule that makes all of this trustworthy, stated as the general case
// rather than as a special case for one service: A HOST IS RECORDED AS THE
// HOST IT IS. A visitor arriving from a link-in-bio page came from that page.
// Genesis does not know what they tapped before it, and turning `linktr.ee`
// into "Instagram" would be inventing the one fact the merchant is asking us
// for.
//
// The only ways a visit becomes "instagram.com" are that the referrer host IS
// instagram.com, or that an explicit tracking parameter says so.
//
// ============ AND THE HOST ONLY, NEVER THE URL =========================
//
// A full referrer carries the path and query of the page somebody was on: a
// search they typed, a private document, another site's session id. The host
// answers the business question — where did they come from — and the rest is
// other people's data Genesis has no reason to hold.

/** The three kinds, and there is deliberately no fourth. */
export const ATTRIBUTION_KINDS = ["explicit_tracking", "observed_referral", "direct_unknown"] as const;
export type AttributionKind = (typeof ATTRIBUTION_KINDS)[number];

/**
 * The parameter names an explicit tracking link may use.
 *
 * `via` is the short one J4 will mint, because a merchant pasting a link into
 * an Instagram bio should not have to look at `utm_source=instagram`. The utm_
 * names are accepted because they are what every other tool in the world
 * produces — a merchant who already has a campaign link should not have it
 * silently classified as direct.
 *
 * Sean: "Do not require merchants to understand or manually add UTMs." They are
 * READ when present and never required, and the naked URL is never worse off.
 *
 * ============ IT IS NOT `ref`, AND THAT IS NOT A STYLE CHOICE =========
 *
 * `ref` was the obvious short name and it is ALREADY TAKEN on this very route.
 * app/api/checkout/paypal/return/route.ts redirects a paying customer to
 * `/store/<slug>?payment_pending=1&ref=<token>`, and the storefront renders it
 * to them as "Reference <token>". Had this file claimed `ref`, every PayPal
 * return would have been classified as explicit tracking with a PayPal
 * transaction token as its source — garbage in the one report this subsystem
 * exists to produce, arriving only for customers who actually paid.
 *
 * Checked before choosing rather than after: `via`, `utm_source`, `campaign`
 * and `utm_campaign` appear nowhere in any route's parameters today.
 */
export const SOURCE_PARAMS = ["via", "utm_source"] as const;
export const CAMPAIGN_PARAMS = ["campaign", "utm_campaign"] as const;

export interface AttributionEvidence {
  kind: AttributionKind;
  /** The referrer host, or the explicit source token. Null only for direct. */
  source: string | null;
  /** An explicit campaign identifier, when one was supplied. */
  campaign: string | null;
  /**
   * WHY this was attributed, in one short phrase.
   *
   * Sean: "Don't collapse those into one unexplained string. The eventual J4
   * Business Map needs to know why a source was attributed." So the kind says
   * what class of evidence, and this says what the evidence actually was —
   * `Referer host` versus `ref parameter` are different grounds for the same
   * source string, and a merchant deciding where to spend should be able to
   * tell them apart.
   */
  evidence: string;
}

/** A value that can be trusted into the database. */
function clean(value: string | null | undefined, max = 128): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Control characters stripped, length bounded. This lands in a column that a
  // dashboard renders; an unbounded value from a query string is somebody
  // else's input.
  // eslint-disable-next-line no-control-regex
  const safe = trimmed.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, max);
  return safe.length > 0 ? safe : null;
}

/**
 * The host of a referrer, or null.
 *
 * Returns null for a referrer from this same storefront, because a visitor
 * moving between two pages of the shop did not arrive from anywhere new — and
 * counting that as a referral would make every store its own biggest traffic
 * source.
 */
export function referrerHost(referer: string | null | undefined, selfHost?: string | null): string | null {
  const raw = clean(referer, 2048);
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    // Not a URL. A malformed Referer is not evidence of anything.
    return null;
  }
  if (!host) return null;
  if (selfHost && host === selfHost.toLowerCase()) return null;
  // www. is not a different place from the site itself.
  return host.replace(/^www\./, "");
}

export interface ClassifyInput {
  /** The raw Referer header, exactly as sent. */
  referer?: string | null;
  /** The landing URL's query parameters. */
  params?: URLSearchParams | null;
  /** This storefront's own host, so internal navigation is not a referral. */
  selfHost?: string | null;
}

/**
 * Classify one arrival.
 *
 * PURE. No database, no clock, no request object — so every rule above is
 * provable by calling it, which is the only reason a rule like "never infer a
 * platform" can be held to over time.
 */
export function classifyArrival(input: ClassifyInput): AttributionEvidence {
  const params = input.params ?? new URLSearchParams();

  // ---- 1. explicit tracking, because somebody meant it ------------------
  let explicit: string | null = null;
  let explicitParam = "";
  for (const name of SOURCE_PARAMS) {
    const value = clean(params.get(name), 64);
    if (value) {
      explicit = value;
      explicitParam = name;
      break;
    }
  }
  const campaign = (() => {
    for (const name of CAMPAIGN_PARAMS) {
      const value = clean(params.get(name), 64);
      if (value) return value;
    }
    return null;
  })();

  if (explicit) {
    return {
      kind: "explicit_tracking",
      // Lower-cased so `Instagram` and `instagram` are one source rather than
      // two rows in a dashboard that should have said the same thing.
      source: explicit.toLowerCase(),
      campaign: campaign?.toLowerCase() ?? null,
      evidence: `${explicitParam} parameter`,
    };
  }

  // ---- 2. an observed referral, because the browser said so -------------
  const host = referrerHost(input.referer, input.selfHost);
  if (host) {
    return {
      kind: "observed_referral",
      source: host,
      // A campaign with no source parameter is still an intentional label, and
      // dropping it would lose something the merchant supplied.
      campaign: campaign?.toLowerCase() ?? null,
      evidence: "Referer host",
    };
  }

  // ---- 3. and otherwise we do not know, and say so ----------------------
  return {
    kind: "direct_unknown",
    source: null,
    campaign: campaign?.toLowerCase() ?? null,
    evidence: input.referer ? "Referer unusable" : "no Referer header",
  };
}

/**
 * What to call a source on a screen.
 *
 * Deliberately close to the stored value. A prettifier is where a mapping table
 * creeps back in — "ig" becoming "Instagram" is exactly the inference this
 * whole file refuses to make.
 */
export function sourceLabel(evidence: Pick<AttributionEvidence, "kind" | "source">): string {
  if (evidence.source) return evidence.source;
  return "Direct or unknown";
}
