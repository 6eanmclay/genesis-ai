import Image from "next/image";
import { isOptimizableImageSrc } from "@/lib/images/optimizableSource";

// ONE IMAGE OF A STORE'S, OPTIMIZED ONLY WHEN WE OWN THE HOST (2026-09-18).
//
// ============ WHY THIS IS SHARED, AND STILL CALLED StoreImage ==========
//
// Hoisted out of app/store/[slug]/ on 2026-09-19 so the dashboard's business
// logo uses this implementation rather than a second one. The rule below is
// the whole reason this component exists, and a copy of it in another folder
// is a copy that can drift — the same hand-maintained-duplicate shape that has
// already cost this repo a Traffic branch and a lane classifier.
//
// The name still fits: every consumer renders an image belonging to a Store —
// its products, and now its logo. There is exactly one host rule here and one
// remotePatterns entry in next.config.ts, and they are written to match.
//
// ============ WHY THIS EXISTS AND NOT A BARE next/image ================
//
// Converting the storefront to next/image straight through crashed checkout.
// `next/image` does not degrade on a remote src that remotePatterns does not
// cover — it THROWS at render, which turns a broken thumbnail into a 500 for
// the whole page. verify-checkout-presentation caught it on a fixture whose
// product image is `https://images.example.test/ring.png`.
//
// That fixture is not artificial. `Product.imageUrl` is NOT always a Blob URL:
// lib/sourcing/adopt.ts creates a real Product with `imageUrl:
// candidate.imageUrl`, and those candidates carry supplier hosts straight from
// the provider APIs (lib/sourcing/aliexpress.ts reads
// `product_main_image_url`; Printful the same). So any storefront selling an
// adopted dropship product would have stopped rendering entirely.
//
// Allow-listing the suppliers is not the fix. The set is open — every new
// provider, and every CDN host a provider decides to use, would be one more
// entry, and the failure mode for a missed one is a dead storefront rather
// than a large image.
//
// ============ THE RULE =================================================
//
// Optimize what we control, and leave everything else EXACTLY as it rendered
// before: a plain <img>, same classes, same box. A supplier image is then no
// worse than it was, and a Blob image — which is all of our own generated and
// uploaded artwork, and the whole of the 9.44GB problem — gets the variant.
//
// This also fails in the safe direction. An unrecognised host renders as it
// always did instead of taking the page down with it.

// The rule itself lives in lib/images/optimizableSource.ts so it can be
// unit-tested against next.config.ts without booting a browser. Re-exported
// here because this component is where callers already look for it.
export { isOptimizableImageSrc };

type Common = {
  src: string;
  alt: string;
  className?: string;
  /** Only for the LCP image. `preload`, not the `priority` Next 16 deprecated. */
  preload?: boolean;
};

type Sized =
  | { fill: true; sizes: string; width?: never; height?: never }
  | { fill?: false; sizes?: string; width: number; height: number };

export function StoreImage({ src, alt, className, preload, ...size }: Common & Sized) {
  if (!isOptimizableImageSrc(src)) {
    // THE ORIGINAL ELEMENT, UNCHANGED. Same tag, same classes, same box as
    // before any of this — which is the point: a host we do not control must
    // not be able to change how this page renders, let alone whether it does.
    return (
      // A host outside remotePatterns makes next/image throw, and this is the
      // deliberate fallback for exactly that case — see the header.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt}
        className={className}
        {...(size.fill ? {} : { width: size.width, height: size.height })}
      />
    );
  }

  if (size.fill) {
    return <Image src={src} alt={alt} fill sizes={size.sizes} preload={preload} className={className} />;
  }
  return (
    <Image
      src={src}
      alt={alt}
      width={size.width}
      height={size.height}
      preload={preload}
      className={className}
    />
  );
}
