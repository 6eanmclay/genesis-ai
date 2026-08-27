import "server-only";
import { cookies } from "next/headers";
import { bagCookieName, decodeBag, encodeBag, EMPTY_BAG, type BagContents } from "./bagCookie";

// THE COOKIE JAR, AND NOTHING ELSE.
//
// Every decision about what a bag contains lives in bagCookie.ts, which is
// pure. This is the plumbing that reads and writes it — kept separate for the
// same reason verifyAddress.ts is separate from addressVerification.ts: the
// part with real semantics should be provable on its own, and `next/headers`
// cannot be imported into anything a test wants to call directly.
//
// NO DATABASE ROW IS WRITTEN BY ANY OF THIS. Browsing, adding, removing and
// changing quantities are a cookie and nothing more, for signed-in visitors
// and anonymous ones alike. A row appears only when somebody actually
// continues to payment — see lib/bag/checkoutDraft.ts.

/** 30 days, matching the anonymous-session cookie this sits beside. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export async function readBag(storeSlug: string): Promise<BagContents> {
  const jar = await cookies();
  return decodeBag(jar.get(bagCookieName(storeSlug))?.value);
}

export async function writeBag(storeSlug: string, bag: BagContents): Promise<void> {
  const jar = await cookies();
  jar.set(bagCookieName(storeSlug), encodeBag(bag), {
    // The customer never reads this from JavaScript — every edit goes through a
    // server action and the header count is server-rendered — so there is no
    // reason to expose it to scripts on the page.
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // LAX, NOT STRICT, and this matters: a customer returning from Stripe or
    // PayPal arrives via a cross-site redirect. Under `strict` the cookie would
    // not be sent, and their bag would appear to have emptied itself at the
    // worst possible moment.
    sameSite: "lax",
    maxAge: MAX_AGE_SECONDS,
    // Scoped to the whole site rather than to /store/[slug], so the bag
    // survives a customer wandering onto a product page and back.
    path: "/",
  });
}

export async function clearBagCookie(storeSlug: string): Promise<void> {
  await writeBag(storeSlug, EMPTY_BAG);
}
