import { NextRequest, NextResponse } from "next/server";
import { requireBusinessOrActive, PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/integrations/credentials";
import { refreshPrintfulToken, type PrintfulCredentials } from "@/lib/integrations/printful";
import { printfulUrl, printfulHeaders, isStoreScoped, withSellingRegion } from "@/lib/creation/printfulRequest";

// WHAT PRINTFUL ACTUALLY SENDS BACK — the shape, never the pictures.
//
// ============ WHY THIS EXISTS (2026-08-27) ==============================
//
// I have now guessed at this endpoint's response shape three times. Each guess
// was reasonable, each was wrong in a different way, and each cost a round trip
// through a deploy and a live test:
//
//   - the URLs were under key names I had picked;
//   - the empty check only fired for a non-`data` envelope;
//   - the colour arrived as a NAME, and the parser only accepted a hex.
//
// The fourth guess is not worth making. Sean asked for exactly this two
// messages ago — "inspect the actual Printful response and tell me exactly
// which blank/image record Genesis selects for each one" — and I deferred it
// twice in favour of another inference. This answers it with the response
// itself.
//
// ============ WHAT IT DISCLOSES ========================================
//
// STRUCTURE, NOT CONTENT. Key names, how deep they nest, which colour fields
// are present, how many records and how many images — and image URLs only as
// their path, because a signed CDN URL is a credential of a sort and this is a
// diagnostic, not an export. Nothing here is written anywhere; it is read and
// returned to the owner who asked.
//
// Owner-authenticated and scoped to their own connected supplier, like every
// other read of these credentials.

/** Key names and nesting, with values replaced by their shape. */
function shapeOf(node: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(node)) {
    return node.length === 0 ? [] : [`array of ${node.length}`, shapeOf(node[0], depth + 1)];
  }
  if (node === null || typeof node !== "object") {
    if (typeof node === "string") {
      // A URL's PATH is what identifies the asset; the query can carry a
      // signature, so it does not come back.
      if (/^https?:\/\//.test(node)) {
        try {
          const u = new URL(node);
          return `<url ${u.hostname}${u.pathname}>`;
        } catch {
          return "<url>";
        }
      }
      return node.length > 40 ? `<string ${node.length}>` : node;
    }
    return typeof node;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out[k] = shapeOf(v, depth + 1);
  }
  return out;
}

export async function GET(request: NextRequest) {
  const productId = request.nextUrl.searchParams.get("product");
  if (!productId || !/^\d+$/.test(productId)) {
    return NextResponse.json({ error: "Pass ?product=<printful catalog product id>" }, { status: 400 });
  }
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

  // ============ WHAT THE FIRST TRACE ANSWERED, AND WHAT IT DID NOT =====
  //
  // It showed the record shape, and three things fell out of it: the hex is
  // `primary_hex_color` and not `color_code` (so this code never read one),
  // the garment file is the SAME for Ash and Carolina Blue, and each record
  // carries a per-colour `background_color`.
  //
  // What it could not show is whether a colour-specific render exists ANYWHERE
  // — because `images` is an array of over a thousand per variant, and shapeOf
  // only prints the first. So this pass counts and compares them instead of
  // describing one.
  const out: Record<string, unknown> = { product: productId };

  // ---- 1. THE IMAGE RECORDS, COMPARED ACROSS TWO COLOURS -------------
  const first = await get(
    withSellingRegion(`/catalog-products/${productId}/images?limit=2&offset=0`),
  );
  const variants = ((first.body as { data?: unknown[] } | null)?.data ?? []) as Record<string, unknown>[];

  out.imageRecords = {
    status: first.status,
    // Every field on the variant record, so a field name is never guessed again.
    variantFields: variants[0] ? Object.keys(variants[0]) : [],
    colours: variants.map((v) => {
      const images = (Array.isArray(v.images) ? v.images : []) as Record<string, unknown>[];
      const urls = images
        .map((im) => (typeof im.image_url === "string" ? im.image_url : null))
        .filter((u): u is string => u !== null);
      const distinct = [...new Set(urls)];
      const front = images.filter((im) => im.placement === "front");
      return {
        color: v.color,
        primary_hex_color: v.primary_hex_color,
        imageCount: images.length,
        distinctUrlCount: distinct.length,
        placements: [...new Set(images.map((im) => im.placement))].slice(0, 12),
        // Every field on ONE image record.
        imageFields: images[0] ? Object.keys(images[0]) : [],
        // A handful of distinct front renders, by their filename and style id.
        frontSamples: [
          ...new Map(
            front.map((im) => [
              String(im.image_url),
              {
                file: String(im.image_url ?? "").split("/").slice(-1)[0],
                mockup_style_id: im.mockup_style_id,
                background_color: im.background_color,
                hasBackgroundImage: Boolean(im.background_image),
              },
            ]),
          ).values(),
        ].slice(0, 8),
      };
    }),
  };

  // ---- 2. WHETHER ANY FILENAME DIFFERS BETWEEN TWO COLOURS -----------
  //
  // The direct answer to "can Printful give us a colour-specific image": if
  // two colours share every filename, the answer is no at this endpoint.
  if (variants.length >= 2) {
    const setOf = (v: Record<string, unknown>) =>
      new Set(
        ((Array.isArray(v.images) ? v.images : []) as Record<string, unknown>[])
          .map((im) => String(im.image_url ?? "")),
      );
    const a = setOf(variants[0]);
    const b = setOf(variants[1]);
    const onlyInB = [...b].filter((u) => !a.has(u));
    out.colourSpecificFiles = {
      comparing: [variants[0]?.color, variants[1]?.color],
      sharedCount: [...a].filter((u) => b.has(u)).length,
      differingCount: onlyInB.length,
      examplesOnlyInSecond: onlyInB.slice(0, 5).map((u) => u.split("/").slice(-1)[0]),
    };
  }

  // ---- 3. MOCKUP STYLES ----------------------------------------------
  const styles = await get(withSellingRegion(`/catalog-products/${productId}/mockup-styles`));
  out.mockupStyles = { status: styles.status, shape: shapeOf(styles.body) };

  return NextResponse.json(out, { status: 200 });
}
