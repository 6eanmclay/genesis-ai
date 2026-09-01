import { startTestServer } from "@/scripts/lib/testServer";

// ATTRIBUTION AGAINST A REAL SERVER, WITH REAL HEADERS:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-attribution-live.ts" -OutFile out.txt
//
// ============ WHAT ONLY THIS LANE CAN PROVE (2026-09-01) ===============
//
// The database suite proves the classifier and the retention arithmetic. What
// it cannot touch is the half that only exists inside a request:
//
//   that proxy.ts runs at all, and mints a cookie
//   that a real `Referer` header reaches the recorder
//   that the naked URL still works with no tracking of any kind
//   that a refresh joins the visit instead of creating a second one
//   that the cookie survives navigating deeper into the shop
//
// Every request below is a real HTTP request to a real Next server on a real
// Postgres. Nothing is stubbed and no double is injected.

let failures = 0;
let passes = 0;

function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passes++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

/** The visit cookie this server set, if it set one. */
function visitCookie(response: Response, slug: string): string | null {
  const name = `genesis_visit_${slug}`;
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    if (raw.startsWith(`${name}=`)) return raw.split(";")[0].split("=")[1] ?? null;
  }
  return null;
}

function cookieAttrs(response: Response, slug: string): string {
  const name = `genesis_visit_${slug}`;
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    if (raw.startsWith(`${name}=`)) return raw;
  }
  return "";
}

async function main() {
  console.log("Starting a real Next server on a real Postgres. First compile takes a while.\n");
  const server = await startTestServer();
  const prisma = server.db.prisma;

  try {
    const stamp = Date.now();
    const user = await prisma.user.create({ data: { email: `live-attr-${stamp}@example.test` } });
    const store = await prisma.store.create({
      data: {
        userId: user.id, name: "Cubit & Coil", slug: `liveattr${stamp}`,
        tagline: "Hand-wound copper", description: "Rings.", currency: "USD", published: true,
      },
    });
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Copper Ring", description: "d", priceInCents: 3232, active: true },
    });
    const slug = store.slug;
    const url = `${server.baseUrl}/store/${slug}`;

    const visitsFor = () => prisma.storeVisit.findMany({ where: { storeId: store.id } });

    // ====================================================================
    console.log("\n=== 1. The naked storefront URL works, untouched ===\n");
    // ====================================================================
    {
      // Sean: "The merchant's normal storefront URL must continue to work
      // exactly as it does now." No parameter, no referrer, nothing.
      const res = await fetch(url, { redirect: "manual" });
      assert("the plain URL returns 200", res.status === 200, `status ${res.status}`);
      const html = await res.text();
      assert("and renders the real storefront", html.includes("Copper Ring"), html.slice(0, 160));

      const token = visitCookie(res, slug);
      assert("a visit cookie was minted by the proxy", Boolean(token), "no Set-Cookie for the visit");

      const attrs = cookieAttrs(res, slug);
      assert("it is httpOnly", /HttpOnly/i.test(attrs), attrs);
      assert("and SameSite=Lax, so it survives the return from a payment provider",
        /SameSite=Lax/i.test(attrs), attrs);

      const visits = await visitsFor();
      assert("the very first page view was recorded", visits.length === 1, `${visits.length} visits`);
      assert("as direct, because there was no referrer",
        visits[0]?.attributionKind === "direct_unknown", visits[0]?.attributionKind);
      assert("with no source invented", visits[0]?.source === null, String(visits[0]?.source));
      assert("and the evidence says why", visits[0]?.evidence === "no Referer header", visits[0]?.evidence);
    }

    // ====================================================================
    console.log("\n=== 2. A real Referer header records that host ===\n");
    // ====================================================================
    {
      const res = await fetch(url, {
        headers: { referer: "https://www.instagram.com/p/xyz/" },
        redirect: "manual",
      });
      assert("the request succeeded", res.status === 200, `status ${res.status}`);

      const token = visitCookie(res, slug);
      const visit = await prisma.storeVisit.findFirst({
        where: { storeId: store.id, visitToken: token ?? "" },
      });
      assert("the referral was recorded", visit !== null);
      assert("as an observed referral", visit?.attributionKind === "observed_referral", visit?.attributionKind);
      assert("with the host as the source", visit?.source === "instagram.com", String(visit?.source));
      assert("and the header named as the evidence", visit?.evidence === "Referer host", visit?.evidence);
      assert("the full referring URL is NOT stored anywhere on the row",
        !JSON.stringify(visit).includes("/p/xyz"), JSON.stringify(visit));
    }

    // ====================================================================
    console.log("\n=== 3. linktr.ee is recorded as linktr.ee ===\n");
    // ====================================================================
    {
      const res = await fetch(url, {
        headers: { referer: "https://linktr.ee/cubitandcoil" },
        redirect: "manual",
      });
      const token = visitCookie(res, slug);
      const visit = await prisma.storeVisit.findFirst({
        where: { storeId: store.id, visitToken: token ?? "" },
      });
      assert("the intermediary is the source", visit?.source === "linktr.ee", String(visit?.source));
      assert("and nothing became Instagram",
        !JSON.stringify(visit).toLowerCase().includes("instagram"), JSON.stringify(visit));
    }

    // ====================================================================
    console.log("\n=== 4. An explicit tracking link is recorded as intentional ===\n");
    // ====================================================================
    {
      const res = await fetch(`${url}?via=instagram&campaign=spring`, { redirect: "manual" });
      assert("a tracked link still returns 200", res.status === 200, `status ${res.status}`);
      const token = visitCookie(res, slug);
      const visit = await prisma.storeVisit.findFirst({
        where: { storeId: store.id, visitToken: token ?? "" },
      });
      assert("recorded as explicit tracking",
        visit?.attributionKind === "explicit_tracking", visit?.attributionKind);
      assert("with the source it was given", visit?.source === "instagram", String(visit?.source));
      assert("and the campaign", visit?.campaign === "spring", String(visit?.campaign));
      assert("naming the parameter as the evidence",
        visit?.evidence === "via parameter", visit?.evidence);
    }

    // ====================================================================
    console.log("\n=== 5. A refresh is the same visit, not a second one ===\n");
    // ====================================================================
    {
      const first = await fetch(url, {
        headers: { referer: "https://example.org/blog" },
        redirect: "manual",
      });
      const token = visitCookie(first, slug);
      assert("a token was issued", Boolean(token));

      const before = (await visitsFor()).length;
      // Five more requests carrying the cookie, as a real browser would.
      for (let i = 0; i < 5; i++) {
        await fetch(url, {
          headers: { cookie: `genesis_visit_${slug}=${token}` },
          redirect: "manual",
        });
      }
      const after = (await visitsFor()).length;
      assert("five more page views created no new visits", after === before, `${before} -> ${after}`);

      const visit = await prisma.storeVisit.findFirst({
        where: { storeId: store.id, visitToken: token ?? "" },
      });
      // THE ORIGINAL ATTRIBUTION SURVIVES. The refreshes carried no referrer at
      // all; if the recorder re-classified on every request, this visit would
      // now read as direct and the referral would be lost.
      assert("and the original source was not overwritten by referrer-less refreshes",
        visit?.source === "example.org", String(visit?.source));
      assert("the visit's last-seen time moved", visit !== null && visit.lastSeenAt >= visit.firstSeenAt);
    }

    // ====================================================================
    console.log("\n=== 6. Attribution survives navigating deeper into the shop ===\n");
    // ====================================================================
    {
      const landing = await fetch(url, {
        headers: { referer: "https://www.tiktok.com/@someone" },
        redirect: "manual",
      });
      const token = visitCookie(landing, slug);

      const detail = await fetch(`${server.baseUrl}/store/${slug}/products/${product.id}`, {
        headers: { cookie: `genesis_visit_${slug}=${token}` },
        redirect: "manual",
      });
      assert("the product page loads", detail.status === 200, `status ${detail.status}`);

      const visit = await prisma.storeVisit.findFirst({
        where: { storeId: store.id, visitToken: token ?? "" },
      });
      assert("still attributed to where they arrived from",
        visit?.source === "tiktok.com", String(visit?.source));
      assert("and the product they looked at is on the visit",
        (visit?.viewedProductIds ?? []).includes(product.id),
        JSON.stringify(visit?.viewedProductIds));
    }

    // ====================================================================
    console.log("\n=== 7. One shop's cookie does not attribute another's traffic ===\n");
    // ====================================================================
    {
      const other = await prisma.store.create({
        data: {
          userId: user.id, name: "Iron Gym", slug: `liveattrb${stamp}`,
          tagline: "t", description: "d", currency: "USD", published: true,
        },
      });

      const a = await fetch(url, {
        headers: { referer: "https://www.instagram.com/x" },
        redirect: "manual",
      });
      const token = visitCookie(a, slug);

      // The SAME token presented to the other shop, under its own cookie name.
      await fetch(`${server.baseUrl}/store/${other.slug}`, {
        headers: { cookie: `genesis_visit_${other.slug}=${token}` },
        redirect: "manual",
      });

      const mine = await prisma.storeVisit.findFirst({
        where: { storeId: store.id, visitToken: token ?? "" },
        select: { source: true },
      });
      const theirs = await prisma.storeVisit.findFirst({
        where: { storeId: other.id, visitToken: token ?? "" },
        select: { source: true },
      });
      assert("the first shop keeps its Instagram referral", mine?.source === "instagram.com", String(mine?.source));
      assert("the second records its own visit, not the first's source",
        theirs !== null && theirs.source === null, JSON.stringify(theirs));

      const crossed = await prisma.storeVisit.count({
        where: { storeId: other.id, source: "instagram.com" },
      });
      assert("no traffic bled between businesses", crossed === 0, `${crossed} bled`);
    }

    // ====================================================================
    console.log("\n=== 8. A store that does not exist records no traffic ===\n");
    // ====================================================================
    {
      const before = await prisma.storeVisit.count();
      const res = await fetch(`${server.baseUrl}/store/no-such-store-${stamp}`, { redirect: "manual" });
      assert("a missing store is still a 404", res.status === 404, `status ${res.status}`);
      const after = await prisma.storeVisit.count();
      assert("and nothing was recorded against anything", after === before, `${before} -> ${after}`);
    }

    // ====================================================================
    console.log("\n=== 9. An unpublished shop records nothing for a stranger ===\n");
    // ====================================================================
    {
      const hidden = await prisma.store.create({
        data: {
          userId: user.id, name: "Not Live", slug: `liveattrc${stamp}`,
          tagline: "t", description: "d", currency: "USD", published: false,
        },
      });
      const res = await fetch(`${server.baseUrl}/store/${hidden.slug}`, {
        headers: { referer: "https://www.instagram.com/x" },
        redirect: "manual",
      });
      assert("a stranger gets a 404", res.status === 404, `status ${res.status}`);
      const count = await prisma.storeVisit.count({ where: { storeId: hidden.id } });
      assert("and no visit was recorded for a shop nobody reached", count === 0, `${count} visits`);
    }

    console.log(`\n${failures} failed, ${passes} passed`);
  } finally {
    await server.close();
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
