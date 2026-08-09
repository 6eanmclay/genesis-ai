import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createCheckoutSession } from "../../actions";
import { SubmitButton } from "@/app/dashboard/SubmitButton";
import { ActionForm } from "@/app/dashboard/ActionForm";
import {
  DEFAULT_THEME,
  googleFontsUrl,
  themeCssVars,
  cardRadiusClass,
  buttonRadiusClass,
  shadowClass,
  imageFrameClass,
  type Theme,
} from "@/lib/theme";
import {
  canStoreAcceptPayments,
  CHECKOUT_UNAVAILABLE_MESSAGE,
  type Blueprint,
  type ProductRichContent,
} from "../../shared";
import { ProductGallery } from "./ProductGallery";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; productId: string }>;
}): Promise<Metadata> {
  const { slug, productId } = await params;

  const product = await prisma.product.findFirst({
    where: { id: productId, active: true, store: { slug, published: true } },
    select: { name: true, description: true },
  });

  if (!product) {
    return { title: "Product not found" };
  }

  return { title: product.name, description: product.description || undefined };
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ slug: string; productId: string }>;
}) {
  const { slug, productId } = await params;

  const store = await prisma.store.findUnique({ where: { slug } });
  if (!store || !store.published) {
    notFound();
  }

  const product = await prisma.product.findFirst({
    where: { id: productId, storeId: store.id, active: true },
    // Product media gallery (2026-08-08) — real ordered images for
    // ProductGallery below. Product.imageUrl itself is untouched and
    // stays the primary-image source of truth for every other reader.
    include: { images: { orderBy: { position: "asc" } } },
  });
  if (!product) {
    notFound();
  }

  const canAcceptPayments = await canStoreAcceptPayments(store.id);

  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;
  const brandIdentity = (store.blueprint as Blueprint | null)?.brandIdentity;
  const richContent = product.richContent as ProductRichContent | null;
  const fontsUrl = googleFontsUrl([theme.typography.headingFont, theme.typography.bodyFont]);

  const cardRadius = cardRadiusClass(theme);
  const buttonRadius = buttonRadiusClass(theme);
  const shadow = shadowClass(theme);

  return (
    <div
      style={themeCssVars(theme)}
      className="min-h-screen bg-[var(--brand-background)] font-[var(--font-body)] text-[var(--brand-text)]"
    >
      {fontsUrl && <link rel="stylesheet" href={fontsUrl} />}

      <div className="mx-auto max-w-5xl px-8 py-8">
        <Link
          href={`/store/${slug}`}
          className="text-sm text-[var(--brand-text-secondary)] hover:text-[var(--brand-accent)]"
        >
          &larr; Back to {store.name}
        </Link>

        <div className="mt-6 grid grid-cols-1 gap-10 md:grid-cols-2">
          <ProductGallery
            images={product.images.length > 0 ? product.images : product.imageUrl ? [{ url: product.imageUrl }] : []}
            productName={product.name}
            className={`aspect-square w-full overflow-hidden bg-[var(--brand-text)]/[.05] ${imageFrameClass(theme, cardRadius)} ${shadow}`}
          />

          <div>
            {/* Deliberately not wired to typeScale: this heading was
                already its own distinct, smaller size from the storefront
                hero's h1 by original design — the h1/h2 scale lookup would
                either inflate or shrink it depending on the chosen scale,
                not preserve it. */}
            <h1 className="font-[var(--font-heading)] text-3xl font-bold tracking-tight">
              {product.name}
            </h1>
            <p className="mt-3 text-2xl font-semibold">
              ${(product.priceInCents / 100).toFixed(2)}
            </p>
            {product.description && (
              <p className="mt-4 text-[var(--brand-text-secondary)]">{product.description}</p>
            )}

            <div className="mt-6 max-w-xs">
              {canAcceptPayments ? (
                <ActionForm action={createCheckoutSession.bind(null, slug, product.id)}>
                  <SubmitButton
                    pendingText="Redirecting to checkout..."
                    className={`w-full ${buttonRadius} bg-[var(--brand-accent)] px-6 py-3 text-base font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50`}
                  >
                    Buy Now
                  </SubmitButton>
                </ActionForm>
              ) : (
                <p className="text-sm text-[var(--brand-text-secondary)]">{CHECKOUT_UNAVAILABLE_MESSAGE}</p>
              )}
            </div>

            {brandIdentity?.brandPromise && (
              <p
                className={`mt-6 border border-[var(--brand-accent)]/20 bg-[var(--brand-accent)]/5 px-4 py-3 text-sm ${cardRadius}`}
              >
                <span className="font-medium">Our promise:</span> {brandIdentity.brandPromise}
              </p>
            )}

            {richContent && richContent.keyFeatures.length > 0 && (
              <div className="mt-8">
                <h2 className="font-[var(--font-heading)] text-lg font-semibold">
                  Key Features
                </h2>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--brand-text-secondary)]">
                  {richContent.keyFeatures.map((feature, i) => (
                    <li key={i}>{feature}</li>
                  ))}
                </ul>
              </div>
            )}

            {richContent && richContent.benefits.length > 0 && (
              <div className="mt-6">
                <h2 className="font-[var(--font-heading)] text-lg font-semibold">Benefits</h2>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--brand-text-secondary)]">
                  {richContent.benefits.map((benefit, i) => (
                    <li key={i}>{benefit}</li>
                  ))}
                </ul>
              </div>
            )}

            {richContent && richContent.specifications.length > 0 && (
              <div className="mt-6">
                <h2 className="font-[var(--font-heading)] text-lg font-semibold">
                  Specifications
                </h2>
                <dl className="mt-2 divide-y divide-[var(--brand-text)]/[.08] text-sm">
                  {richContent.specifications.map((spec, i) => (
                    <div key={i} className="flex justify-between py-2">
                      <dt className="text-[var(--brand-text-secondary)]">{spec.label}</dt>
                      <dd className="font-medium">{spec.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
