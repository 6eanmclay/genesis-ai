import { NextRequest, NextResponse } from "next/server";
import { requireBusinessOrActive, PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/integrations/credentials";
import { PRINTFUL_API_BASE, refreshPrintfulToken, type PrintfulCredentials } from "@/lib/integrations/printful";

// WHAT PRINTFUL ACTUALLY REQUIRES TO CREATE A PRODUCT — measured, not assumed.
//
// ============ WHY THIS EXISTS (2026-08-28) ==============================
//
// Sean: "keep tracing and validating the real supplier contracts rather than
// making assumptions from documentation or building around unknown responses...
// If something depends on a real supplier response you haven't actually seen,
// trace it rather than guessing."
//
// Creation Station saves a complete two-sided design and does NOT create it
// with the supplier, and that gap is deliberate: lib/fulfillment/printful.ts's
// createProduct posts
//
//     sync_variants: [{ variant_id, retail_price, files: [{ url }] }]
//
// — one file, with nothing saying WHERE it prints. Sending a two-sided design
// through it would put the front artwork somewhere Printful chose and silently
// drop the back. That much is known from the code that already takes money.
//
// What is NOT known, and what this traces:
//
//   1. How a file names its placement. `files[].type` is the field I believe
//      carries it, and believing is exactly what cost four rounds on the
//      hoodie blank. A product that already has a back print answers it
//      definitively.
//   2. WHICH placement identifiers a given blank accepts, and whether they are
//      the same strings v2's catalog uses. Creation Station reads placements
//      from v2 (`front`, `back`); creation happens on v1. Two APIs agreeing on
//      identifiers is an assumption until it is read.
//   3. What else a placement needs. Printful's printfile endpoint states a DPI
//      and pixel size per placement — if artwork has to be positioned or sized
//      to a printfile rather than sent as a bare URL, the design already holds
//      the numbers and the mapping has to be written against real ones.
//
// ============ IT CREATES NOTHING =======================================
//
// Every request below is a GET. No product is created, no order is placed, and
// nothing is written to Printful or to Genesis. The one thing that would prove
// the contract fastest — POST a payload and read the validation error — is
// deliberately not here: a POST that is wrong in an unexpected way is a POST
// that might succeed, and a real product appearing in the owner's Printful
// store is not something a trace gets to do.
//
// ============ WHAT IT DISCLOSES ========================================
//
// Structure, identifiers and counts. Artwork URLs come back as host and path
// only — a signed CDN URL is a credential of a sort. Read by, and returned to,
// the owner who asked.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pathOf(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "<unparseable>";
  }
}

/** Field names present on an object, so a shape can be read without its data. */
function keysOf(value: unknown): string[] {
  return value && typeof value === "object" ? Object.keys(value as Record<string, unknown>) : [];
}

export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("slug");
  if (!slug) {
    return NextResponse.json({ error: "Pass ?slug=<your-business-slug>." }, { status: 400 });
  }

  const { store } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);

  const integration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId: store.id, provider: "PRINTFUL" } },
  });
  if (!integration?.credentials) {
    return NextResponse.json({ error: "Printful is not connected for this business." }, { status: 400 });
  }
  const credentials = await refreshPrintfulToken(decryptCredentials<PrintfulCredentials>(integration.credentials));

  const headers = {
    Authorization: `Bearer ${credentials.accessToken}`,
    "X-PF-Store-Id": String(credentials.printfulStoreId),
  };

  const notes: string[] = [];
  async function get(path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
    const res = await fetch(`${PRINTFUL_API_BASE}${path}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text().catch(() => "");
    let body: unknown = text.slice(0, 2000);
    try {
      body = JSON.parse(text);
    } catch {
      // Left as truncated text — an unparseable body IS the finding.
    }
    if (!res.ok) notes.push(`${path} -> ${res.status}`);
    return { ok: res.ok, status: res.status, body };
  }

  // ---- 1. What this store already has ---------------------------------
  //
  // An existing product created through Printful's own dashboard is the best
  // possible evidence: it is a real, valid, accepted product, and its shape is
  // the shape a created one has to end up in.
  const listed = await get("/store/products?limit=20");
  const items = ((listed.body as { result?: unknown[] })?.result ?? []) as Record<string, unknown>[];

  const products = items.slice(0, 20).map((p) => ({
    id: p.id,
    name: p.name,
    variantCount: p.variants,
    synced: p.synced,
  }));

  // ---- 2. One of them in full, which is where files[] lives -----------
  const detailId = request.nextUrl.searchParams.get("product") ?? (items[0]?.id as number | undefined);
  let detail: unknown = null;
  if (detailId !== undefined) {
    const full = await get(`/store/products/${detailId}`);
    const result = (full.body as { result?: { sync_product?: unknown; sync_variants?: unknown[] } })?.result;
    const variants = (result?.sync_variants ?? []) as Record<string, unknown>[];

    detail = {
      syncProductKeys: keysOf(result?.sync_product),
      variantCount: variants.length,
      variantKeys: keysOf(variants[0]),
      // THE ANSWER TO QUESTION 1. Every file on every variant, with the field
      // that names its placement shown as whatever it actually is.
      files: variants.slice(0, 4).map((v) => ({
        variantId: v.variant_id,
        catalogVariantId: v.product && typeof v.product === "object"
          ? (v.product as Record<string, unknown>).variant_id
          : undefined,
        files: ((v.files ?? []) as Record<string, unknown>[]).map((f) => ({
          // `type` is the field I believe names the placement. Printed beside
          // the whole key list so the belief is checkable rather than assumed.
          type: f.type,
          allKeys: keysOf(f),
          url: pathOf(f.url),
          preview: pathOf(f.preview_url),
          status: f.status,
          visible: f.visible,
          position: f.position,
        })),
        optionKeys: keysOf((v.options as unknown[])?.[0]),
      })),
    };
  }

  // ---- 3. Which placements a blank accepts, from the printfile endpoint --
  //
  // QUESTION 2 AND 3. This is the authoritative per-product answer, and it is
  // the one thing that says whether v1's placement identifiers are the same
  // strings v2's catalog gives Creation Station.
  const catalogProductId = request.nextUrl.searchParams.get("catalogProduct") ?? "146";
  const printfiles = await get(`/mockup-generator/printfiles/${catalogProductId}`);
  const pf = (printfiles.body as {
    result?: {
      product_id?: number;
      available_placements?: Record<string, string>;
      printfiles?: Record<string, unknown>[];
      variant_printfiles?: Record<string, unknown>[];
      option_groups?: unknown;
    };
  })?.result;

  const placementTrace = {
    productId: pf?.product_id,
    // The identifiers themselves, which is the whole point.
    availablePlacements: pf?.available_placements ?? null,
    printfileSpecs: (pf?.printfiles ?? []).slice(0, 8).map((f) => ({
      printfileId: f.printfile_id,
      width: f.width,
      height: f.height,
      dpi: f.dpi,
      fillMode: f.fill_mode,
      canRotate: f.can_rotate,
    })),
    // Which placement maps to which printfile, for the first variant.
    variantPrintfileKeys: keysOf((pf?.variant_printfiles ?? [])[0]),
    firstVariantPrintfiles: (pf?.variant_printfiles ?? [])[0] ?? null,
  };

  return NextResponse.json(
    {
      traced: new Date().toISOString(),
      business: slug,
      whatThisAnswers: {
        "1_placementField": "detail.files[].files[].type + allKeys — how a file says where it prints",
        "2_identifiers": "placements.availablePlacements — compare these strings to v2's front/back",
        "3_printfileRequirements": "placements.printfileSpecs — dpi, pixel size, fill mode, rotation",
      },
      storeProducts: { count: items.length, listStatus: listed.status, products },
      detail,
      placements: { status: printfiles.status, catalogProductId, ...placementTrace },
      notes: notes.length ? notes : ["every request returned 200"],
      readMeFirst:
        "Nothing was created. If storeProducts.count is 0 there is no existing product to read " +
        "files[] from, and question 1 stays open — creating one two-sided product by hand in " +
        "Printful's own dashboard and re-running this answers it definitively.",
    },
    { status: 200 },
  );
}
