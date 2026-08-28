import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";

// THE SUPPLIER'S BLANK, SERVED FROM OUR OWN ORIGIN.
//
// ============ WHY THIS EXISTS (2026-08-27) ============================
//
// Sean: "when I select a different garment color, the background changes color
// while the hoodie itself stays black."
//
// The colour layer is shaped by a CSS mask whose image is the blank itself, so
// the fill lands on the garment and nowhere else. A mask-image from another
// origin is subject to CORS, and Printful's CDN does not serve the headers
// that would allow it — so the mask silently did nothing, the fill kept its
// rectangle, and what changed colour was the room.
//
// Silently is the important word. A failed mask does not error; it just stops
// masking. The only fix that is not a guess is to remove the cross-origin
// problem, which is what this route does.
//
// ============ WHAT IT WILL AND WILL NOT FETCH =========================
//
// An open image proxy is a way to make a server fetch arbitrary URLs on
// somebody else's behalf — internal addresses included. So the host is checked
// against Printful's own CDNs and nothing else is fetched, ever. A URL that
// does not match is refused rather than followed.

const ALLOWED_HOSTS = new Set([
  "files.cdn.printful.com",
  "cdn.printful.com",
  "printful-upload.s3-accelerate.amazonaws.com",
]);

/**
 * A six-digit hex, or null — the only colour input this route accepts.
 *
 * Narrow on purpose: everything else about this request is a URL on an
 * allow-list, and a colour that is not six hex digits is not a colour.
 */
export function normaliseHex(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(v)) return v.split("").map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/.test(v) ? v : null;
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("url");
  if (!raw) return new NextResponse("Missing url", { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new NextResponse("Not a URL", { status: 400 });
  }

  // HTTPS AND A KNOWN HOST, both required. Either alone is not enough: http
  // would allow a downgrade, and any host would make this a general-purpose
  // fetcher pointed at whatever a caller supplies.
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
    return new NextResponse("Not a Printful image", { status: 403 });
  }

  const upstream = await fetch(target.toString(), {
    headers: { accept: "image/*" },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  if (!upstream || !upstream.ok) {
    return new NextResponse("Upstream image unavailable", { status: 502 });
  }

  const type = upstream.headers.get("content-type") ?? "";
  // Only images come back through here. Without this the route would happily
  // relay whatever that host served, which is not what it is for.
  if (!type.startsWith("image/")) {
    return new NextResponse("Not an image", { status: 502 });
  }

  const CACHE = "public, max-age=86400, s-maxage=604800, immutable";

  // No colour asked for: relay it untouched.
  const colour = normaliseHex(request.nextUrl.searchParams.get("color"));
  if (!colour) {
    return new NextResponse(upstream.body, {
      headers: { "content-type": type, "cache-control": CACHE },
    });
  }

  // ============ THE GARMENT, IN THE COLOUR (2026-08-27) ===============
  //
  // Printful's blank is NOT a photograph of a hoodie. Read off the actual
  // file — 05_gildan18500_flat_front_base_whitebg.png, 1000x1000 RGBA:
  //
  //   the background is OPAQUE WHITE     (alpha 255)
  //   the garment is a SHADING LAYER     (alpha ~26, grey ~158)
  //
  // So it is a layer of folds and shadows meant to sit OVER a colour, and
  // alpha is what separates garment from background. That single fact
  // explains every failed attempt: masking by alpha selected the background
  // rather than the garment, and multiply over a 10%-opaque layer could only
  // ever tint the few bright pixels — the drawstrings.
  //
  // The composition, per pixel:
  //
  //   colour  = chosen colour, darkened by the shading that lies over it
  //   opacity = INVERTED, because the opaque part is the part to throw away
  //
  // What comes out is the real Gildan blank, whole, in a colour Printful
  // actually manufactures, isolated on transparency. No rectangle behind it —
  // the white background is what becomes transparent.
  try {
    const source = Buffer.from(await upstream.arrayBuffer());
    const { data, info } = await sharp(source)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const r = parseInt(colour.slice(0, 2), 16);
    const g = parseInt(colour.slice(2, 4), 16);
    const b = parseInt(colour.slice(4, 6), 16);

    const out = Buffer.allocUnsafe(data.length);
    for (let i = 0; i < data.length; i += 4) {
      const shade = data[i + 3] / 255;
      const grey = data[i];
      out[i] = Math.round(r * (1 - shade) + grey * shade);
      out[i + 1] = Math.round(g * (1 - shade) + grey * shade);
      out[i + 2] = Math.round(b * (1 - shade) + grey * shade);
      out[i + 3] = 255 - data[i + 3];
    }

    const png = await sharp(out, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png()
      .toBuffer();

    return new NextResponse(new Uint8Array(png), {
      headers: { "content-type": "image/png", "cache-control": CACHE },
    });
  } catch {
    // A blank we could not compose is not a blank we should invent. The caller
    // treats a failure as "this colour cannot be shown", which removes it from
    // the row rather than putting a wrong garment on screen.
    return new NextResponse("Could not render that colour", { status: 502 });
  }
}
