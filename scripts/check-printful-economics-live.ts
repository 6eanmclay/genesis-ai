import fs from "node:fs";

// DOES `economics()` SURVIVE CONTACT WITH THE REAL PRINTFUL?
//
//   npx tsx scripts/check-printful-economics-live.ts
//
// A CHECK, NOT A VERIFICATION SUITE, and the distinction is deliberate. It talks
// to a third party over the network against real production credentials, so it
// is not part of the regression, is never run by run-db-suites, and is expected
// to be run by a person who has read this comment.
//
// STRICTLY READ-ONLY on Genesis's side. It reads production to find a connected
// account, calls three Printful GET/POST-for-rates endpoints, and prints what
// came back. It writes nothing to SupplierEconomics and nothing to any store.
//
// ONE SIDE EFFECT IT CANNOT AVOID, named rather than hidden: resolving
// credentials refreshes an expired OAuth token and writes the new one back, the
// same thing any page load for that store already does.
//
// WHOSE ACCOUNT. Only a Genesis-owned audit account, matched by email below. The
// production database also holds a real customer's Printful connection, and
// making API calls on somebody's account to satisfy a test is not something to
// do because it is technically possible.

const OURS = /@example\.test$/;

async function main() {
  const url = fs.readFileSync(".env.livecheck", "utf8").match(/^DATABASE_URL="?([^"\n\r]+)/m)?.[1];
  if (!url) {
    console.log("No live database URL. Nothing to check.");
    process.exit(1);
  }
  process.env.DATABASE_URL = url;

  const { prismaSystem: prisma } = await import("@/lib/prisma");
  const { printfulSource } = await import("@/lib/sourcing/printful");
  const { printfulEconomicsQuote } = await import("@/lib/fulfillment/printful");

  const connected = await prisma.storeIntegration.findMany({
    where: { provider: "PRINTFUL" },
    select: { storeId: true, credentials: true },
  });
  const stores = await prisma.store.findMany({
    where: { id: { in: connected.filter((c) => c.credentials !== null).map((c) => c.storeId) } },
    select: { id: true, slug: true, user: { select: { email: true } } },
  });

  const ours = stores.filter((store) => OURS.test(store.user.email ?? ""));
  console.log(`Printful connections in production: ${connected.length}`);
  console.log(`Genesis-owned among them: ${ours.length}`);
  if (ours.length === 0) {
    console.log("None of them are ours. Not touching a customer's account.");
    await prisma.$disconnect();
    process.exit(1);
  }

  for (const store of ours) {
    console.log(`\n--- ${store.slug} ---`);

    // WHAT `economics()` ITSELF WOULD DO, unchanged and against the real thing.
    const stated = await printfulSource.economics!({ storeId: store.id });
    console.log(`economics(): ${stated.ok ? `ok, ${stated.statements.length} statements in ${stated.currency}` : `unavailable — ${stated.detail ?? stated.reason}`}`);

    // Every one of these accounts has nothing adopted, so the call above
    // correctly states nothing and never reaches the API. The half that has
    // never run is the quote itself, so it is exercised directly against a real
    // catalogue product.
    const search = await printfulSource.search({
      storeId: store.id,
      keywords: "training fitness apparel",
      brandPositioning: "minimalist",
      limit: 8,
    });

    if (!search.ok) {
      console.log(`search(): unavailable — ${search.detail ?? search.reason}`);
      continue;
    }
    const withVariant = search.candidates.find((c) => c.externalVariantId);
    if (!withVariant) {
      console.log(`search(): ${search.candidates.length} candidates, none with a variant to price.`);
      continue;
    }

    console.log(`search(): ${search.candidates.length} candidates; pricing "${withVariant.name}"`);
    try {
      const quote = await printfulEconomicsQuote({
        storeId: store.id,
        externalProductId: withVariant.externalProductId,
        externalVariantId: withVariant.externalVariantId!,
      });
      console.log(`  currency:   ${quote.currency}   <- read from Printful, not assumed`);
      console.log(`  unit cost:  ${quote.unitCostInCents} cents`);
      console.log(
        `  shipping:   ${quote.shippingPerUnitInCents === null ? "null (rate lookup failed — NOT recorded as free)" : `${quote.shippingPerUnitInCents} cents`}`
      );
    } catch (error) {
      console.log(`  failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
