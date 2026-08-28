import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { requireBusinessOrActive, PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/integrations/credentials";
import { refreshPrintfulToken, type PrintfulCredentials } from "@/lib/integrations/printful";
import {
  printfulUrl,
  printfulHeaders,
  isStoreScoped,
  withSellingRegion,
  PRINTFUL_MAX_LIMIT,
} from "@/lib/creation/printfulRequest";
import { CREATABLES, creatableById, garmentMatches } from "@/lib/creation/creatables";

// WHAT PRINTFUL SENDS, PER PRODUCT TYPE — measured, not assumed.
//
// ============ WHY THIS EXISTS (2026-08-27) ==============================
//
// The hoodie took four rounds because I inferred the response shape instead of
// reading it. What ended it was fetching the actual file and looking at its
// pixels: opaque white background, garment at ~10% alpha. A shading layer, not
// a photograph — and every failure followed from not knowing that.
//
// Sean, before touching any other product: "Do not generalize the hoodie
// solution to other products until the trace proves that they use the same
// rendering model. In particular, investigate the mug carefully because its
// rendering/composition may be fundamentally different."
//
// He is right to single it out. A hoodie is fabric photographed flat; a mug is
// a glazed cylinder whose printable area WRAPS. There is no reason those share
// a composition model, and finding out costs one request each.
//
// ============ WHAT IT DISCLOSES ========================================
//
// Structure and statistics. Field names, which colour fields are present,
// declared placements, and an alpha profile of one real image. URLs come back
// as host and path only — a signed CDN URL is a credential of a sort. Nothing
// is written; it is read and returned to the owner who asked.

function hexOrNull(v: unknown): string | null {
  return typeof v === "string" && /^#?[0-9a-f]{3,8}$/i.test(v.trim()) ? v.trim() : null;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "<unparseable>";
  }
}

/**
 * What KIND of image this is, from its alpha channel.
 *
 * The shapes that behave completely differently when a colour has to be
 * applied — and the hoodie turned out to be the least obvious of them:
 *
 *   shading-layer  background opaque, subject nearly transparent. The colour
 *                  goes UNDER it and the alpha is inverted to drop the
 *                  background. This is the Gildan 18500.
 *   cutout         background transparent, subject opaque. Already a picture
 *                  of a finished product; recolouring it is not possible.
 *   flat           everything opaque. A baked image with a background in it.
 */
async function profileImage(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return { url: pathOf(url), error: `HTTP ${res.status}` };

  const buf = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(buf).metadata();
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  const px = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return { rgb: [data[i], data[i + 1], data[i + 2]], a: data[i + 3] };
  };

  let opaque = 0;
  let clear = 0;
  let partial = 0;
  let partialGreySum = 0;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a >= 250) opaque++;
    else if (a <= 5) clear++;
    else {
      partial++;
      partialGreySum += data[i - 3];
    }
  }
  const total = opaque + clear + partial;

  const corner = px(2, 2);
  const centre = px(width >> 1, height >> 1);

  const kind =
    corner.a >= 250 && centre.a <= 60
      ? "shading-layer"
      : corner.a <= 5 && centre.a >= 250
        ? "cutout"
        : corner.a >= 250 && centre.a >= 250
          ? "flat"
          : "mixed";

  return {
    url: pathOf(url),
    format: meta.format,
    size: `${width}x${height}`,
    hasAlpha: meta.hasAlpha,
    corner,
    centre,
    pct: {
      opaque: +((opaque / total) * 100).toFixed(1),
      transparent: +((clear / total) * 100).toFixed(1),
      partial: +((partial / total) * 100).toFixed(1),
    },
    meanGreyWherePartial: partial ? Math.round(partialGreySum / partial) : null,
    kind,
    // THE ONE LINE THAT DECIDES WHETHER ANY OF THE HOODIE WORK TRANSFERS.
    hoodieRecipeApplies: kind === "shading-layer",
  };
}

export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("business") ?? undefined;
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);

  const row = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId, provider: "PRINTFUL" } },
  });
  if (!row?.credentials) {
    return NextResponse.json({ error: "Printful is not connected for this business." }, { status: 400 });
  }
  const credentials = await refreshPrintfulToken(
    decryptCredentials<PrintfulCredentials>(row.credentials),
  );

  const get = async (path: string) => {
    const res = await fetch(printfulUrl(path), {
      headers: printfulHeaders(credentials.accessToken, credentials.printfulStoreId, isStoreScoped(path)),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
  };

  // A KIND, NOT A CATALOGUE NUMBER. Passing "mug" keeps this usable without
  // knowing Printful's ids, and uses the same matcher the shelf does.
  const explicit = request.nextUrl.searchParams.get("product");
  const kinds = (request.nextUrl.searchParams.get("kinds") ?? "t-shirt,mug,bag,hat")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  let targets: { kind: string; id: string; name: string }[] = [];
  if (explicit && /^\d+$/.test(explicit)) {
    targets = [{ kind: "explicit", id: explicit, name: "" }];
  } else {
    const index = await get(withSellingRegion(`/catalog-products?limit=${PRINTFUL_MAX_LIMIT}`));
    const products = ((index.body as { data?: unknown[] } | null)?.data ?? []) as Record<string, unknown>[];
    for (const kind of kinds) {
      const creatable = creatableById(kind) ?? CREATABLES.find((c) => c.id === kind);
      if (!creatable) continue;
      const hit = products.find((p) =>
        garmentMatches({ name: String(p.name ?? ""), type: (p.type as string) ?? null }, creatable),
      );
      targets.push(
        hit
          ? { kind, id: String(hit.id), name: String(hit.name ?? "") }
          : { kind, id: "", name: "(no product of this kind in the first page of the catalogue)" },
      );
    }
  }

  const findings = [];
  for (const target of targets) {
    if (!target.id) {
      findings.push({ kind: target.kind, product: target, notFound: true });
      continue;
    }

    // Q1/Q2: what the supplier declares as printable, and how.
    const product = await get(withSellingRegion(`/catalog-products/${target.id}`));
    const productData = ((product.body as { data?: unknown } | null)?.data ?? {}) as Record<string, unknown>;
    const variants = await get(
      withSellingRegion(`/catalog-products/${target.id}/catalog-variants?limit=2`),
    );
    const variantData = ((variants.body as { data?: unknown[] } | null)?.data ?? []) as Record<string, unknown>[];

    // Q3/Q4/Q5: the images, and what the pixels actually are.
    const images = await get(withSellingRegion(`/catalog-products/${target.id}/images?limit=2&offset=0`));
    const imageVariants = ((images.body as { data?: unknown[] } | null)?.data ?? []) as Record<string, unknown>[];
    const first = imageVariants[0];
    const imageList = (Array.isArray(first?.images) ? first.images : []) as Record<string, unknown>[];
    const front = imageList.find((im) => im.placement === "front") ?? imageList[0];

    const filesOf = (v: Record<string, unknown> | undefined) =>
      new Set(
        ((Array.isArray(v?.images) ? v!.images : []) as Record<string, unknown>[])
          .map((im) => String(im.image_url ?? "")),
      );
    const a = filesOf(imageVariants[0]);
    const b = filesOf(imageVariants[1]);

    findings.push({
      kind: target.kind,
      product: { id: target.id, name: target.name },

      // Q1 + Q2 — declared placements, and their representation.
      declaredPlacements: {
        onProduct: Array.isArray(productData.placements)
          ? (productData.placements as Record<string, unknown>[]).map((pl) => ({
              placement: pl.placement,
              technique: pl.technique,
            }))
          : null,
        // The dimensions live on the VARIANT, which is what printAreas reads.
        onVariant: Array.isArray(variantData[0]?.placement_dimensions)
          ? (variantData[0].placement_dimensions as Record<string, unknown>[]).map((d) => ({
              placement: d.placement,
              width: d.width,
              height: d.height,
            }))
          : null,
        // What the images endpoint says exists, which may differ from both.
        onImages: [...new Set(imageList.map((im) => im.placement))].slice(0, 15),
      },

      // Q4 — where the colour comes from.
      colourSources: {
        variantRecord: {
          color: variantData[0]?.color ?? null,
          color_code: hexOrNull(variantData[0]?.color_code),
        },
        imageVariantRecord: {
          color: first?.color ?? null,
          primary_hex_color: hexOrNull(first?.primary_hex_color),
          secondary_hex_color: hexOrNull(first?.secondary_hex_color),
        },
        imageRecord: {
          background_color: hexOrNull(front?.background_color),
          hasBackgroundImage: Boolean(front?.background_image),
        },
        imageRecordFields: front ? Object.keys(front) : [],
      },

      // Q5 — one base asset shared, or one per colour?
      baseAssetSharing:
        imageVariants.length >= 2
          ? {
              comparing: [imageVariants[0]?.color, imageVariants[1]?.color],
              sharedFiles: [...a].filter((u) => b.has(u)).length,
              filesOnlyInSecond: [...b].filter((u) => !a.has(u)).length,
              verdict:
                [...b].filter((u) => !a.has(u)).length === 0
                  ? "same base asset, colour carried as data"
                  : "different assets per colour",
            }
          : null,

      imageCount: imageList.length,
      distinctFiles: new Set(imageList.map((im) => String(im.image_url ?? ""))).size,

      // Q3 — the composition model, from the pixels.
      imageProfile:
        typeof front?.image_url === "string"
          ? await profileImage(front.image_url as string)
          : { error: "no front image_url" },
    });
  }

  return NextResponse.json(
    {
      askedFor: explicit ? [explicit] : kinds,
      legend: {
        "imageProfile.kind": {
          "shading-layer":
            "background opaque, product nearly transparent. The hoodie model: colour under the shading, alpha inverted.",
          cutout:
            "background transparent, product opaque. Already a finished picture — it cannot be recoloured.",
          flat: "everything opaque. A baked image with its background in it. Needs its own decision.",
          mixed: "neither — look at corner/centre and the percentages.",
        },
        hoodieRecipeApplies: "true means /api/creation/blank composes this product correctly as-is.",
      },
      findings,
    },
    { status: 200 },
  );
}
