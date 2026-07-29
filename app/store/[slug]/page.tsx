import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { getStoreRole } from "@/lib/permissions";
import { createCheckoutSession, subscribeToNewsletter } from "./actions";
import { SubmitButton } from "@/app/dashboard/SubmitButton";
import {
  DEFAULT_THEME,
  googleFontsUrl,
  themeCssVars,
  cardRadiusClass,
  buttonRadiusClass,
  shadowClass,
  sectionPaddingClass,
  contentGapClass,
  heroLayoutOf,
  ctaEmphasisOf,
  sectionLayoutFor,
  headingScaleClass,
  imageFrameClass,
  sectionBandClass,
  type Theme,
} from "@/lib/theme";
import {
  ProductImage,
  PreviewModeBanner,
  resolveSectionOrder,
  type Blueprint,
  type SectionKey,
  type StoreProduct,
} from "./shared";
import { SECTION_KEYS, reconcileCustomSection } from "@/lib/storefrontSections";
import { MobileNav } from "./MobileNav";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  const store = await prisma.store.findUnique({
    where: { slug },
    select: { id: true, name: true, description: true, published: true, blueprint: true },
  });

  if (!store) {
    return { title: "Store not found" };
  }

  if (!store.published) {
    const session = await auth();
    const viewerRole = session?.user ? await getStoreRole(session.user.id, store.id) : null;
    if (!viewerRole) {
      return { title: "Store not found" };
    }
  }

  const marketing = (store.blueprint as Blueprint | null)?.marketingAssets;

  return {
    title: marketing?.seoTitle || store.name,
    description: marketing?.seoMetaDescription || store.description || undefined,
  };
}

function BuyButton({
  slug,
  product,
  className,
}: {
  slug: string;
  product: StoreProduct;
  className: string;
}) {
  return (
    <form action={createCheckoutSession.bind(null, slug, product.id)}>
      <SubmitButton pendingText="Redirecting to checkout..." className={className}>
        Buy Now
      </SubmitButton>
    </form>
  );
}

export default async function StorefrontPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ subscribed?: string; previewOrder?: string }>;
}) {
  const { slug } = await params;
  const { subscribed, previewOrder } = await searchParams;

  const store = await prisma.store.findUnique({
    where: { slug },
  });

  if (!store) {
    notFound();
  }

  const session = await auth();
  const viewerRole = session?.user ? await getStoreRole(session.user.id, store.id) : null;

  // Unpublished stores are only visible to their own owner/employee, previewing
  // ahead of launch — never to a logged-out visitor or another account. This
  // is what lets the dashboard embed the real storefront as a live preview
  // before a merchant has published anything; customers still get a real 404.
  if (!store.published && !viewerRole) {
    notFound();
  }

  const products = await prisma.product.findMany({
    where: { storeId: store.id, active: true },
    orderBy: { position: "asc" },
  });

  // Captured as plain locals — TypeScript doesn't carry the `!store` null
  // narrowing above into nested function declarations like renderHero().
  const storeName = store.name;
  const storeTagline = store.tagline;
  const storeDescription = store.description;

  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;
  const blueprint = store.blueprint as Blueprint | null;
  const homepage = blueprint?.homepageContent;
  const brandIdentity = blueprint?.brandIdentity;

  // An owner/employee-only proposed-order preview (Genesis's first
  // structural action, Phase 3B) — never persisted, never affects what a
  // real customer or logged-out visitor sees (viewerRole is null for both,
  // the same gate that already protects unpublished-store preview above).
  // Falls back silently to the real stored order if absent, unauthorized,
  // or malformed — this is privileged preview state, not real
  // functionality, so a bad value is never an error.
  const parsedPreviewOrder = viewerRole && previewOrder
    ? previewOrder.split(",").filter((key): key is SectionKey =>
        (SECTION_KEYS as readonly string[]).includes(key)
      )
    : null;
  const sectionOrder =
    parsedPreviewOrder && parsedPreviewOrder.length > 0
      ? reconcileCustomSection(parsedPreviewOrder, homepage)
      : resolveSectionOrder(homepage);

  // Real customer-facing nav links only — "Shop" is guaranteed whenever
  // there's anything to sell (computed independently of sectionOrder, same
  // defensive spirit as resolveSectionOrder's own customSection
  // reconciliation, so a model-generated order that forgot to list
  // "products" never costs the store its one most important link).
  // Everything else mirrors renderSection's own real-content checks below —
  // a section with nothing to show never gets a dead nav link.
  // featuredCollections/newsletter are widgets, not navigation destinations.
  const navLinks: { label: string; href: string }[] = [
    ...(products.length > 0 ? [{ label: "Shop", href: "#products" }] : []),
    ...sectionOrder.flatMap((key): { label: string; href: string }[] => {
      switch (key) {
        case "about":
          return homepage?.aboutUs ? [{ label: "About", href: "#about" }] : [];
        case "whyChooseUs":
          return homepage?.whyChooseUs ? [{ label: "Why Choose Us", href: "#whyChooseUs" }] : [];
        case "brandStory":
          return brandIdentity?.brandStory ? [{ label: "Our Story", href: "#brandStory" }] : [];
        case "customSection":
          return homepage?.customSection
            ? [{ label: homepage.customSection.title, href: "#customSection" }]
            : [];
        case "faq":
          return homepage && homepage.faq.length > 0 ? [{ label: "FAQ", href: "#faq" }] : [];
        default:
          return [];
      }
    }),
  ];

  const fontsUrl = googleFontsUrl([
    theme.typography.headingFont,
    theme.typography.bodyFont,
  ]);

  const cardRadius = cardRadiusClass(theme);
  const buttonRadius = buttonRadiusClass(theme);
  const shadow = shadowClass(theme);
  const sectionPadding = sectionPaddingClass(theme);
  const gap = contentGapClass(theme);
  const heroLayout = heroLayoutOf(theme);
  const ctaEmphasis = ctaEmphasisOf(theme);
  const h1Class = headingScaleClass(theme, "h1");
  const h2Class = headingScaleClass(theme, "h2");
  const imageFrame = imageFrameClass(theme, cardRadius);

  const buyButtonClass = `flex-1 ${buttonRadius} bg-[var(--brand-accent)] px-4 py-2 text-center text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-50`;
  const detailsLinkClass = `flex-1 ${buttonRadius} border border-[var(--brand-text)]/[.15] px-4 py-2 text-center text-sm transition-colors hover:bg-[var(--brand-text)]/[.05]`;
  const cardClass = `group overflow-hidden ${cardRadius} border border-[var(--brand-text)]/[.08] bg-[var(--brand-surface)] ${shadow} transition-shadow`;

  const secondaryCtaTarget = sectionOrder[0] ? `#${sectionOrder[0]}` : "#products";

  // Shared by the four text-content sections (about/whyChooseUs/brandStory/
  // customSection) — each just supplies its heading/body/id. `wantsBand`
  // preserves each section's pre-existing identity (whyChooseUs/
  // customSection were always banded, about/brandStory were always flush)
  // so the "tintBands" default reproduces today's output exactly.
  function renderTextSection({
    id,
    heading,
    body,
    wantsBand,
  }: {
    id: SectionKey;
    heading: string;
    body: string;
    wantsBand: boolean;
  }) {
    const bandClass = sectionBandClass(theme, wantsBand);
    const layout = sectionLayoutFor(theme, id);

    if (layout === "split") {
      return (
        <section key={id} id={id} className={bandClass}>
          <div className={`mx-auto grid max-w-3xl grid-cols-1 gap-4 px-8 sm:grid-cols-[1fr_2fr] sm:gap-10 ${sectionPadding}`}>
            <h2 className={`font-[var(--font-heading)] ${h2Class}`}>{heading}</h2>
            <p className="text-[var(--brand-text-secondary)]">{body}</p>
          </div>
        </section>
      );
    }

    if (layout === "boxed") {
      return (
        <section key={id} id={id} className={bandClass}>
          <div className={`mx-auto max-w-3xl px-8 ${sectionPadding}`}>
            <div
              className={`border border-[var(--brand-text)]/[.08] bg-[var(--brand-surface)] p-8 text-center ${cardRadius} ${shadow}`}
            >
              <h2 className={`font-[var(--font-heading)] ${h2Class}`}>{heading}</h2>
              <p className="mt-4 text-[var(--brand-text-secondary)]">{body}</p>
            </div>
          </div>
        </section>
      );
    }

    // "centered" (default) — today's exact markup
    return (
      <section key={id} id={id} className={bandClass}>
        <div className={`mx-auto max-w-3xl px-8 text-center ${sectionPadding}`}>
          <h2 className={`font-[var(--font-heading)] ${h2Class}`}>{heading}</h2>
          <p className="mt-4 text-[var(--brand-text-secondary)]">{body}</p>
        </div>
      </section>
    );
  }

  function renderSection(key: SectionKey) {
    switch (key) {
      case "about":
        return (
          homepage?.aboutUs &&
          renderTextSection({ id: key, heading: "About Us", body: homepage.aboutUs, wantsBand: false })
        );

      case "whyChooseUs":
        return (
          homepage?.whyChooseUs &&
          renderTextSection({
            id: key,
            heading: "Why Choose Us",
            body: homepage.whyChooseUs,
            wantsBand: true,
          })
        );

      case "brandStory":
        return (
          brandIdentity?.brandStory &&
          renderTextSection({
            id: key,
            heading: "Our Story",
            body: brandIdentity.brandStory,
            wantsBand: false,
          })
        );

      case "customSection":
        return (
          homepage?.customSection &&
          renderTextSection({
            id: key,
            heading: homepage.customSection.title,
            body: homepage.customSection.body,
            wantsBand: true,
          })
        );

      case "featuredCollections":
        return (
          homepage && homepage.featuredCollections.length > 0 && (
            <div
              key={key}
              id={key}
              className="mx-auto flex max-w-5xl flex-wrap justify-center gap-2 px-8 pt-10"
            >
              {homepage.featuredCollections.map((collection) => (
                <span
                  key={collection}
                  className="rounded-full border border-[var(--brand-accent)]/30 px-4 py-1.5 text-sm text-[var(--brand-accent)]"
                >
                  {collection}
                </span>
              ))}
            </div>
          )
        );

      case "products":
        return (
          <main key={key} id="products" className={`mx-auto max-w-5xl px-8 ${sectionPadding}`}>
            {products.length === 0 ? (
              <p className="text-center text-[var(--brand-text-secondary)]">
                No products available yet.
              </p>
            ) : theme.layout === "list" ? (
              <ul className={`flex flex-col ${gap}`}>
                {products.map((product) => (
                  <li
                    key={product.id}
                    className={`flex flex-col ${gap} p-4 sm:flex-row sm:items-center ${cardClass}`}
                  >
                    <div className="aspect-square w-full shrink-0 overflow-hidden rounded-xl bg-[var(--brand-text)]/[.05] sm:w-32">
                      <ProductImage product={product} className="h-full w-full object-cover" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-[var(--font-heading)] font-semibold">
                        {product.name}
                      </h3>
                      {product.description && (
                        <p className="mt-1 line-clamp-2 text-sm text-[var(--brand-text-secondary)]">
                          {product.description}
                        </p>
                      )}
                      <p className="mt-2 text-lg font-semibold">
                        ${(product.priceInCents / 100).toFixed(2)}
                      </p>
                    </div>
                    <ProductActions
                      slug={slug}
                      product={product}
                      buyButtonClass={buyButtonClass}
                      detailsLinkClass={detailsLinkClass}
                      className="sm:w-64"
                    />
                  </li>
                ))}
              </ul>
            ) : theme.layout === "featured" && products.length > 0 ? (
              <div className={`flex flex-col ${gap}`}>
                <div
                  className={`grid grid-cols-1 items-center overflow-hidden border border-[var(--brand-text)]/[.08] bg-[var(--brand-surface)] ${cardRadius} ${shadow} md:grid-cols-2`}
                >
                  <div className="aspect-square w-full overflow-hidden bg-[var(--brand-text)]/[.05]">
                    <ProductImage product={products[0]} className="h-full w-full object-cover" />
                  </div>
                  <div className="p-6 md:p-8">
                    <p className="text-xs font-medium uppercase tracking-wide text-[var(--brand-accent)]">
                      Featured
                    </p>
                    <h3 className="mt-2 font-[var(--font-heading)] text-2xl font-semibold">
                      {products[0].name}
                    </h3>
                    {products[0].description && (
                      <p className="mt-2 text-[var(--brand-text-secondary)]">
                        {products[0].description}
                      </p>
                    )}
                    <p className="mt-4 text-2xl font-semibold">
                      ${(products[0].priceInCents / 100).toFixed(2)}
                    </p>
                    <ProductActions
                      slug={slug}
                      product={products[0]}
                      buyButtonClass={buyButtonClass}
                      detailsLinkClass={detailsLinkClass}
                      className="mt-4 max-w-sm"
                    />
                  </div>
                </div>

                {products.length > 1 && (
                  <ul className={`grid grid-cols-1 ${gap} sm:grid-cols-2 lg:grid-cols-3`}>
                    {products.slice(1).map((product) => (
                      <ProductCard
                        key={product.id}
                        slug={slug}
                        product={product}
                        buyButtonClass={buyButtonClass}
                        detailsLinkClass={detailsLinkClass}
                        cardClass={cardClass}
                      />
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <ul className={`grid grid-cols-1 ${gap} sm:grid-cols-2 lg:grid-cols-3`}>
                {products.map((product) => (
                  <ProductCard
                    key={product.id}
                    slug={slug}
                    product={product}
                    buyButtonClass={buyButtonClass}
                    detailsLinkClass={detailsLinkClass}
                    cardClass={cardClass}
                  />
                ))}
              </ul>
            )}
          </main>
        );

      case "faq":
        return (
          homepage &&
          homepage.faq.length > 0 && (
            <section key={key} id={key} className="border-t border-[var(--brand-text)]/[.08]">
              <div className={`mx-auto max-w-2xl px-8 ${sectionPadding}`}>
                <h2 className="text-center font-[var(--font-heading)] text-2xl font-semibold">
                  Frequently Asked Questions
                </h2>
                <div className="mt-8 flex flex-col gap-3">
                  {homepage.faq.map((item, i) => (
                    <details
                      key={i}
                      className={`border border-[var(--brand-text)]/[.08] bg-[var(--brand-surface)] p-4 ${cardRadius}`}
                    >
                      <summary className="cursor-pointer font-medium">{item.question}</summary>
                      <p className="mt-2 text-sm text-[var(--brand-text-secondary)]">
                        {item.answer}
                      </p>
                    </details>
                  ))}
                </div>
              </div>
            </section>
          )
        );

      case "newsletter":
        return (
          homepage?.newsletterSection && (
            <section
              key={key}
              id={key}
              className="border-t border-[var(--brand-text)]/[.08] bg-[var(--brand-surface)]"
            >
              <div className={`mx-auto max-w-xl px-8 text-center ${sectionPadding}`}>
                <p className="text-[var(--brand-text-secondary)]">
                  {homepage.newsletterSection}
                </p>
                {subscribed === "1" ? (
                  <p className="mt-4 font-medium">You&apos;re on the list — thank you!</p>
                ) : (
                  <form
                    action={subscribeToNewsletter.bind(null, slug)}
                    className="mx-auto mt-4 flex max-w-sm flex-col gap-2 sm:flex-row"
                  >
                    <input
                      name="email"
                      type="email"
                      required
                      placeholder="you@example.com"
                      className={`flex-1 border border-[var(--brand-text)]/[.15] bg-[var(--brand-background)] px-4 py-2 text-sm ${buttonRadius}`}
                    />
                    <SubmitButton
                      pendingText="Joining..."
                      className={`bg-[var(--brand-accent)] px-5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 ${buttonRadius}`}
                    >
                      Sign Up
                    </SubmitButton>
                  </form>
                )}
              </div>
            </section>
          )
        );

      default:
        return null;
    }
  }

  function renderHeroCta() {
    if (products.length === 0) return null;
    const primaryLabel = homepage?.primaryCallToAction || "Shop Now";
    const secondaryLabel = homepage?.secondaryCallToAction;

    if (ctaEmphasis === "minimal") {
      return (
        <div className="mt-8 flex flex-wrap items-center justify-center gap-6">
          <a
            href="#products"
            className="text-base font-medium underline decoration-[var(--brand-accent)] underline-offset-4 transition-opacity hover:opacity-70"
          >
            {primaryLabel} &rarr;
          </a>
          {secondaryLabel && (
            <a
              href={secondaryCtaTarget}
              className="text-sm text-[var(--brand-text-secondary)] underline underline-offset-4 transition-opacity hover:opacity-70"
            >
              {secondaryLabel}
            </a>
          )}
        </div>
      );
    }

    if (ctaEmphasis === "banner") {
      return (
        <div className="-mx-8 mt-8 bg-[var(--brand-accent)] px-8 py-5 text-center">
          <a
            href="#products"
            className="text-lg font-semibold text-white transition-opacity hover:opacity-90"
          >
            {primaryLabel}
          </a>
          {secondaryLabel && (
            <a
              href={secondaryCtaTarget}
              className="ml-4 text-sm text-white/90 underline underline-offset-4 transition-opacity hover:opacity-100"
            >
              {secondaryLabel}
            </a>
          )}
        </div>
      );
    }

    // "button" (default) — today's exact markup
    return (
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <a
          href="#products"
          className={`inline-block ${buttonRadius} bg-[var(--brand-accent)] px-8 py-3 text-base font-medium text-white transition-opacity hover:opacity-90`}
        >
          {primaryLabel}
        </a>
        {secondaryLabel && (
          <a
            href={secondaryCtaTarget}
            className={`inline-block ${buttonRadius} border border-[var(--brand-text)]/[.15] px-8 py-3 text-base font-medium transition-colors hover:bg-[var(--brand-text)]/[.05]`}
          >
            {secondaryLabel}
          </a>
        )}
      </div>
    );
  }

  function renderHero() {
    const heading = homepage?.heroHeadline || storeName;
    const subheading = homepage?.heroSubheadline || storeTagline || storeDescription;

    if (heroLayout === "split") {
      // Priority 4 fix — the hero used to fall back straight to
      // products[0]'s own image, coupling storefront identity to array
      // order and to whichever product happened to get a real photo. A
      // deliberately-sourced hero image (see lib/productImagery.ts) is now
      // the primary source; products[0] stays as a real fallback for
      // stores created before this existed or when sourcing failed, and
      // the gradient stays the last resort — never worse than before, but
      // no longer dependent on product-array position for the common case.
      const heroImage = homepage?.heroImageUrl || products[0]?.imageUrl;
      return (
        <header className="border-b border-[var(--brand-text)]/[.08]">
          <div
            className={`mx-auto grid max-w-6xl grid-cols-1 items-center gap-10 px-8 md:grid-cols-2 ${sectionPadding}`}
          >
            <div className="text-center md:text-left">
              <h1 className={`font-[var(--font-heading)] ${h1Class}`}>{heading}</h1>
              <p className="mx-auto mt-4 max-w-xl text-lg text-[var(--brand-text-secondary)] md:mx-0">
                {subheading}
              </p>
              {renderHeroCta()}
            </div>
            <div className={`aspect-square w-full overflow-hidden ${imageFrame}`}>
              {heroImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={heroImage} alt={storeName} className="h-full w-full object-cover" />
              ) : (
                <div className="h-full w-full bg-gradient-to-br from-[var(--brand-primary)] via-[var(--brand-accent)] to-[var(--brand-secondary)]" />
              )}
            </div>
          </div>
        </header>
      );
    }

    if (heroLayout === "fullBleed") {
      return (
        <header className="relative overflow-hidden border-b border-[var(--brand-text)]/[.08]">
          <div className="absolute inset-0 bg-gradient-to-br from-[var(--brand-accent)]/10 via-transparent to-[var(--brand-primary)]/10" />
          <div className={`relative px-8 text-center ${sectionPadding}`}>
            <h1 className={`font-[var(--font-heading)] ${h1Class}`}>{heading}</h1>
            <p className="mx-auto mt-4 max-w-xl text-lg text-[var(--brand-text-secondary)]">
              {subheading}
            </p>
            {renderHeroCta()}
          </div>
        </header>
      );
    }

    if (heroLayout === "minimal") {
      return (
        <header className="border-b border-[var(--brand-text)]/[.08] px-8 py-10 text-center">
          <h1 className="font-[var(--font-heading)] text-2xl font-semibold tracking-tight sm:text-3xl">
            {heading}
          </h1>
          <p className="mx-auto mt-3 max-w-lg text-base text-[var(--brand-text-secondary)]">
            {subheading}
          </p>
          {renderHeroCta()}
        </header>
      );
    }

    // "centered" (default) — today's exact markup
    return (
      <header className={`border-b border-[var(--brand-text)]/[.08] px-8 text-center ${sectionPadding}`}>
        <h1 className={`font-[var(--font-heading)] ${h1Class}`}>{heading}</h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-[var(--brand-text-secondary)]">
          {subheading}
        </p>
        {renderHeroCta()}
      </header>
    );
  }

  return (
    <div
      style={themeCssVars(theme)}
      className="min-h-screen bg-[var(--brand-background)] font-[var(--font-body)] text-[var(--brand-text)]"
    >
      {fontsUrl && <link rel="stylesheet" href={fontsUrl} />}
      {!store.published && viewerRole && <PreviewModeBanner />}

      {/* Customer-facing nav — store name plus real, content-backed links
          only. Desktop shows them inline; mobile gets a proper collapsed
          menu (MobileNav) rather than letting a growing link list wrap
          unpredictably. */}
      <nav className="relative border-b border-[var(--brand-text)]/[.08] px-8 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <span className="font-[var(--font-heading)] text-lg font-semibold">{storeName}</span>
          {navLinks.length > 0 && (
            <>
              <div className="hidden items-center gap-6 md:flex">
                {navLinks.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    className="text-sm text-[var(--brand-text-secondary)] transition-colors hover:text-[var(--brand-text)]"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
              <MobileNav links={navLinks} />
            </>
          )}
        </div>
      </nav>

      {renderHero()}

      {/* Brand promise — a fixed, recurring anchor, not just another content block */}
      {brandIdentity?.brandPromise && (
        <div className="border-b border-[var(--brand-text)]/[.08] bg-[var(--brand-accent)]/5 px-8 py-4 text-center">
          <p className="text-sm">
            <span className="font-medium">Our Promise:</span> {brandIdentity.brandPromise}
          </p>
        </div>
      )}

      {sectionOrder.map((key) => renderSection(key))}

      {/* Footer */}
      <footer className="border-t border-[var(--brand-text)]/[.08] px-8 py-10 text-center text-sm text-[var(--brand-text-secondary)]">
        {homepage?.footerContent && <p>{homepage.footerContent}</p>}
        <p className="mt-2">
          &copy; {new Date().getFullYear()} {store.name}
        </p>
      </footer>
    </div>
  );
}

function ProductActions({
  slug,
  product,
  buyButtonClass,
  detailsLinkClass,
  className,
}: {
  slug: string;
  product: StoreProduct;
  buyButtonClass: string;
  detailsLinkClass: string;
  className?: string;
}) {
  return (
    <div className={`flex gap-2 ${className ?? ""}`}>
      <BuyButton slug={slug} product={product} className={buyButtonClass} />
      <Link href={`/store/${slug}/products/${product.id}`} className={detailsLinkClass}>
        View Details
      </Link>
    </div>
  );
}

function ProductCard({
  slug,
  product,
  buyButtonClass,
  detailsLinkClass,
  cardClass,
}: {
  slug: string;
  product: StoreProduct;
  buyButtonClass: string;
  detailsLinkClass: string;
  cardClass: string;
}) {
  return (
    <li className={cardClass}>
      <Link href={`/store/${slug}/products/${product.id}`}>
        <div className="aspect-square w-full overflow-hidden bg-[var(--brand-text)]/[.05]">
          <ProductImage
            product={product}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        </div>
      </Link>
      <div className="p-4">
        <h3 className="font-[var(--font-heading)] font-semibold">{product.name}</h3>
        {product.description && (
          <p className="mt-1 line-clamp-2 text-sm text-[var(--brand-text-secondary)]">
            {product.description}
          </p>
        )}
        <p className="mt-3 text-lg font-semibold">
          ${(product.priceInCents / 100).toFixed(2)}
        </p>
        <ProductActions
          slug={slug}
          product={product}
          buyButtonClass={buyButtonClass}
          detailsLinkClass={detailsLinkClass}
          className="mt-3"
        />
      </div>
    </li>
  );
}
