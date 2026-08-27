import { NextRequest, NextResponse } from "next/server";

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

  return new NextResponse(upstream.body, {
    headers: {
      "content-type": type,
      // Blanks do not change. A long cache keeps this off Printful's rate
      // limit, which the catalogue has already hit once today.
      "cache-control": "public, max-age=86400, s-maxage=604800, immutable",
    },
  });
}
