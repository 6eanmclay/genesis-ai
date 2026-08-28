import { NextRequest, NextResponse } from "next/server";
import { requireBusinessOrActive, PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/integrations/credentials";
import { refreshPrintfulToken, type PrintfulCredentials } from "@/lib/integrations/printful";
import { printfulUrl, printfulHeaders, isStoreScoped, withSellingRegion, PRINTFUL_MAX_IMAGE_LIMIT } from "@/lib/creation/printfulRequest";

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

  // The first two pages only. This is a look at the SHAPE, and two pages is
  // enough to show both the record layout and whether paging behaves.
  const pages: unknown[] = [];
  for (let page = 0; page < 2; page++) {
    const path = withSellingRegion(
      `/catalog-products/${productId}/images?limit=${PRINTFUL_MAX_IMAGE_LIMIT}&offset=${page * PRINTFUL_MAX_IMAGE_LIMIT}`,
    );
    const res = await fetch(printfulUrl(path), {
      headers: printfulHeaders(credentials.accessToken, credentials.printfulStoreId, isStoreScoped(path)),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => null);
    pages.push({
      asked: path,
      status: res.status,
      shape: shapeOf(body),
    });
    if (!res.ok) break;
  }

  return NextResponse.json({ product: productId, pages }, { status: 200 });
}
