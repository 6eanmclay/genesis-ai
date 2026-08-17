import { prisma } from "@/lib/prisma";
import { AssetSchema } from "@/lib/businessModel/entities";

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
// DELIBERATELY DOES NOT READ blueprint.homepageContent.heroImageUrl. That field
// exists only in Sean's uncommitted working tree, not in HEAD. Depending on it
// would entangle this with in-flight work and break a clean checkout.

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
  hasHeroGraphic: boolean;
  hasFeatureGraphic: boolean;
  /** Distinct product categories, which is what makes grouping possible. */
  categories: string[];
  findings: StorefrontFinding[];
}

export async function evaluateStorefront(storeId: string): Promise<StorefrontEvaluation> {
  const [products, assetRows] = await Promise.all([
    prisma.product.findMany({
      where: { storeId },
      select: { name: true, imageUrl: true, description: true },
    }),
    prisma.businessRecord.findMany({
      where: { storeId, entityType: "asset" },
      orderBy: { syncedAt: "desc" },
      select: { data: true },
    }),
  ]);

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
    if (a.role === "storefront.hero") hasHeroGraphic = true;
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
  // Grouping needs something to group BY. Product names are the only signal
  // available without a category field, so a shared leading word is the honest
  // proxy — and it is reported as a possibility, never asserted as a taxonomy.
  // Stopwords, because the first real run grouped a store on the word "the".
  // A shared article is not a collection, and reporting it as one would have J4
  // recommending a "The" section with a straight face.
  const STOPWORDS = new Set(["the", "a", "an", "our", "my", "your", "new", "and", "of", "for"]);
  const leadingWords = products
    .map((p) => p.name.trim().split(/\s+/)[0]?.toLowerCase())
    .filter((w): w is string => Boolean(w) && !STOPWORDS.has(w) && w.length > 2);
  const wordCounts = new Map<string, number>();
  for (const w of leadingWords) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
  const categories = [...wordCounts.entries()].filter(([, n]) => n >= 2).map(([w]) => w);

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
      observed: `Several products share a name pattern (${categories.slice(0, 3).join(", ")}), which usually means they belong together as a collection rather than sitting in one flat grid.`,
      wouldDo:
        "Give that group its own featured section, composed as a set, so the catalog reads as collections instead of one long list.",
      composition: { surface: "section.feature", columns: 2, subject: categories[0] },
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
  ];
  if (evaluation.categories.length > 0) {
    lines.push(`Possible groupings: ${evaluation.categories.join(", ")}.`);
  }
  for (const f of evaluation.findings) {
    lines.push(`- ${f.observed} ${f.wouldDo}`);
  }
  return lines.join("\n");
}
