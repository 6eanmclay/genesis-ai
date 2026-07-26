import { themeCssVars, heroLayoutOf, type Theme } from "@/lib/theme";

// A compact, non-interactive rendering of a store's hero section — reuses
// the store's real theme tokens (colors, fonts, hero layout) so a
// current-vs-proposed comparison is an authentic small view of the brand,
// not a generic mock. Deliberately fixed at a small type scale regardless
// of the theme's own typeScale (lib/theme.ts's HEADING_SCALE goes up to
// text-7xl, far too large for a side-by-side comparison card) and
// simplified to the two layouts that meaningfully differ at this size —
// image-paired ("split") vs. centered text (everything else, since
// fullBleed/minimal mostly differ from centered in full-page spacing/
// gradients that don't read at card scale).
export function HeroMock({
  theme,
  storeName,
  tagline,
  heroHeadline,
  heroSubheadline,
  productImage,
}: {
  theme: Theme;
  storeName: string;
  tagline: string | null;
  heroHeadline: string;
  heroSubheadline: string;
  productImage: string | null;
}) {
  const heading = heroHeadline || storeName;
  const subheading = heroSubheadline || tagline || "";
  const isSplit = heroLayoutOf(theme) === "split" && productImage;

  return (
    <div
      style={themeCssVars(theme)}
      className="overflow-hidden rounded-xl border border-[var(--brand-text,#18181b)]/10 bg-[var(--brand-background)] font-[var(--font-body)] text-[var(--brand-text)]"
    >
      {isSplit ? (
        <div className="grid grid-cols-2 items-center gap-4 p-5">
          <div>
            <p className="font-[var(--font-heading)] text-xl font-bold leading-tight">{heading}</p>
            <p className="mt-1.5 text-xs text-[var(--brand-text-secondary)]">{subheading}</p>
            <span className="mt-3 inline-block rounded-full bg-[var(--brand-accent)] px-3 py-1 text-[11px] font-medium text-white">
              Shop Now
            </span>
          </div>
          <div className="aspect-square w-full overflow-hidden rounded-lg bg-[var(--brand-text)]/5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={productImage ?? undefined} alt="" className="h-full w-full object-cover" />
          </div>
        </div>
      ) : (
        <div className="p-6 text-center">
          <p className="font-[var(--font-heading)] text-2xl font-bold leading-tight">{heading}</p>
          <p className="mx-auto mt-2 max-w-xs text-xs text-[var(--brand-text-secondary)]">{subheading}</p>
          <span className="mt-3 inline-block rounded-full bg-[var(--brand-accent)] px-4 py-1.5 text-[11px] font-medium text-white">
            Shop Now
          </span>
        </div>
      )}
    </div>
  );
}
