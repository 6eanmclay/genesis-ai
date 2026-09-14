import { startTestServer } from "@/scripts/lib/testServer";
import { signIn, anonymous, type HttpSession } from "@/scripts/lib/httpSession";

// WHO MAY SEE A SHOP THAT IS NOT OPEN YET:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-storefront-visibility-live.ts" -OutFile out.txt
//
// ============ THE CONTRACT (2026-09-14) ================================
//
// Stated on the storefront since it was written, and now in one module rather
// than five:
//
//   "Unpublished stores are only visible to their own owner/employee,
//    previewing ahead of launch — never to a logged-out visitor or another
//    account. This is what lets the dashboard embed the real storefront as a
//    live preview before a merchant has published anything; customers still
//    get a real 404."
//
// Every route under /store/[slug] answered that for itself, no two the same.
// Measured, before this:
//
//                     owner              stranger
//   storefront        200 + preview      404          correct
//   product detail    404                404          the owner locked out
//   checkout          200                200          the stranger let in
//   bag               200                200          the stranger let in
//
// One mistake read from both ends: publication was enforced on ONE route and
// the others assumed that route was the only door.
//
// NO BROWSER, DELIBERATELY. The question is which account a route answers to,
// which is httpSession's own stated reason for existing — "starting Chromium
// to find out whether a route answers 404 to the wrong account is slow, flaky,
// and tests the form as much as the rule."
//
// THE PUBLISHED CASE IS ASSERTED AT THE END, and it is not a formality: a
// "fix" that simply refused these routes more often would pass every negative
// assertion above it and close the shop.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${label}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const server = await startTestServer();
  const prisma = server.db.prisma;

  try {
    const stamp = Date.now();

    const owner = await signIn({ baseUrl: server.baseUrl, db: server.db, email: `sv-owner-${stamp}@example.test` });
    const staff = await signIn({ baseUrl: server.baseUrl, db: server.db, email: `sv-staff-${stamp}@example.test` });
    // A REAL ACCOUNT THAT SIMPLY DOES NOT WORK HERE. The rule says "never to a
    // logged-out visitor OR ANOTHER ACCOUNT", and only this catches a fix that
    // checked "is anybody signed in" instead of "does this person work here".
    const outsider = await signIn({ baseUrl: server.baseUrl, db: server.db, email: `sv-other-${stamp}@example.test` });
    const nobody = anonymous(server.baseUrl);

    const store = await prisma.store.create({
      data: {
        userId: owner.userId,
        name: "Not Launched Yet",
        slug: `sv-${stamp}`,
        currency: "USD",
        published: false,
      },
    });
    await prisma.storeMember.create({
      data: { storeId: store.id, userId: staff.userId, role: "EMPLOYEE" },
    });
    await prisma.storeIntegration.create({
      data: { storeId: store.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: "acct_sv" },
    });
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: "Copper Ring",
        description: "the one thing for sale",
        priceInCents: 5000,
        active: true,
      },
    });

    const ROUTES: { label: string; path: string }[] = [
      { label: "storefront", path: `/store/${store.slug}` },
      { label: "product detail", path: `/store/${store.slug}/products/${product.id}` },
      { label: "checkout", path: `/store/${store.slug}/checkout/${product.id}` },
      { label: "bag", path: `/store/${store.slug}/bag` },
    ];

    const status = async (who: HttpSession, path: string) => (await who.fetch(path)).status;
    const bodyOf = async (who: HttpSession, path: string) => (await who.fetch(path)).text();

    // ==================================================================
    console.log("\n1. The owner previewing their own unpublished shop\n");
    // ==================================================================
    for (const route of ROUTES) {
      assert(`the owner reaches the ${route.label}`, (await status(owner, route.path)) === 200,
        `status ${await status(owner, route.path)}`);
    }
    {
      const front = await bodyOf(owner, `/store/${store.slug}`);
      assert("  the storefront says it is a preview",
        /Preview/.test(front) && /not published yet/.test(front));
      assert("  and offers View Details on the product",
        front.includes("View Details"));
      // THE LINK IT OFFERS MUST GO SOMEWHERE. This is the defect in one
      // assertion: the page rendered the link and the link answered 404.
      //
      // WHAT COUNTS AS "THE PAGE RENDERED", AND WHAT DOES NOT.
      //
      // `body.includes(name)` is not the question it looks like: a 404
      // response still streams the RSC flight payload, and generateMetadata
      // resolves separately from the page body — so under a sabotage that 404s
      // this route for the owner, "Copper Ring" was in the response anyway and
      // this assertion passed. The not-found page's own copy is no better in
      // the other direction: not-found.tsx is part of this segment's route
      // tree, so its text ships with EVERY response under /store/[slug],
      // including a perfectly healthy 200. Both were tried and both were
      // wrong; the status line and the rendered <head> are the two things that
      // actually differ, plus a price, which metadata never carries.
      const detailRes = await owner.fetch(`/store/${store.slug}/products/${product.id}`);
      const detail = await detailRes.text();
      assert("  and that link opens rather than 404ing",
        detailRes.status === 200, `status ${detailRes.status}`);
      assert("  showing the real product page, priced",
        detail.includes("$50.00"), detail.slice(0, 200));
      assert("  including in the browser tab, not 'Product not found'",
        /<title>Copper Ring<\/title>/.test(detail),
        /<title>([^<]*)<\/title>/.exec(detail)?.[1] ?? "(no title)");
    }

    // ==================================================================
    console.log("\n2. An employee sees it too — the rule says owner OR staff\n");
    // ==================================================================
    for (const route of ROUTES) {
      assert(`an employee reaches the ${route.label}`, (await status(staff, route.path)) === 200);
    }

    // ==================================================================
    console.log("\n3. Nobody else, signed in or not\n");
    // ==================================================================
    for (const route of ROUTES) {
      assert(`a logged-out visitor is refused the ${route.label}`,
        (await status(nobody, route.path)) === 404, `status ${await status(nobody, route.path)}`);
      assert(`  and so is another account at the ${route.label}`,
        (await status(outsider, route.path)) === 404, `status ${await status(outsider, route.path)}`);
    }
    {
      // THE ONE THAT WAS TAKING MONEY. An unpublished store's checkout answered
      // 200 to anybody and named the product, so a link shared while a shop was
      // live kept selling after the owner took the shop down.
      const checkout = await bodyOf(nobody, `/store/${store.slug}/checkout/${product.id}`);
      assert("a stranger's checkout does not name the product",
        !checkout.includes("Copper Ring"), checkout.slice(0, 200));
      const bag = await bodyOf(nobody, `/store/${store.slug}/bag`);
      assert("  nor does the bag name the shop", !bag.includes("Not Launched Yet"), bag.slice(0, 200));
    }

    // ==================================================================
    console.log("\n4. Published — the shop is open to everyone\n");
    // ==================================================================
    await prisma.store.update({ where: { id: store.id }, data: { published: true } });
    for (const route of ROUTES) {
      assert(`a logged-out customer reaches the ${route.label}`,
        (await status(nobody, route.path)) === 200, `status ${await status(nobody, route.path)}`);
    }
    {
      const detailRes = await nobody.fetch(`/store/${store.slug}/products/${product.id}`);
      const detail = await detailRes.text();
      assert("  and the product page sells to them",
        detailRes.status === 200 &&
          /<title>Copper Ring<\/title>/.test(detail) &&
          detail.includes("$50.00"),
        `status ${detailRes.status}, title ${/<title>([^<]*)<\/title>/.exec(detail)?.[1] ?? "(none)"}`);
      const front = await bodyOf(nobody, `/store/${store.slug}`);
      assert("  with no preview banner on a shop that is genuinely open",
        !/not published yet/.test(front));
    }

    console.log(`\n${failures} failed, ${passes} passed`);
    if (failures > 0) {
      console.log("\nFAILED:");
      for (const line of failed) console.log(`  ${line}`);
      process.exitCode = 1;
    }
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
