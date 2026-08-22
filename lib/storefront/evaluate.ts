import { prisma } from "@/lib/prisma";
import { AssetSchema } from "@/lib/businessModel/entities";
import { ASSET_ROLES } from "@/lib/businessModel/assets";
import { DEFAULT_THEME, heroLayoutOf, heroLayoutRendersImage, type Theme } from "@/lib/theme";

// What J4 can actually see about a storefront's composition (2026-08-18).
//
// P2/P3. Sean: "we don't just want 'J4 generated a website'. We want 'J4
// understands what makes this business visually compelling and can continuously
// improve the website with the owner.'"
//
// The missing piece was never the ability to CHANGE the storefront —
// refine_storefront has done that for a while. It was the ability to LOOK at
// it. J4 had no structural read of its own store, so it could act on a request
// but never form an opinion worth hearing.
//
// FACTS, NOT OPINIONS. Everything here is counted or checked against real rows.
// The judgement about what matters belongs to J4 in the conversation, not to a
// severity constant in a library — same discipline the BI engine already
// follows, and the reason "J4 doesn't surface everything he can detect" holds.
//
// IT NOW READS blueprint.homepageContent.heroImageUrl (2026-08-22). This
// comment used to say the opposite — "that field exists only in Sean's
// uncommitted working tree, not in HEAD" — which was true when it was written
// and stopped being true when updateHero.ts landed. A stale reason to skip a
// fact is worse than no reason, because it reads as a decision.
//
// The fact it was missing matters: hasHeroGraphic below is about an ASSET the
// owner owns with the role storefront.hero, which is a different question from
// whether the storefront actually shows a hero image. J4 could truthfully
// report "Hero composition: yes" about a page that has none, and then reason
// from it — the exact acknowledge-then-ignore gap this whole area exists to
// close.

export interface StorefrontFinding {
  key: string;
  /** What is true, in J4's own reading. */
  observed: string;
  /** What J4 would do about it. Empty when there is nothing to do. */
  wouldDo: string;
  /**
   * A composition that would address it, when one would. The surface and
   * columns are real keys the composition layer already understands, so a
   * finding can be acted on without translation.
   */
  composition?: { surface: string; columns: number; subject: string | null };
}

export interface StorefrontEvaluation {
  productCount: number;
  productsWithImages: number;
  /** Images the owner has that are NOT product photos — the editorial pool. */
  editorialImageCount: number;
  hasLogo: boolean;
  /**
   * Is a hero image ACTUALLY VISIBLE on the storefront right now?
   *
   * Not "is one saved" — three of the four hero layouts render no image at all,
   * and the default is one of them. Read through the same predicate the
   * storefront itself renders through, so J4's read of the page and the page
   * cannot disagree.
   */
  heroImageIsLive: boolean;
  hasHeroGraphic: boolean;
  hasFeatureGraphic: boolean;
  /** Distinct product categories, which is what makes grouping possible. */
  categories: string[];
  findings: StorefrontFinding[];
}

export async function evaluateStorefront(storeId: string): Promise<StorefrontEvaluation> {
  const [products, assetRows, store] = await Promise.all([
    prisma.product.findMany({
      where: { storeId },
      select: { name: true, imageUrl: true, description: true },
    }),
    prisma.businessRecord.findMany({
      where: { storeId, entityType: "asset" },
      orderBy: { syncedAt: "desc" },
      select: { data: true },
    }),
    prisma.store.findUnique({ where: { id: storeId }, select: { blueprint: true, theme: true } }),
  ]);

  const homepage = (store?.blueprint as { homepageContent?: { heroImageUrl?: string | null } } | null)
    ?.homepageContent;
  const theme = (store?.theme as Theme | null) ?? DEFAULT_THEME;
  const heroImageIsLive = Boolean(homepage?.heroImageUrl) && heroLayoutRendersImage(heroLayoutOf(theme));

  const productImageUrls = new Set(products.map((p) => p.imageUrl).filter(Boolean) as string[]);

  let hasLogo = false;
  let hasHeroGraphic = false;
  let hasFeatureGraphic = false;
  let editorialImageCount = 0;

  for (const row of assetRows) {
    const parsed = AssetSchema.safeParse(row.data);
    if (!parsed.success) continue;
    const a = parsed.data;
    if (a.supersededByAssetId) continue;
    if (a.role === "brand.logo") hasLogo = true;
    if (a.role === ASSET_ROLES.storefrontHero) hasHeroGraphic = true;
    if (a.role === "storefront.feature") hasFeatureGraphic = true;
    // Editorial = a real photo the owner has that is not already a product
    // image and is not scaffolding. This is the pool Sean described: "images
    // that aren't products can live elsewhere in the composition."
    if (
      a.fileType === "photo" &&
      !a.role?.startsWith("surface.") &&
      a.role !== "brand.logo" &&
      !productImageUrls.has(a.storageUrl)
    ) {
      editorialImageCount++;
    }
  }

  const productsWithImages = products.filter((p) => p.imageUrl).length;

  // WHAT ACTUALLY GROUPS A CATALOG (corrected 2026-08-18 against real data).
  //
  // The first version counted LEADING words and, on Cubit & Coil, reported
  // "sacred" and "177hz". A person looking at that catalog sees bracelets,
  // necklaces, rings and pyramids — product-type nouns that sit at the END of
  // names like "Sacred Cubit Copper Tensor Ring Bracelet". Leading words find
  // the brand's vocabulary; trailing nouns find the collections, which is what
  // Sean actually asked for.
  //
  // So every significant word in every name is counted, wherever it appears,
  // and the ones shared by several products are the candidate groupings. Still
  // a proxy reported as a possibility, never asserted as a taxonomy — a real
  // category field would beat this the day one exists.
  const STOPWORDS = new Set([
    "the", "a", "an", "our", "my", "your", "new", "and", "of", "for", "with",
    "on", "in", "to", "set", "size", "lg", "sm", "mini", "double", "handcrafted",
  ]);
  const wordCounts = new Map<string, number>();
  for (const p of products) {
    // Unique per product, so "Ring ... Ring" in one name is not two votes.
    const words = new Set(
      p.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    );
    for (const w of words) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
  }
  // A GROUPING COVERS A SUBSET, NOT THE CATALOGUE (corrected against real
  // data, second pass). Filtering only words present in EVERY product still
  // returned "tensor", "ring", "copper" for Cubit & Coil — the brand's own
  // vocabulary, in 8 to 12 of 14 products. Those describe what the shop sells;
  // they do not divide it. "necklace" and "bracelet" do, and they are rarer.
  //
  // So a candidate grouping has to appear in at least two products and no more
  // than half of them. That is what makes it a collection rather than a
  // description of the whole shop.
  const groupingCeiling = Math.max(2, Math.floor(products.length / 2));
  const categories = [...wordCounts.entries()]
    .filter(([, n]) => n >= 2 && n <= groupingCeiling)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .slice(0, 4);

  const findings: StorefrontFinding[] = [];

  if (productsWithImages >= 3 && !hasHeroGraphic) {
    findings.push({
      key: "no_hero_composition",
      observed: `You have ${productsWithImages} products with real photography and nothing composed at the top of the store, so the first thing a visitor sees is a grid.`,
      wouldDo:
        "Compose a hero band from your strongest product shots, so the store opens with something arranged rather than a row of cards.",
      composition: { surface: "section.hero", columns: 3, subject: null },
    });
  }

  if (productsWithImages >= 4 && categories.length > 0 && !hasFeatureGraphic) {
    findings.push({
      key: "products_could_be_grouped",
      observed: `Several products share a word: ${categories.join(", ")}. Some of those are collections worth their own section; others are just how you describe everything you sell.`,
      wouldDo:
        "Pick the ones that are genuinely a group and give each its own featured section, composed as a set, so the catalog reads as collections instead of one long list.",
      // DELIBERATELY NO COMPOSITION. Choosing WHICH candidate is a real
      // collection is a judgement, and the first pass got it wrong: ranked by
      // frequency it picked "cubit" for Cubit & Coil — a brand term — over
      // "necklace" and "bracelet", which are the actual collections. A library
      // counting words cannot tell those apart; J4 reading the list can, and
      // then calls create_composition with the right subject. Facts here,
      // judgement in the conversation.
    });
  }

  if (editorialImageCount >= 2) {
    findings.push({
      key: "editorial_imagery_unused",
      observed: `You have ${editorialImageCount} images that aren't product photos and aren't being used anywhere in the composition.`,
      wouldDo:
        "Use them as brand and lifestyle imagery in their own band, kept separate from the product cards so they tell the story rather than compete with the catalog.",
      composition: { surface: "section.collage", columns: 2, subject: null },
    });
  }

  if (productCountNeedsPhotos(products.length, productsWithImages)) {
    findings.push({
      key: "products_missing_photos",
      observed: `${products.length - productsWithImages} of your ${products.length} products have no photo, so they render as blank cards next to the ones that do.`,
      // No composition: composing around a gap would hide it. The honest fix
      // is the missing photograph, and saying so is more useful than papering
      // over it with a layout.
      wouldDo: "Get a photo on those first — a composition can't fix a blank card, it can only frame it.",
    });
  }

  if (!hasLogo) {
    findings.push({
      key: "no_logo",
      observed: "There's no logo saved, so the store has no consistent mark across the header, packaging or anything you make.",
      wouldDo: "Make one, or upload the one you already use, and everything after that can be built around it.",
    });
  }

  return {
    productCount: products.length,
    productsWithImages,
    editorialImageCount,
    heroImageIsLive,
    hasLogo,
    hasHeroGraphic,
    hasFeatureGraphic,
    categories,
    findings,
  };
}

function productCountNeedsPhotos(total: number, withImages: number): boolean {
  return total > 0 && withImages < total;
}

/** The evaluation as J4 would read it, for the conversation's own context. */
export function summariseEvaluation(evaluation: StorefrontEvaluation): string {
  const lines = [
    `${evaluation.productCount} products, ${evaluation.productsWithImages} with photos.`,
    `${evaluation.editorialImageCount} non-product images available.`,
    `Logo: ${evaluation.hasLogo ? "yes" : "none"}. Hero composition: ${evaluation.hasHeroGraphic ? "yes" : "none"}. Featured section: ${evaluation.hasFeatureGraphic ? "yes" : "none"}.`,
    // Said separately from "hero composition" above, and deliberately, because
    // they are different facts: one is an image the owner owns, the other is
    // what a visitor sees. Collapsing them is how J4 ends up describing a page
    // that does not exist.
    `Hero image live on the storefront: ${evaluation.heroImageIsLive ? "yes" : "no"}.`,
  ];
  if (evaluation.categories.length > 0) {
    lines.push(`Possible groupings: ${evaluation.categories.join(", ")}.`);
  }
  for (const f of evaluation.findings) {
    lines.push(`- ${f.observed} ${f.wouldDo}`);
  }
  return lines.join("\n");
}
