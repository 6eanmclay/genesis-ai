import Link from "next/link";
import type { StoreRole } from "@prisma/client";
import { resolveSectionOrder, type SectionKey } from "@/lib/storefrontSections";

// Lets an authenticated owner/employee find their way back to the
// dashboard while previewing the public storefront — invisible to
// customers and logged-out visitors (role is null for both). Styled with
// fixed colors rather than the store's own --brand-* CSS vars so it stays
// legible regardless of the active theme (dark, light, any accent).
export function OwnerDashboardLink({ role }: { role: StoreRole | null }) {
  if (!role) return null;
  return (
    <Link
      href="/dashboard"
      className="fixed top-3 left-3 z-50 rounded-full border border-white/20 bg-black/80 px-3.5 py-2 text-sm font-medium text-white shadow-sm backdrop-blur transition-colors hover:bg-black"
    >
      &larr; Dashboard
    </Link>
  );
}

// Shown only when an owner/employee is viewing their own unpublished store
// (the notFound() gate in page.tsx already keeps everyone else out entirely)
// — makes it unmistakable that this is a preview, never confusable with the
// live customer view, whether opened directly or embedded in the dashboard.
export function PreviewModeBanner() {
  return (
    <div className="fixed top-3 left-1/2 z-50 -translate-x-1/2 rounded-full border border-amber-400/30 bg-black/80 px-3.5 py-2 text-sm font-medium text-amber-300 shadow-sm backdrop-blur">
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
