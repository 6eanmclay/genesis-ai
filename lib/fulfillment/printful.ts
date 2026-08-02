import { prisma } from "@/lib/prisma";
import { encryptCredentials, decryptCredentials } from "@/lib/integrations/credentials";
import { PRINTFUL_API_BASE, refreshPrintfulToken, type PrintfulCredentials } from "@/lib/integrations/printful";
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
function matchesKeywords(product: { title: string; type_name: string; description: string }, keywords?: string): boolean {
  if (!keywords) return true;
  const haystack = `${product.title} ${product.type_name} ${product.description}`.toLowerCase();
  return keywords
    .toLowerCase()
    .split(/\s+/)
    .some((word) => word.length > 2 && haystack.includes(word));
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
    const res = await fetch(`${PRINTFUL_API_BASE}/products?limit=20`, {
      headers: authHeaders(credentials, false),
    });
    if (!res.ok) throw new Error(`Printful catalog browse failed (${res.status})`);
    const body = (await res.json()) as { result: PrintfulCatalogProduct[] };

    const matched = body.result.filter((p) => matchesKeywords(p, keywords)).slice(0, 8);
    const source = matched.length > 0 ? matched : body.result.slice(0, 8);

    const candidates: FulfillmentCandidate[] = [];
    for (const product of source) {
      const detail = await fetch(`${PRINTFUL_API_BASE}/products/${product.id}`, {
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
    const detail = await fetch(`${PRINTFUL_API_BASE}/products/${candidate.externalProductId}`, {
      headers: authHeaders(credentials, false),
    });
    if (!detail.ok) throw new Error(`Printful product lookup failed (${detail.status})`);
    const detailBody = (await detail.json()) as { result: { variants: PrintfulVariant[] } };
    const variant = detailBody.result.variants.find((v) => String(v.id) === candidate.variant.externalVariantId);
    if (!variant) throw new Error("Printful variant no longer available.");
    const costInCents = Math.round(parseFloat(variant.price) * 100);

    const shipRes = await fetch(`${PRINTFUL_API_BASE}/shipping/rates`, {
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
    const res = await fetch(`${PRINTFUL_API_BASE}/store/products`, {
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
      const body = await res.text();
      throw new Error(`Printful product creation failed (${res.status}): ${body}`);
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
    const res = await fetch(`${PRINTFUL_API_BASE}/orders`, {
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
      const body = await res.text();
      throw new Error(`Printful draft order creation failed (${res.status}): ${body}`);
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
