import { prisma } from "@/lib/prisma";
import { encryptCredentials, decryptCredentials } from "@/lib/integrations/credentials";
import { PRINTFUL_API_BASE, refreshPrintfulToken, type PrintfulCredentials } from "@/lib/integrations/printful";
import { supplierRequest } from "@/lib/sourcing/sourcingBudget";
import { describeProviderError } from "@/lib/integrations/providerError";
import type {
  FulfillmentCandidate,
  FulfillmentConnector,
  FulfillmentCostEstimate,
  FulfillmentOrderResult,
  FulfillmentPartnerProfile,
} from "./types";

// Onboarding v2 — real, validated Printful fulfillment operations. Every
// endpoint/field used below was directly confirmed live against Printful's
// real API before this was written (catalog browse, variant cost, shipping
// rate, product creation with a direct image URL, draft order creation
// returning a real cost/profit breakdown, all four un-billed and cleanly
// reversible) — not inferred from docs alone. See ONBOARDING_V2_DESIGN.md
// section 6 for the evidence table.

// Not a claim of real semantic/brand-aware search — Printful's own catalog
// API has no such endpoint. This does a light client-side filter over a
// real page of the catalog; genuine "does this fit a streetwear brand"
// judgment belongs to the caller (Genesis, via the discovery flow), which
// has an LLM and this function doesn't.
//
// A real bug found via live testing: an earlier version matched on ANY
// word longer than 2 characters, which let common function words ("the",
// "want", "sell", "always") match nearly every product's description —
// the filter was close to a no-op, so a genuinely fitting product (e.g. a
// tote bag, for an idea literally about tote bags) could lose out to
// whatever happened to iterate first. Stopwords are excluded, and
// candidates are ranked by how many *meaningful* words actually matched,
// not just "matched at all" — so the closest real fits surface first.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our", "out",
  "day", "get", "has", "him", "his", "how", "man", "new", "now", "old", "see", "two", "who", "boy",
  "did", "its", "let", "put", "say", "she", "too", "use", "want", "sell", "with", "that", "this",
  "have", "from", "they", "will", "would", "there", "their", "what", "about", "which", "when",
  "make", "like", "time", "just", "into", "than", "then", "them", "these", "some", "could", "people",
  "always", "never", "theirs", "store", "online", "business", "shop", "something", "sells", "selling",
]);

function meaningfulWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function keywordMatchCount(product: { title: string; type_name: string; description: string }, keywords: string): number {
  const haystack = `${product.title} ${product.type_name} ${product.description}`.toLowerCase();
  const words = meaningfulWords(keywords);
  return words.filter((word) => haystack.includes(word)).length;
}

interface PrintfulCatalogProduct {
  id: number;
  title: string;
  type_name: string;
  description: string;
  image: string;
}

interface PrintfulVariant {
  id: number;
  name: string;
  price: string;
}

/**
 * Every outbound Printful request, through the one boundary that can refuse it.
 *
 * Nine call sites in this file and no others, which is what makes the sourcing
 * budget a real ceiling rather than a tally: inside an unattended run the budget
 * is asked BEFORE the request, and an exhausted budget throws instead of
 * fetching. Outside a run — an owner asking what something costs, an order being
 * fulfilled — there is no budget and this is a plain fetch that happens to be
 * recorded.
 */
function printfulFetch(operation: string, url: string, init?: RequestInit): Promise<Response> {
  return supplierRequest({ sourceKey: "printful", operation }, () => fetch(url, init));
}

async function resolveCredentials(params: {
  storeId: string | null;
  storeDraftId: string | null;
}): Promise<PrintfulCredentials> {
  if (params.storeId) {
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId: params.storeId, provider: "PRINTFUL" } },
    });
    if (!integration?.credentials) {
      throw new Error("Printful is not connected for this store.");
    }
    const credentials = decryptCredentials<PrintfulCredentials>(integration.credentials);
    const refreshed = await refreshPrintfulToken(credentials);
    if (refreshed.accessToken !== credentials.accessToken) {
      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId: params.storeId },
        data: { credentials: encryptCredentials(refreshed) },
      });
    }
    return refreshed;
  }

  if (params.storeDraftId) {
    const draft = await prisma.storeDraft.findUnique({ where: { id: params.storeDraftId } });
    const state = (draft?.onboardingState ?? null) as { fulfillmentCredentials?: { PRINTFUL?: unknown } } | null;
    const encrypted = state?.fulfillmentCredentials?.PRINTFUL;
    if (!encrypted) {
      throw new Error("Printful is not connected for this draft.");
    }
    const credentials = decryptCredentials<PrintfulCredentials>(encrypted);
    const refreshed = await refreshPrintfulToken(credentials);
    if (refreshed.accessToken !== credentials.accessToken) {
      await prisma.storeDraft.update({
        where: { id: params.storeDraftId },
        data: {
          onboardingState: {
            ...(state ?? {}),
            fulfillmentCredentials: { ...(state?.fulfillmentCredentials ?? {}), PRINTFUL: encryptCredentials(refreshed) },
          },
        },
      });
    }
    return refreshed;
  }

  throw new Error("browseCandidates/getCost/createProduct/createDraftOrder need either storeId or storeDraftId.");
}

function authHeaders(credentials: PrintfulCredentials, storeScoped: boolean): HeadersInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    "Content-Type": "application/json",
  };
  if (storeScoped) headers["X-PF-Store-Id"] = String(credentials.printfulStoreId);
  return headers;
}

const profile: FulfillmentPartnerProfile = {
  provider: "PRINTFUL",
  displayName: "Printful",
  qualityTier: "premium",
  costTier: "mid",
  // No inventory purchase required, broad apparel/home-goods catalog —
  // suits most positionings reasonably well; real per-positioning
  // differentiation is what a second, more specialized connector (e.g. a
  // dedicated premium print house) would exist to improve on, per
  // ONBOARDING_V2_DESIGN.md section 6.
  brandFit: ["luxury", "streetwear", "minimalist", "budget", "family", "professional", "other"],
};

export const printfulFulfillmentConnector: FulfillmentConnector = {
  provider: "PRINTFUL",
  profile,

  async browseCandidates({ storeId, storeDraftId, keywords }) {
    const credentials = await resolveCredentials({ storeId, storeDraftId });
    // limit=100 — confirmed live that Printful's real catalog is ~98
    // items total (offset paging past that returned the same count, not
    // further pages), so this captures the whole real catalog in one
    // call. A real bug found via live testing: the previous limit=20
    // meant keyword matching only ever searched a fifth of the catalog,
    // so a genuinely fitting product (e.g. a tote bag) could be missed
    // entirely even though it exists — Genesis would then reason
    // (honestly, but avoidably) about the closest thing in an
    // artificially narrow set instead of the real best fit.
    const res = await printfulFetch("search.catalog", `${PRINTFUL_API_BASE}/products?limit=100`, {
      headers: authHeaders(credentials, false),
    });
    if (!res.ok) throw new Error(`Printful catalog browse failed (${res.status})`);
    const body = (await res.json()) as { result: PrintfulCatalogProduct[] };

    // Ranked by real keyword relevance, not "first N that matched at all"
    // — the closest fits surface first, and only fall back to an
    // unranked slice if literally nothing in the catalog shares a
    // meaningful word with what the owner said.
    const ranked = keywords
      ? body.result
          .map((p) => ({ product: p, score: keywordMatchCount(p, keywords) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((r) => r.product)
      : [];
    const source = ranked.length > 0 ? ranked.slice(0, 8) : body.result.slice(0, 8);

    const candidates: FulfillmentCandidate[] = [];
    for (const product of source) {
      const detail = await printfulFetch("search.product", `${PRINTFUL_API_BASE}/products/${product.id}`, {
        headers: authHeaders(credentials, false),
      });
      if (!detail.ok) continue;
      const detailBody = (await detail.json()) as { result: { variants: PrintfulVariant[] } };
      const variant = detailBody.result.variants[0];
      if (!variant) continue;
      candidates.push({
        provider: "PRINTFUL",
        externalProductId: String(product.id),
        name: product.title,
        description: product.description,
        imageUrl: product.image || null,
        variant: { externalVariantId: String(variant.id), name: variant.name },
      });
    }
    return candidates;
  },

  async getCost({ storeId, storeDraftId, candidate }) {
    const credentials = await resolveCredentials({ storeId, storeDraftId });
    const detail = await printfulFetch("cost.product", `${PRINTFUL_API_BASE}/products/${candidate.externalProductId}`, {
      headers: authHeaders(credentials, false),
    });
    if (!detail.ok) throw new Error(`Printful product lookup failed (${detail.status})`);
    const detailBody = (await detail.json()) as { result: { variants: PrintfulVariant[] } };
    const variant = detailBody.result.variants.find((v) => String(v.id) === candidate.variant.externalVariantId);
    if (!variant) throw new Error("Printful variant no longer available.");
    const costInCents = Math.round(parseFloat(variant.price) * 100);

    const shipRes = await printfulFetch("cost.rates", `${PRINTFUL_API_BASE}/shipping/rates`, {
      method: "POST",
      headers: authHeaders(credentials, false),
      body: JSON.stringify({
        recipient: { address1: "19749 Dearborn St", city: "Chatsworth", country_code: "US", state_code: "CA", zip: "91311" },
        items: [{ variant_id: Number(candidate.variant.externalVariantId), quantity: 1 }],
      }),
    });
    let shippingInCents = 0;
    if (shipRes.ok) {
      const shipBody = (await shipRes.json()) as { result: { rate: string }[] };
      const standard = shipBody.result[0];
      if (standard) shippingInCents = Math.round(parseFloat(standard.rate) * 100);
    }

    const estimate: FulfillmentCostEstimate = {
      costInCents,
      shippingInCents,
      totalCostInCents: costInCents + shippingInCents,
    };
    return estimate;
  },

  async createProduct({ storeId, storeDraftId, candidate, imageUrl, retailPriceInCents }) {
    const credentials = await resolveCredentials({ storeId, storeDraftId });
    const res = await printfulFetch("listings", `${PRINTFUL_API_BASE}/store/products`, {
      method: "POST",
      headers: authHeaders(credentials, true),
      body: JSON.stringify({
        sync_product: { name: candidate.name },
        sync_variants: [
          {
            variant_id: Number(candidate.variant.externalVariantId),
            retail_price: (retailPriceInCents / 100).toFixed(2),
            files: [{ url: imageUrl }],
          },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(
        describeProviderError({ provider: "Printful", status: res.status, bodyText: await res.text(), stage: "product creation" })
      );
    }
    const body = (await res.json()) as { result: { id: number } };
    return { externalProductId: String(body.result.id) };
  },

  async createDraftOrder({ storeId, storeDraftId, candidate, imageUrl, retailPriceInCents }): Promise<FulfillmentOrderResult> {
    const credentials = await resolveCredentials({ storeId, storeDraftId });
    // No `confirm: true` and no follow-up POST /orders/{id}/confirm call —
    // this is what keeps the order a real, un-billed draft. See the
    // evidence in ONBOARDING_V2_DESIGN.md section 6. `imageUrl` must be a
    // real, valid print-file URL — Printful rejects both a missing file and
    // (confirmed live) a catalog candidate's own mockup `imageUrl`, which
    // has no recognized image extension.
    const res = await printfulFetch("order.create", `${PRINTFUL_API_BASE}/orders`, {
      method: "POST",
      headers: authHeaders(credentials, true),
      body: JSON.stringify({
        recipient: { name: "Preview Order", address1: "19749 Dearborn St", city: "Chatsworth", country_code: "US", state_code: "CA", zip: "91311" },
        items: [
          {
            variant_id: Number(candidate.variant.externalVariantId),
            quantity: 1,
            retail_price: (retailPriceInCents / 100).toFixed(2),
            files: [{ url: imageUrl }],
          },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(
        describeProviderError({ provider: "Printful", status: res.status, bodyText: await res.text(), stage: "draft order creation" })
      );
    }
    const body = (await res.json()) as {
      result: {
        id: number;
        pricing_breakdown?: { customer_pays: string; printful_price: string; profit: string }[];
      };
    };
    const pricing = body.result.pricing_breakdown?.[0];
    return {
      externalOrderId: String(body.result.id),
      costBreakdown: pricing
        ? {
            totalCostInCents: Math.round(parseFloat(pricing.printful_price) * 100),
            retailInCents: Math.round(parseFloat(pricing.customer_pays) * 100),
            profitInCents: Math.round(parseFloat(pricing.profit) * 100),
          }
        : null,
    };
  },
};

/**
 * What Printful prices in, and what one variant costs, ASKED RATHER THAN
 * ASSUMED (2026-08-21).
 *
 * Separate from `getCost` deliberately, and not a duplicate of it. `getCost`
 * exists to price an order and answers with a total; it reports a failed
 * shipping lookup as 0, which is right for an estimate and wrong for a stated
 * fact — 0 there can mean "free" or "we could not find out", and supplier
 * economics has to be able to tell those apart. This returns null for the
 * second, and returns the currency Printful actually prices this account in
 * rather than letting anything downstream assume dollars.
 */
export async function printfulEconomicsQuote(params: {
  storeId: string;
  externalProductId: string;
  externalVariantId: string;
}): Promise<{ unitCostInCents: number; shippingPerUnitInCents: number | null; currency: string }> {
  const credentials = await resolveCredentials({ storeId: params.storeId, storeDraftId: null });

  // Printful states the account's currency on the store itself. Reading it is
  // one call and removes the only figure in this path that would otherwise be a
  // guess about somebody's money.
  const storeRes = await printfulFetch("economics.store", `${PRINTFUL_API_BASE}/store`, {
    headers: authHeaders(credentials, false),
  });
  if (!storeRes.ok) throw new Error(`Printful store lookup failed (${storeRes.status})`);
  const storeBody = (await storeRes.json()) as { result?: { currency?: unknown } };
  const currency = typeof storeBody.result?.currency === "string" ? storeBody.result.currency : null;
  if (!currency) throw new Error("Printful did not say which currency this account prices in.");

  const detail = await printfulFetch("economics.product", `${PRINTFUL_API_BASE}/products/${params.externalProductId}`, {
    headers: authHeaders(credentials, false),
  });
  if (!detail.ok) throw new Error(`Printful product lookup failed (${detail.status})`);
  const detailBody = (await detail.json()) as { result: { variants: PrintfulVariant[] } };
  const variant = detailBody.result.variants.find((v) => String(v.id) === params.externalVariantId);
  if (!variant) throw new Error("Printful variant no longer available.");

  const shipRes = await printfulFetch("economics.rates", `${PRINTFUL_API_BASE}/shipping/rates`, {
    method: "POST",
    headers: authHeaders(credentials, false),
    body: JSON.stringify({
      recipient: { address1: "19749 Dearborn St", city: "Chatsworth", country_code: "US", state_code: "CA", zip: "91311" },
      items: [{ variant_id: Number(params.externalVariantId), quantity: 1 }],
    }),
  });

  // NULL, NOT ZERO. A rate lookup that failed has told us nothing about
  // delivery, and recording it as free is the exact lie the economics layer
  // exists to prevent.
  let shippingPerUnitInCents: number | null = null;
  if (shipRes.ok) {
    const shipBody = (await shipRes.json()) as { result: { rate: string }[] };
    const standard = shipBody.result[0];
    if (standard) shippingPerUnitInCents = Math.round(parseFloat(standard.rate) * 100);
  }

  return {
    unitCostInCents: Math.round(parseFloat(variant.price) * 100),
    shippingPerUnitInCents,
    currency,
  };
}
