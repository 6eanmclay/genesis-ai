import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  classifyArrival, referrerHost, sourceLabel,
  ATTRIBUTION_KINDS, SOURCE_PARAMS, CAMPAIGN_PARAMS,
} from "@/lib/attribution/classify";
import { pruneStoreVisits, rollUpVisits, dayOf, RAW_VISIT_RETENTION_DAYS } from "@/lib/attribution/retention";
import { createCheckoutDraft, loadDraft } from "@/lib/bag/checkoutDraft";
import { priceOrder } from "@/lib/pricing/orderPricing";
import { readFileSync } from "node:fs";

// WHERE THE TRAFFIC CAME FROM, AND WHAT WE REFUSE TO GUESS:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts attribution-db
//
// ============ THE RULE THIS SUITE EXISTS TO HOLD (2026-09-01) ==========
//
// Sean: "Never infer a platform merely because we think the visitor probably
// came from there." Everything else here is plumbing; that sentence is the
// product. A merchant deciding where to spend their time on the strength of a
// guessed source is worse off than one with no data at all, because they do not
// know to doubt it.
//
// So the classifier is pure and is tested exhaustively, and the linktr.ee case
// is asserted directly rather than left to follow from the general rule.
//
// The HTTP lane (scripts/verify-attribution-live.ts) proves the parts this one
// cannot reach: a real request with a real Referer header, the cookie surviving
// a navigation, and a real checkout carrying its source into a real order.

let failures = 0;
let passes = 0;
const failed: string[] = [];
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${name}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const q = (s: string) => new URLSearchParams(s);

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  let seq = 0;

  const makeStore = async () => {
    const n = ++seq;
    const user = await prisma.user.create({ data: { email: `attr-${stamp}-${n}@example.test` } });
    return prisma.store.create({
      data: {
        userId: user.id, name: "Cubit & Coil", slug: `attr-${stamp}-${n}`,
        tagline: "t", description: "d", currency: "USD", published: true,
      },
    });
  };

  // ======================================================================
  console.log("\n=== 1. A referrer is recorded as the host it actually is ===\n");
  // ======================================================================
  {
    const r = classifyArrival({ referer: "https://www.instagram.com/p/abc123/" });
    eq("an Instagram referral is an observed referral", r.kind, "observed_referral");
    eq("recorded as the host", r.source, "instagram.com");
    eq("and says the evidence was the header", r.evidence, "Referer host");
    assert("www is not a different place", referrerHost("https://www.example.com/x") === "example.com");

    // ---- THE PATH AND QUERY ARE NOT KEPT --------------------------------
    const nosy = classifyArrival({
      referer: "https://www.google.com/search?q=how+to+treat+a+rash&session=abc",
    });
    eq("only the host survives", nosy.source, "google.com");
    assert("the search terms are nowhere in the result",
      !JSON.stringify(nosy).includes("rash") && !JSON.stringify(nosy).includes("session=abc"),
      JSON.stringify(nosy));
  }

  // ======================================================================
  console.log("\n=== 2. linktr.ee stays linktr.ee ===\n");
  // ======================================================================
  {
    // ============ THE ASSERTION THIS WHOLE FILE IS FOR ==============
    //
    // A link-in-bio page is the case where guessing is most tempting and most
    // wrong: everybody "knows" a Linktree tap probably came from Instagram,
    // and Genesis does not know that. It knows they came from linktr.ee.
    const r = classifyArrival({ referer: "https://linktr.ee/cubitandcoil" });
    eq("the intermediary is the source", r.source, "linktr.ee");
    eq("as an observed referral", r.kind, "observed_referral");
    assert("and Instagram appears nowhere in the result",
      !JSON.stringify(r).toLowerCase().includes("instagram"), JSON.stringify(r));

    for (const host of ["linktr.ee", "beacons.ai", "bio.link", "t.co", "l.facebook.com"]) {
      const out = classifyArrival({ referer: `https://${host}/x` });
      eq(`${host} is recorded as itself`, out.source, host);
    }

    // And there is no mapping table anywhere to drift into one.
    const source = readFileSync("lib/attribution/classify.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const platform of ["instagram", "facebook", "tiktok", "twitter"]) {
      assert(`the classifier has no rule mentioning ${platform}`,
        !new RegExp(platform, "i").test(source), platform);
    }
  }

  // ======================================================================
  console.log("\n=== 3. Direct traffic is never dressed up as something ===\n");
  // ======================================================================
  {
    const direct = classifyArrival({});
    eq("no referrer is direct or unknown", direct.kind, "direct_unknown");
    eq("with no source at all", direct.source, null);
    eq("and says why", direct.evidence, "no Referer header");
    eq("which a screen can name honestly", sourceLabel(direct), "Direct or unknown");

    const junk = classifyArrival({ referer: "not-a-url" });
    eq("a malformed referrer is also direct", junk.kind, "direct_unknown");
    eq("and is distinguished from having none", junk.evidence, "Referer unusable");

    // Internal navigation is not a referral, or every shop is its own top source.
    const internal = classifyArrival({
      referer: "https://shop.example.com/store/cubit-coil",
      selfHost: "shop.example.com",
    });
    eq("moving around the shop is not an arrival from anywhere", internal.kind, "direct_unknown");
  }

  // ======================================================================
  console.log("\n=== 4. An explicit tracking link says so, and outranks the header ===\n");
  // ======================================================================
  {
    const r = classifyArrival({ params: q("via=instagram") });
    eq("an explicit link is explicit tracking", r.kind, "explicit_tracking");
    eq("with the source it was given", r.source, "instagram");
    eq("naming the parameter as the evidence", r.evidence, "via parameter");

    const both = classifyArrival({
      referer: "https://linktr.ee/x",
      params: q("via=instagram&campaign=spring"),
    });
    eq("an explicit source beats an observed one", both.kind, "explicit_tracking");
    eq("because somebody meant it", both.source, "instagram");
    eq("and the campaign is kept", both.campaign, "spring");

    eq("utm_source is honoured too", classifyArrival({ params: q("utm_source=Newsletter") }).source, "newsletter");
    eq("and utm_campaign", classifyArrival({ params: q("utm_campaign=Spring") }).campaign, "spring");

    // A campaign with no source is still something the merchant supplied.
    const campaignOnly = classifyArrival({ params: q("campaign=launch") });
    eq("a campaign alone does not invent a source", campaignOnly.source, null);
    eq("but is not thrown away", campaignOnly.campaign, "launch");
  }

  // ======================================================================
  console.log("\n=== 5. `ref` is NOT a tracking parameter, because PayPal owns it ===\n");
  // ======================================================================
  {
    // ============ THE COLLISION FOUND BEFORE IT SHIPPED =============
    //
    // app/api/checkout/paypal/return/route.ts redirects a paying customer to
    // `/store/<slug>?payment_pending=1&ref=<token>`, and the storefront renders
    // it to them as "Reference <token>". Had `ref` been the tracking parameter,
    // every PayPal return would have been classified as explicit tracking with
    // a PayPal transaction token as its source -- garbage arriving only for
    // customers who actually paid.
    const paypalReturn = classifyArrival({ params: q("payment_pending=1&ref=EC-7RX99999") });
    eq("a PayPal return is not a tracked source", paypalReturn.kind, "direct_unknown");
    eq("and no transaction token is recorded as traffic", paypalReturn.source, null);
    assert("`ref` is not in the source parameter list",
      !(SOURCE_PARAMS as readonly string[]).includes("ref"), JSON.stringify(SOURCE_PARAMS));

    const route = readFileSync("app/api/checkout/paypal/return/route.ts", "utf8");
    assert("and the PayPal route really does still use ref", /[?&]ref=\$\{/.test(route),
      "the collision this guards may have moved");
  }

  // ======================================================================
  console.log("\n=== 6. A spoofed parameter cannot attribute to another store ===\n");
  // ======================================================================
  {
    // Attribution carries no store identifier at all, which is the strongest
    // possible answer: there is nothing in the URL for an attacker to forge.
    // The store comes from the route, and the visit from a per-store cookie.
    const hostile = classifyArrival({
      params: q("via=instagram&storeId=cmXXXXXX&store=victim&storeSlug=victim"),
    });
    eq("the source is only ever the source", hostile.source, "instagram");
    assert("and nothing store-shaped survives classification",
      !JSON.stringify(hostile).includes("victim") && !JSON.stringify(hostile).includes("cmXXXXXX"),
      JSON.stringify(hostile));

    const visitSrc = readFileSync("lib/attribution/visit.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    assert("the visit lookup is always scoped by store",
      !/storeVisit\.findUnique\(\{\s*where:\s*\{\s*visitToken/.test(visitSrc),
      "a visit is looked up by token alone somewhere");
    assert("and every lookup uses the composite key",
      (visitSrc.match(/storeId_visitToken/g) ?? []).length >= 3, "fewer store-scoped lookups than expected");
  }

  // ======================================================================
  console.log("\n=== 7. Long, hostile and control-character values are bounded ===\n");
  // ======================================================================
  {
    const long = classifyArrival({ params: q(`via=${"a".repeat(500)}`) });
    assert("an absurd source is truncated", (long.source ?? "").length <= 64, String(long.source?.length));

    const ctrl = new URLSearchParams();
    ctrl.set("via", `insta${String.fromCharCode(0)}gram${String.fromCharCode(27)}[31m`);
    const cleaned = classifyArrival({ params: ctrl });
    assert("control characters are stripped",
      !/[-]/.test(cleaned.source ?? ""), JSON.stringify(cleaned.source));

    const blank = classifyArrival({ params: q("via=%20%20") });
    eq("a whitespace-only source is not a source", blank.kind, "direct_unknown");
  }

  // ======================================================================
  console.log("\n=== 8. Attribution rides the draft into a real order ===\n");
  // ======================================================================
  {
    const store = await makeStore();
    const product = await prismaSystem.product.create({
      data: { storeId: store.id, name: "Ring", description: "d", priceInCents: 3232, active: true },
    });
    const visit = await prismaSystem.storeVisit.create({
      data: {
        storeId: store.id, visitToken: `tok-${stamp}`, attributionKind: "observed_referral",
        source: "instagram.com", campaign: null, evidence: "Referer host",
        landingPath: `/store/${store.slug}`,
      },
    });

    // THE REAL PRICER, not a hand-built pricing object. My first attempt made
    // one up and freezeLines threw on `pricing.lines` -- a fixture shaped like
    // the thing under test is a second definition of it, and this suite is
    // about what really happens on the way to an order.
    const lines = [{
      productId: product.id, name: product.name, imageUrl: null,
      unitPriceInCents: 3232, quantity: 1,
    }];
    const pricing = priceOrder({ lines: lines.map((l) => ({
      productId: l.productId, unitPriceInCents: l.unitPriceInCents, quantity: l.quantity,
    })) } as never);

    const draftId = await createCheckoutDraft({
      storeId: store.id,
      lines,
      pricing,
      attribution: {
        attributionKind: visit.attributionKind,
        attributionSource: visit.source,
        attributionCampaign: visit.campaign,
        attributionEvidence: visit.evidence,
        attributionVisitId: visit.id,
      },
    });

    const loaded = await loadDraft(store.id, draftId);
    eq("the draft froze the source", loaded?.attributionSource, "instagram.com");
    eq("the kind", loaded?.attributionKind, "observed_referral");
    eq("the evidence", loaded?.attributionEvidence, "Referer host");
    eq("and the visit it came from", loaded?.attributionVisitId, visit.id);

    // ---- and the order keeps it even when the visit is gone -------------
    const order = await prismaSystem.order.create({
      data: {
        storeId: store.id, productName: product.name, quantity: 1, amountInCents: 3232,
        buyerEmail: `b-${stamp}@example.test`, paymentProvider: "STRIPE",
        externalOrderId: `cs_attr_${stamp}`, status: "paid", productId: product.id,
        attributionKind: loaded!.attributionKind,
        attributionSource: loaded!.attributionSource,
        attributionCampaign: loaded!.attributionCampaign,
        attributionEvidence: loaded!.attributionEvidence,
        attributionVisitId: loaded!.attributionVisitId,
      },
    });

    // THE PRUNE HAPPENS. An order from thirteen months ago must still say where
    // it came from after its raw visit is gone -- that is the whole reason
    // these are frozen copies rather than a foreign key.
    await prismaSystem.storeVisit.delete({ where: { id: visit.id } });
    const after = await prismaSystem.order.findUnique({
      where: { id: order.id },
      select: { attributionSource: true, attributionKind: true, attributionEvidence: true },
    });
    eq("the order still knows its source after the visit is deleted",
      after?.attributionSource, "instagram.com");
    eq("and its kind", after?.attributionKind, "observed_referral");
    eq("and why", after?.attributionEvidence, "Referer host");
  }

  // ======================================================================
  console.log("\n=== 9. Revenue by source is answerable ===\n");
  // ======================================================================
  {
    const store = await makeStore();
    const mk = async (source: string | null, kind: string, cents: number, n: number) =>
      prismaSystem.order.create({
        data: {
          storeId: store.id, productName: "Ring", quantity: 1, amountInCents: cents,
          buyerEmail: `rev-${stamp}-${n}@example.test`, paymentProvider: "STRIPE",
          externalOrderId: `cs_rev_${stamp}_${n}`, status: "paid",
          attributionKind: kind, attributionSource: source, attributionEvidence: "Referer host",
        },
      });
    await mk("instagram.com", "observed_referral", 3000, 1);
    await mk("instagram.com", "observed_referral", 2000, 2);
    await mk(null, "direct_unknown", 1000, 3);

    const bySource = await prismaSystem.order.groupBy({
      by: ["attributionSource"],
      where: { storeId: store.id, status: "paid" },
      _sum: { amountInCents: true },
      _count: { _all: true },
    });
    const instagram = bySource.find((r) => r.attributionSource === "instagram.com");
    const direct = bySource.find((r) => r.attributionSource === null);
    eq("Instagram's revenue is the sum of its orders", instagram?._sum.amountInCents, 5000);
    eq("across two orders", instagram?._count._all, 2);
    eq("and direct is counted separately, not folded in", direct?._sum.amountInCents, 1000);
  }

  // ======================================================================
  console.log("\n=== 10. Pruning preserves the business fact it deletes ===\n");
  // ======================================================================
  {
    const store = await makeStore();
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 3; i++) {
      await prismaSystem.storeVisit.create({
        data: {
          storeId: store.id, visitToken: `old-${stamp}-${i}`, attributionKind: "observed_referral",
          source: "instagram.com", evidence: "Referer host", landingPath: "/",
          firstSeenAt: old, lastSeenAt: old,
        },
      });
    }
    await prismaSystem.storeVisit.create({
      data: {
        storeId: store.id, visitToken: `old-direct-${stamp}`, attributionKind: "direct_unknown",
        source: null, evidence: "no Referer header", landingPath: "/",
        firstSeenAt: old, lastSeenAt: old,
      },
    });
    // And one recent visit, which must survive.
    await prismaSystem.storeVisit.create({
      data: {
        storeId: store.id, visitToken: `new-${stamp}`, attributionKind: "observed_referral",
        source: "instagram.com", evidence: "Referer host", landingPath: "/",
      },
    });

    eq("the default retention is twelve months", RAW_VISIT_RETENTION_DAYS, 365);
    const result = await pruneStoreVisits({ storeId: store.id });
    eq("the old visits were deleted", result.deleted, 4);
    eq("and rolled up first", result.visits, 4);

    const days = await prismaSystem.storeTrafficDay.findMany({
      where: { storeId: store.id },
      select: { attributionKind: true, source: true, visits: true },
    });
    const ig = days.find((d) => d.source === "instagram.com");
    const dir = days.find((d) => d.attributionKind === "direct_unknown");
    eq("the Instagram count outlived the visitor records", ig?.visits, 3);
    eq("and so did the direct count", dir?.visits, 1);
    eq("direct is stored with an empty source, not null", dir?.source, "");

    const left = await prismaSystem.storeVisit.count({ where: { storeId: store.id } });
    eq("the recent visit is untouched", left, 1);

    // ---- re-running is a correction, never a doubling -------------------
    //
    // AGAINST VISITS THAT STILL EXIST. The first version rolled up after the
    // prune had already deleted them, so it found nothing, upserted nothing,
    // and passed while an `increment` bug sat untouched — a test that could
    // only ever be green. The one remaining recent visit is the fixture.
    // TODAY'S BUCKET, explicitly. The pruned visits are 400 days old and roll
    // into their own day, so a query that only named the store and source
    // matched the OLD row and compared it to itself — green whatever the
    // upsert did. A day-scoped read is the difference between testing the
    // rollup and testing nothing.
    const today = dayOf(new Date());
    const future = new Date(Date.now() + 60_000);
    await rollUpVisits({ before: future, storeId: store.id });
    const once = await prismaSystem.storeTrafficDay.findFirst({
      where: { storeId: store.id, day: today, attributionKind: "observed_referral", source: "instagram.com" },
      select: { visits: true },
    });
    await rollUpVisits({ before: future, storeId: store.id });
    await rollUpVisits({ before: future, storeId: store.id });
    const thrice = await prismaSystem.storeTrafficDay.findFirst({
      where: { storeId: store.id, day: today, attributionKind: "observed_referral", source: "instagram.com" },
      select: { visits: true },
    });
    assert("the rollup counted the visit that is still there",
      (once?.visits ?? 0) >= 1, String(once?.visits));
    eq("and rolling up three times reports the same number, not triple",
      thrice?.visits, once?.visits);
  }

  // ======================================================================
  console.log("\n=== 11. One business's traffic is its own ===\n");
  // ======================================================================
  {
    const a = await makeStore();
    const b = await makeStore();
    // THE SAME TOKEN on both shops. The cookie is per-store, but a token is a
    // string somebody holds, and the unique key is (storeId, visitToken) — so
    // this must be two visits, not one shared between businesses.
    const shared = `shared-${stamp}`;
    await prismaSystem.storeVisit.create({
      data: {
        storeId: a.id, visitToken: shared, attributionKind: "observed_referral",
        source: "instagram.com", evidence: "Referer host", landingPath: "/",
      },
    });
    await prismaSystem.storeVisit.create({
      data: {
        storeId: b.id, visitToken: shared, attributionKind: "direct_unknown",
        source: null, evidence: "no Referer header", landingPath: "/",
      },
    });

    const forA = await prismaSystem.storeVisit.findUnique({
      where: { storeId_visitToken: { storeId: a.id, visitToken: shared } },
      select: { source: true },
    });
    const forB = await prismaSystem.storeVisit.findUnique({
      where: { storeId_visitToken: { storeId: b.id, visitToken: shared } },
      select: { source: true },
    });
    eq("each business sees its own attribution for the same token", forA?.source, "instagram.com");
    eq("and the other's is untouched", forB?.source, null);
    eq("one shop's traffic count is its own",
      await prismaSystem.storeVisit.count({ where: { storeId: a.id } }), 1);

    // And the isolation guard knows about the new tables.
    const isolation = readFileSync("lib/tenantIsolation.ts", "utf8");
    assert("StoreVisit is tenant-scoped", /storeVisit: \["storeId"\]/.test(isolation));
    assert("and so is the rollup", /storeTrafficDay: \["storeId"\]/.test(isolation));
  }

  // ======================================================================
  console.log("\n=== 12. Nothing personal is collected ===\n");
  // ======================================================================
  {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const model = schema.slice(schema.indexOf("model StoreVisit {"), schema.indexOf("model StoreTrafficDay {"));
    for (const forbidden of ["ipAddress", "userAgent", "fingerprint", "email", "userId"]) {
      assert(`StoreVisit has no ${forbidden} column`, !new RegExp(`\\b${forbidden}\\b`).test(model), forbidden);
    }
    assert("and no referrer URL column, only a source",
      !/referrerUrl|refererUrl|fullReferrer/.test(model));

    const kinds = [...ATTRIBUTION_KINDS];
    eq("there are exactly three kinds", kinds.length, 3);
    eq("and they are the declared three", kinds,
      ["explicit_tracking", "observed_referral", "direct_unknown"]);
    assert("campaign parameters are declared", CAMPAIGN_PARAMS.length >= 1);
    eq("the day bucket is midnight UTC",
      dayOf(new Date("2026-09-01T23:59:59.000Z")).toISOString(), "2026-09-01T00:00:00.000Z");
  }

  await prismaSystem.user.deleteMany({ where: { email: { startsWith: `attr-${stamp}-` } } });

  for (const name of failed) console.log(`FAILED: ${name}`);
  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
