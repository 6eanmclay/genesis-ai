import type { ProductSource, SourceQuoteResult, SourceSearchResult, SourcingIntent } from "./types";
import { priceInCents, type AliexpressFailure, type AliexpressProduct } from "./aliexpressProtocol";

// AliExpress, as a wholesale/dropship source.
//
// What this entry IS for: it is the second SHAPE. Printful creates a listing
// with the owner's artwork on it; a wholesale supplier creates nothing and
// customises nothing — the item already exists, with a price and a photograph,
// and the owner is deciding whether to resell it. Declaring that shape is what
// proves the contract in ./types.ts holds more than print-on-demand, and what
// the discovery and adoption paths are written against.
//
// ============ IT NOW SEARCHES, WHEN IT CAN (2026-08-27) ====================
//
// This was a declared-and-not-implemented entry that always answered
// not_configured, and that answer is what an owner saw as "Places I couldn't
// look — AliExpress". It now performs a real signed search against the real
// gateway whenever ALIEXPRESS_APP_KEY and ALIEXPRESS_APP_SECRET are set.
//
// WHAT DID NOT CHANGE is the rule that produced the old behaviour, because it
// was never a placeholder: there is still no mock catalog, and there never will
// be one. "No results" and "I was never able to look" remain different answers
// with different next actions, and only one of them belongs to the owner. What
// has changed is that there are now FOUR reasons it might not be able to look,
// and the owner is told which:
//
//   not_configured  — Genesis has no AliExpress app yet. Sean's move.
//   not_connected   — the credentials are there and AliExpress refused them,
//                     or refused this method. Sean's move, at AliExpress.
//   provider_error  — rate limit, outage, or an unrecognised gateway error.
//                     Nobody's move; it will work later.
//
// NOT ONE LIVE CALL HAS BEEN MADE. AliExpress issues credentials only after an
// application, a signed Open Platform Agreement, company details, a 1–2 business
// day review, and an audit of the finished app. Everything below is written and
// tested against the documented protocol; the first real search is what
// confirms it. That is stated here rather than left to be discovered.
export const ALIEXPRESS_REQUIRED_CREDENTIALS = ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"];

export const aliexpressSource: ProductSource = {
  key: "aliexpress",
  displayName: "AliExpress",
  kind: "WHOLESALE_DROPSHIP",
  capabilities: {
    // The line that matters. Nothing about a wholesale listing is customisable,
    // and offering "add your logo" on one would be a promise to a customer that
    // the supplier has no idea was made.
    customization: false,
    createsListings: false,
    shipsDirect: true,
    quotesCost: true,
    // No economics() implementation, so this is false. The "if and only if" is
    // asserted over the registry rather than trusted — a source claiming a
    // capability it does not implement reads as working right up until a caller
    // believes it.
    statesEconomics: false,
  },
  // Nobody fulfils on Genesis's behalf here — the supplier ships to the
  // customer directly and no connector routes anything to them.
  fulfillmentProvider: null,

  // ============ A GETTER, AND IT HAS TO BE ================================
  //
  // discoverProducts() checks `blockedOn.length > 0` and, when it is non-empty,
  // reports the source as unavailable WITHOUT CALLING search() AT ALL. That is
  // the right design — a known configuration gap should not become a provider
  // error in the logs — but it means a static array here would have made every
  // line of the search implementation below unreachable, forever, with nothing
  // failing to say so.
  //
  // So this answers from the environment as it is now, not as it was at import.
  // The two properties that matter both fall out of that: a deployment that
  // gains the credentials starts searching without a rebuild, and one that
  // never had them keeps the exact behaviour and wording it had before.
  //
  // It reads the variables rather than calling into ./aliexpressClient.ts
  // because that module is `server-only` and this one is reached from the test
  // harness. Reading is all it does — Next replaces a non-`NEXT_PUBLIC_`
  // variable with `undefined` in any client bundle, so the secret cannot travel
  // even if this module were somehow pulled into one.
  get blockedOn(): string[] {
    return aliexpressConfiguredInEnvironment() ? [] : ALIEXPRESS_REQUIRED_CREDENTIALS;
  },

  async search(intent: SourcingIntent): Promise<SourceSearchResult> {
    // THE CHECK COMES BEFORE THE IMPORT, and both halves of that are load-bearing.
    //
    // Before: there is no reason to load the module that talks to AliExpress in
    // order to discover that it cannot.
    //
    // Dynamic: ./aliexpressClient.ts is `server-only`, which Next resolves
    // through its own internal alias and nothing else resolves at all. This
    // registry is read from outside Next — the verification harness among
    // others — and a top-level import would not fail loudly there; it would
    // stop this whole module loading, which is how a source silently
    // disappears from discovery.
    if (aliexpressConfiguredInEnvironment()) {
      const { searchAliexpress } = await import("./aliexpressClient");
      return await runSearch(searchAliexpress, intent);
    }
    return NOT_CONFIGURED("its catalog can be searched");
  },

  // Present because the capability is declared. A wholesale supplier genuinely
  // does quote a price — and until there is a real product to quote, saying so
  // is better than an invented number.
  async quote(): Promise<SourceQuoteResult> {
    if (!aliexpressConfiguredInEnvironment()) return NOT_CONFIGURED("it can price anything");
    return {
      ok: false,
      reason: "provider_error",
      detail:
        "AliExpress can be searched, but Genesis can't yet ask it to re-price a specific item. " +
        "The price shown is the one from the search.",
    };
  },
};

/** Both variables, present and non-blank. Half-configured is not configured. */
function aliexpressConfiguredInEnvironment(): boolean {
  return (
    Boolean(process.env.ALIEXPRESS_APP_KEY?.trim()) && Boolean(process.env.ALIEXPRESS_APP_SECRET?.trim())
  );
}

async function runSearch(
  searchAliexpress: typeof import("./aliexpressClient").searchAliexpress,
  intent: SourcingIntent,
): Promise<SourceSearchResult> {
  const result = await searchAliexpress({
    // The business's own words, which is all the sourcing contract carries —
    // never a raw customer query.
    keywords: intent.keywords,
    limit: intent.limit,
  });

  if (!result.ok) return unavailable(result.failure);

  return {
    ok: true,
    candidates: result.value.slice(0, intent.limit).map(toCandidate),
  };
}

/** One AliExpress listing as the sourcing model understands it. */
function toCandidate(product: AliexpressProduct) {
  const cost = priceInCents(product.target_sale_price);
  return {
    sourceKey: "aliexpress",
    externalProductId: String(product.product_id ?? ""),
    // A wholesale listing has no variant Genesis selects; the supplier's own
    // options are chosen at order time, not here.
    externalVariantId: null,
    kind: "WHOLESALE_DROPSHIP" as const,
    name: product.product_title ?? "Untitled AliExpress product",
    description: null,
    imageUrl: product.product_main_image_url ?? null,
    // NULL MEANS UNKNOWN and must never be rendered as zero — an unreadable
    // price is exactly the case where a fallback of 0 would let an owner list
    // something at a loss.
    unitCostInCents: cost,
    // Genesis does not guess a retail price for a wholesale item. The owner
    // sets it, and the margin tooling works from the cost above.
    suggestedRetailInCents: null,
    currency: product.target_sale_price_currency ?? "USD",
    customizable: false,
    fulfillmentProvider: null,
  };
}

/**
 * A failure, in the owner's terms.
 *
 * The mapping is the point. Credentials AliExpress rejects are not the same
 * problem as credentials that are absent, and neither is the same as a rate
 * limit — one is a form to fill in, one is a variable to set, one is a wait.
 */
function unavailable(failure: AliexpressFailure): SourceSearchResult {
  switch (failure.kind) {
    case "auth":
      return {
        ok: false,
        reason: "not_connected",
        detail:
          "AliExpress rejected Genesis's app credentials, so its catalog couldn't be searched. " +
          `AliExpress said: ${failure.detail}`,
      };
    case "not_permitted":
      return {
        ok: false,
        reason: "not_connected",
        detail:
          "Genesis's AliExpress app isn't approved for catalog search yet — that approval comes from " +
          `AliExpress, not from anything in the store. AliExpress said: ${failure.detail}`,
      };
    case "rate_limit":
      return {
        ok: false,
        reason: "provider_error",
        detail: "AliExpress is limiting how often Genesis can search right now. This will work again shortly.",
      };
    case "provider":
      return { ok: false, reason: "provider_error", detail: failure.detail };
  }
}

function NOT_CONFIGURED(what: string) {
  return {
    ok: false as const,
    reason: "not_configured" as const,
    detail: `AliExpress sourcing needs an AliExpress Open Platform app before ${what}. Nothing is being shown from it rather than showing invented products.`,
    missing: ALIEXPRESS_REQUIRED_CREDENTIALS,
  };
}
