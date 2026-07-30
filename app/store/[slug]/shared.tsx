import { resolveSectionOrder, type SectionKey } from "@/lib/storefrontSections";
import { prisma } from "@/lib/prisma";
import { isPaymentConnected } from "@/lib/dashboard/needsAttention";

// Phase 1 Beta Excellence #4 — a published store with real products for
// sale but no CONNECTED payment provider must never offer a working-
// looking checkout: real customers would always fail at Stripe's/PayPal's
// own hosted page (or, worse, succeed against Genesis's own shared test
// account, per lib/payments/router.ts, which real cards can't actually
// pay into). No separate "does this store sell products" check is needed
// here — this is only ever called in the context of an actual active
// Product (BuyButton/createCheckoutSession), so that condition is already
// true by construction wherever this is checked.
export async function canStoreAcceptPayments(storeId: string): Promise<boolean> {
  const [stripeIntegration, paypalIntegration] = await Promise.all([
    prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "STRIPE" } },
      select: { status: true },
    }),
    prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId, provider: "PAYPAL" } },
      select: { status: true },
    }),
  ]);
  return isPaymentConnected({ stripeIntegration, paypalIntegration });
}

export const CHECKOUT_UNAVAILABLE_MESSAGE =
  "This store isn't accepting online payments yet. The business owner is still completing payment setup. Please check back soon or contact them directly if you'd like to make a purchase.";

// Shown only when an owner/employee is viewing their own unpublished store
// (the notFound() gate in page.tsx already keeps everyone else out entirely)
// — makes it unmistakable that this is a preview, never confusable with the
// live customer view, whether opened directly or embedded in the dashboard.
// Deliberately in normal document flow (not `fixed`) so it pushes the
// storefront's own nav bar down instead of floating on top of it — a fixed,
// centered pill here used to sit directly over the store's name in the nav,
// regardless of the nav's real (content-driven, non-fixed) height. `sticky`
// keeps the same "stays visible while scrolling" behavior without the
// overlap risk.
export function PreviewModeBanner() {
  return (
    <div className="sticky top-0 z-50 w-full border-b border-amber-400/30 bg-black/90 px-3.5 py-2 text-center text-sm font-medium text-amber-300 shadow-sm backdrop-blur">
      Preview — not published yet
    </div>
  );
}

export type StoreProduct = {
  id: string;
  name: string;
  description: string | null;
  priceInCents: number;
  imageUrl: string | null;
};

export type ProductRichContent = {
  keyFeatures: string[];
  benefits: string[];
  specifications: { label: string; value: string }[];
};

export type BrandIdentity = {
  brandStory: string;
  brandPromise: string;
};

export type HomepageContent = {
  heroHeadline: string;
  heroSubheadline: string;
  // Sourced independently of any product (see lib/productImagery.ts's
  // sourceHeroImageCandidate) — absent on stores created before this field
  // existed, and always absent for hero layouts that don't render an image
  // at all (only "split" does; see renderHero in page.tsx).
  heroImageUrl?: string | null;
  primaryCallToAction: string;
  secondaryCallToAction: string | null;
  aboutUs: string;
  whyChooseUs: string;
  featuredCollections: string[];
  faq: { question: string; answer: string }[];
  newsletterSection: string;
  footerContent: string;
  sectionOrder: SectionKey[];
  customSection: { title: string; body: string } | null;
};

export type MarketingAssets = {
  seoTitle: string;
  seoMetaDescription: string;
};

export type Blueprint = {
  brandIdentity?: BrandIdentity;
  homepageContent?: HomepageContent;
  marketingAssets?: MarketingAssets;
};

// The canonical section-key vocabulary now lives in lib/storefrontSections.ts
// (previously duplicated independently here and in ai-actions.ts) — imported
// above for local use in HomepageContent, and re-exported here so every
// existing import of `SectionKey`/`resolveSectionOrder` from "./shared"
// keeps working unchanged.
export { resolveSectionOrder, type SectionKey };

export function ProductImage({
  product,
  className,
}: {
  product: StoreProduct;
  className?: string;
}) {
  if (!product.imageUrl) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-[var(--brand-text-secondary)]">
        No image
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={product.imageUrl}
      alt={product.name}
      className={className ?? "h-full w-full object-cover"}
    />
  );
}
