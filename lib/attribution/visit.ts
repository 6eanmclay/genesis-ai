import "server-only";
import { cookies, headers } from "next/headers";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { classifyArrival } from "./classify";

// RECORDING ONE VISIT, ONCE.
//
// ============ WHY THE WRITE IS NOT IN proxy.ts (2026-09-01) ============
//
// The file convention in this Next version is `proxy.ts`, not `middleware.ts` —
// and its own documentation rules out doing this there:
//
//   "Proxy is meant to be invoked separately of your render code and in
//    optimized cases deployed to your CDN for fast redirect/rewrite handling,
//    you should not attempt relying on shared modules or globals."
//
// So the proxy does the one thing only it can: mint the cookie before the page
// renders, because a Server Component cannot set one. Everything with a
// database in it happens here, called from the storefront route.
//
// ============ THE COOKIE IS THE BAG COOKIE'S SIBLING ==================
//
// Same shape, deliberately, including the one property that looks like a
// mistake and is not. bagStore.ts:
//
//   "LAX, NOT STRICT, and this matters: a customer returning from Stripe or
//    PayPal arrives via a cross-site redirect. Under `strict` the cookie would
//    not be sent, and their bag would appear to have emptied itself at the
//    worst possible moment."
//
// The same is true of attribution, and worse: a strict cookie would lose the
// source at the exact moment the sale completes, so every paid order would look
// direct and the whole subsystem would quietly report nothing.
//
// ============ AND IT IS NOT A PERSON ==================================
//
// An opaque random token, per store, httpOnly. No IP address, no user agent, no
// fingerprint, nothing shared between stores. It exists to join a purchase to
// the visit that produced it and it can answer no other question.

/** Twelve months, matching the raw-visit retention period. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** The header the proxy uses to hand a freshly minted token to the route. */
export const MINTED_TOKEN_HEADER = "x-genesis-visit";

/** The landing URL's query string, forwarded by the proxy. See proxy.ts. */
export const SEARCH_HEADER = "x-genesis-search";

/** Per store, like the bag cookie beside it. */
export function visitCookieName(storeSlug: string): string {
  return `genesis_visit_${storeSlug.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

export function newVisitToken(): string {
  return randomUUID();
}

/** How many products one visit will remember looking at. */
const VIEWED_CAP = 50;

/**
 * JUST THE ID.
 *
 * It carried the attribution and a `created` flag until a sabotage run found
 * that nothing anywhere read either one — so breaking them broke no test,
 * because there was nothing to break. Untested surface that cannot be tested
 * is worse than absent surface: it looks like a guarantee.
 *
 * Callers that need the attribution read it from the database through
 * attributionForCheckout, which is the path a real checkout actually takes.
 */
export interface RecordedVisit {
  id: string;
}

/**
 * Record this arrival, or join the visit already in progress.
 *
 * IDEMPOTENT ON THE TOKEN, through a unique constraint rather than a
 * check-then-act read. `recordDelivery` in lib/webhooks/delivery.ts learned
 * this the expensive way: eight concurrent callers, seven of them handed null,
 * because two requests can both find nothing and both insert. A customer
 * refreshing a slow page is exactly that shape.
 *
 * THE FIRST ARRIVAL'S ATTRIBUTION WINS AND IS NEVER OVERWRITTEN. Somebody who
 * arrives from Instagram and then navigates around the shop came from
 * Instagram; letting a later page view restate the source would turn every
 * visit into whatever its last click happened to look like.
 */
export async function recordVisit(params: {
  storeId: string;
  storeSlug: string;
  landingPath: string;
}): Promise<RecordedVisit | null> {
  const { storeId, storeSlug, landingPath } = params;
  try {
    const [jar, head] = await Promise.all([cookies(), headers()]);

    // The proxy minted one for a first-time visitor; a returning one has it in
    // the jar. Reading both means the very first page view is recorded rather
    // than waiting for the cookie to come back on the second request.
    const token =
      jar.get(visitCookieName(storeSlug))?.value ?? head.get(MINTED_TOKEN_HEADER) ?? null;
    if (!token) return null;

    // THE REAL QUERY STRING, from the proxy. Classifying against a path this
    // function had constructed itself meant `?via=instagram` was never seen,
    // and every explicit tracking link was recorded as direct traffic.
    const search = head.get(SEARCH_HEADER) ?? "";
    const attribution = classifyArrival({
      referer: head.get("referer"),
      params: new URLSearchParams(search),
      selfHost: head.get("host"),
    });

    const existing = await prisma.storeVisit.findUnique({
      where: { storeId_visitToken: { storeId, visitToken: token } },
      select: { id: true },
    });
    if (existing) {
      // STORE-SCOPED, because tenantIsolation guards every update on this
      // model and an unscoped one is refused outright. The first version used
      // `where: { id }` and was silently swallowed by this function's own
      // catch — the guard was right and the code was wrong.
      await prisma.storeVisit.updateMany({
        where: { id: existing.id, storeId },
        data: { lastSeenAt: new Date() },
      });
      // THE STORED ROW IS NOT TOUCHED. A returning request usually carries no
      // referrer at all, and re-classifying here would overwrite an Instagram
      // referral with "direct" the moment the visitor loaded a second page.
      return { id: existing.id };
    }

    try {
      const row = await prisma.storeVisit.create({
        data: {
          storeId,
          visitToken: token,
          attributionKind: attribution.kind,
          source: attribution.source,
          campaign: attribution.campaign,
          evidence: attribution.evidence,
          landingPath,
        },
        select: { id: true },
      });
      return { id: row.id };
    } catch (error) {
      // The other half of the race. The unique index kept one row; this caller
      // lost, and the winner's row is the answer.
      if (isUniqueViolation(error)) {
        const winner = await prisma.storeVisit.findUnique({
          where: { storeId_visitToken: { storeId, visitToken: token } },
      select: { id: true },
        });
        if (winner) return { id: winner.id };
      }
      throw error;
    }
  } catch {
    // A STOREFRONT MUST NEVER FAIL TO SELL BECAUSE ANALYTICS FAILED.
    // Same trade telemetry makes and for a stronger reason: a missing visit row
    // costs a line in a report, and a thrown error costs the sale.
    return null;
  }
}

/** Note that this visit looked at a product. Best effort, capped, never throws. */
export async function recordProductView(params: {
  visitId: string;
  storeId: string;
  productId: string;
}): Promise<void> {
  const { visitId, storeId, productId } = params;
  try {
    // The store is a PARAMETER rather than looked up from the visit, because
    // every write below has to be scoped by it and deriving the scope from the
    // row being scoped would not be a check at all.
    const visit = await prisma.storeVisit.findFirst({
      where: { id: visitId, storeId },
      select: { viewedProductIds: true },
    });
    if (!visit) return;
    if (visit.viewedProductIds.includes(productId)) return;
    if (visit.viewedProductIds.length >= VIEWED_CAP) return;
    await prisma.storeVisit.updateMany({
      where: { id: visitId, storeId },
      data: { viewedProductIds: { push: productId }, lastSeenAt: new Date() },
    });
  } catch {
    // See above.
  }
}

/**
 * The attribution to freeze onto a checkout, for the visit in progress.
 *
 * Returns null when there is no visit — which is a real answer and must stay
 * one. An order with no attribution is honest; an order attributed to a guess
 * is the thing this subsystem exists not to do.
 */
export async function attributionForCheckout(params: {
  storeId: string;
  storeSlug: string;
}): Promise<{
  attributionKind: string;
  attributionSource: string | null;
  attributionCampaign: string | null;
  attributionEvidence: string;
  attributionVisitId: string;
} | null> {
  try {
    const jar = await cookies();
    const token = jar.get(visitCookieName(params.storeSlug))?.value;
    if (!token) return null;

    // STORE-SCOPED, because the token arrives from a cookie the visitor holds.
    // Looking it up without the store would let a token minted on one shop
    // attribute a purchase on another.
    const visit = await prisma.storeVisit.findUnique({
      where: { storeId_visitToken: { storeId: params.storeId, visitToken: token } },
      select: { id: true, attributionKind: true, source: true, campaign: true, evidence: true },
    });
    if (!visit) return null;

    return {
      attributionKind: visit.attributionKind,
      attributionSource: visit.source,
      attributionCampaign: visit.campaign,
      attributionEvidence: visit.evidence,
      attributionVisitId: visit.id,
    };
  } catch {
    return null;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
