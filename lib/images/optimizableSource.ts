// WHICH IMAGE SOURCES GENESIS OWNS (2026-09-19).
//
// The single answer to "may Next's optimizer touch this?", used by
// components/StoreImage.tsx and by nothing else. It lives here rather than
// inside that component for one reason: it is a policy, not a React concern,
// and a policy that cannot be unit-tested without booting a browser is a
// policy that gets tested loosely or not at all.
//
// ============ WHY THE QUESTION IS ABOUT THE HOST, NOT THE FILE =========
//
// `next/image` does not degrade on a source `remotePatterns` does not cover —
// it THROWS at render, which turns one broken thumbnail into a 500 for the
// whole page. So the question this answers is never "is this a nice image?"
// but "did we put it there?".
//
// And we genuinely do not own every image we render. Two established cases:
//
//   - Product.imageUrl. lib/sourcing/adopt.ts creates a real Product with
//     `imageUrl: candidate.imageUrl`, straight off a provider API (see
//     lib/sourcing/aliexpress.ts's product_main_image_url).
//   - Store.logoUrl. `update_brand_logo` takes `imageUrl: z.string()` with no
//     URL validation and no ownership resolution — updateHero's
//     resolveOwnedImageUrl has no counterpart on the logo path — so an
//     owner-approved external logo is a legitimate stored value. The guard
//     there is authorization (always_ask), not format or host.
//
// An allowlist of supplier hosts was considered and rejected by Sean: that set
// is open-ended, and the failure mode for a missed entry is a dead page rather
// than a large image.

/**
 * The one host whose images are ours. A Vercel Blob public URL is
 * `<storeId>.public.blob.vercel-storage.com`, where the subdomain is the blob
 * STORE id — fixed for the lifetime of the store, NOT per deployment. Three
 * components once carried the opposite claim and skipped the optimizer
 * entirely because of it.
 */
export const OWNED_IMAGE_HOST_SUFFIX = ".public.blob.vercel-storage.com";

/**
 * Can Next's optimizer actually serve this source?
 *
 * Deliberately the same shape as the `remotePatterns` entry in
 * next.config.ts, including the refusal of query strings — if these two ever
 * disagree, the disagreement surfaces as a render-time throw in production.
 * verify-store-image-host-rule.ts asserts they agree.
 */
export function isOptimizableImageSrc(src: string): boolean {
  // A path into public/, covered by Next's default localPatterns. `//` is
  // excluded deliberately: a protocol-relative URL is a REMOTE host wearing a
  // local path's clothes, and treating it as local would hand an arbitrary
  // origin to the optimizer.
  if (src.startsWith("/")) return !src.startsWith("//");
  try {
    const u = new URL(src);
    return (
      u.protocol === "https:" &&
      u.hostname.endsWith(OWNED_IMAGE_HOST_SUFFIX) &&
      u.search === ""
    );
  } catch {
    // Not a URL we can reason about — so not one we hand to the optimizer.
    return false;
  }
}
