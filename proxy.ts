import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// THE ONLY PLACE A COOKIE CAN BE SET BEFORE THE STOREFRONT RENDERS.
//
// ============ proxy.ts, NOT middleware.ts (2026-09-01) =================
//
// This project had no such file, and the name is the first thing to get right.
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md:
//
//   "The `middleware` file convention is deprecated and has been renamed to
//    `proxy`."
//
// ============ AND IT DOES AS LITTLE AS POSSIBLE =======================
//
// The same document is explicit about what this file may rely on:
//
//   "Proxy is meant to be invoked separately of your render code and in
//    optimized cases deployed to your CDN for fast redirect/rewrite handling,
//    you should not attempt relying on shared modules or globals."
//
// So there is no Prisma here, no store lookup, and no classification. It mints
// an opaque token for a visitor who has none and hands it to the route, which
// does the work with a database in front of it. Everything this file knows is
// on the request in front of it.
//
// ============ THE NAKED URL IS UNTOUCHED ==============================
//
// Sean: "The merchant's normal storefront URL must continue to work exactly as
// it does now." Nothing here redirects, rewrites, or requires a parameter. A
// request that arrives with no cookie and no tracking is served exactly as
// before and simply gains a token on the way past.

/** Twelve months, matching the raw-visit retention period. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Handed to the route so the FIRST page view is recorded, not the second. */
const MINTED_TOKEN_HEADER = "x-genesis-visit";

/**
 * The landing URL's query string, forwarded to the route.
 *
 * FOUND BY THE HTTP SUITE (2026-09-01). The recorder was classifying against a
 * path it constructed itself — `/store/<slug>` — so `?via=instagram` was never
 * in the parameters it read, and every explicit tracking link was recorded as
 * direct traffic. The one feature a merchant would deliberately go out of their
 * way to use was the one that silently did nothing.
 *
 * A Server Component cannot read the request URL, and threading searchParams
 * through every storefront route would be a per-route decision to get wrong
 * again. This is one header, set on every matched request.
 */
const SEARCH_HEADER = "x-genesis-search";

/** Per store, like the bag cookie it sits beside. */
function visitCookieName(storeSlug: string): string {
  return `genesis_visit_${storeSlug.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

export function proxy(request: NextRequest): NextResponse {
  const slug = request.nextUrl.pathname.split("/")[2];
  if (!slug) return NextResponse.next();

  // FORWARDED ON EVERY REQUEST, whether or not a cookie is minted. The route
  // needs the query string to classify an arrival, and a returning visitor
  // following a tracked link is still an arrival worth reading correctly.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(SEARCH_HEADER, request.nextUrl.search);

  const name = visitCookieName(slug);
  const existing = request.cookies.get(name)?.value;
  if (existing) return NextResponse.next({ request: { headers: requestHeaders } });

  // crypto.randomUUID is available in this runtime; `crypto` from node is not,
  // which is part of what "do not rely on shared modules" means here.
  const token = crypto.randomUUID();

  // PASSED FORWARD ON THE REQUEST, so the storefront can record this very
  // arrival. Without it the first page view — the one carrying the referrer
  // that matters — would be lost, and attribution would only ever start on a
  // visitor's second page.
  requestHeaders.set(MINTED_TOKEN_HEADER, token);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.cookies.set(name, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // LAX, NOT STRICT, and this is load-bearing rather than lazy. bagStore.ts
    // says why for the bag: "a customer returning from Stripe or PayPal arrives
    // via a cross-site redirect. Under `strict` the cookie would not be sent."
    // Here it would be worse than an emptied bag — every paid order would look
    // like direct traffic, and the subsystem would report nothing while
    // appearing to work.
    sameSite: "lax",
    maxAge: MAX_AGE_SECONDS,
    path: "/",
  });
  return response;
}

// STOREFRONT ONLY. The dashboard, the API routes and the onboarding flow are
// not places a customer arrives from somewhere, and giving them a cookie would
// be collecting something with no question behind it.
export const config = {
  matcher: "/store/:slug*",
};
