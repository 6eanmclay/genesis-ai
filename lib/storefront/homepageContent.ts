import { prisma } from "@/lib/prisma";

// THE ONE WRITER FOR blueprint.homepageContent (2026-08-21).
//
// Consolidating two, at the explicit request of the code that created the
// second: composeForStorefront.ts's own note read "Sean has uncommitted work on
// update_hero that writes the same field from an asset. That is the same
// destination reached from a different door, not a competing pipeline — when his
// work lands, the two should be consolidated onto one writer rather than left as
// two."
//
// Both doors are real and both stay: an owner approving a hero change in
// conversation (updateHero), and a design composition being applied
// (setStorefrontHeroImage). What must not be two is the WRITE — a blueprint is
// one JSON column, and two functions independently spreading and re-saving it
// is how a headline silently disappears because the other path read the row a
// moment earlier.
//
// MERGES, NEVER REPLACES, at both levels. The blueprint carries theme, section
// order and marketing assets alongside homepageContent; homepageContent carries
// headlines and calls to action alongside the hero image. Overwriting either to
// set one field is the exact bug this shape exists to prevent.

/**
 * Apply a patch to `blueprint.homepageContent`, leaving everything else alone.
 *
 * A key present with `undefined` is not a value — it is omitted from the patch
 * entirely, so "this proposal did not mention the hero image" and "clear the
 * hero image" stay distinguishable. `null` is the real clear.
 */
export async function writeHomepageContent(
  storeId: string,
  patch: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { blueprint: true },
  });

  const blueprint =
    store.blueprint && typeof store.blueprint === "object" && !Array.isArray(store.blueprint)
      ? (store.blueprint as Record<string, unknown>)
      : {};
  const homepage =
    blueprint.homepageContent &&
    typeof blueprint.homepageContent === "object" &&
    !Array.isArray(blueprint.homepageContent)
      ? (blueprint.homepageContent as Record<string, unknown>)
      : {};

  const applied = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const homepageContent = { ...homepage, ...applied };

  await prisma.store.update({
    where: { id: storeId },
    data: { blueprint: { ...blueprint, homepageContent } as never },
  });

  return homepageContent;
}
