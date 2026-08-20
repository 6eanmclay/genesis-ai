import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import type { ProductSource, SourcedCandidate, SourceSearchResult } from "@/lib/sourcing/types";
import type { SourcingContext } from "@/lib/sourcing/recommend";

// Product discovery and adoption, against a real database:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-sourcing-live.ts" -OutFile out.txt
//
// P0.5. The catalog as the base of a discovery system rather than a list.
//
// THE TWO SOURCES BELOW ARE IMPLEMENTATIONS OF THE CONTRACT, NOT MOCKS OF
// SUPPLIERS. Only one real source is connectable today (Printful, and only with
// a merchant's own OAuth), so the wholesale/dropship half of the model would
// otherwise be asserted by reading it. What is under test here is the contract
// in lib/sourcing/types.ts — whether the pipeline genuinely holds two different
// shapes — and two implementations of a contract are what test a contract.
// No supplier's catalogue is invented: nothing here claims to be what AliExpress
// would return, and the real AliExpress source refuses rather than pretending
// (proven in verify-product-sourcing.ts).

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const CUBIT: SourcingContext = {
  ownWords:
    "Hand-wound copper tensor rings and coils for energy work and meditation. Every ring is made by hand from solid copper.",
  classifications: ["Wellness", "Handmade goods"],
  brandPositioning: "minimalist",
  sells: ["Copper tensor ring"],
  proven: ["Copper tensor ring"],
};

/** A print-on-demand shape: variants, customisable, creates a listing. */
function podSource(candidates: SourcedCandidate[]): ProductSource {
  return {
    key: "pod-test",
    displayName: "Print partner",
    kind: "PRINT_ON_DEMAND",
    capabilities: { customization: true, createsListings: true, shipsDirect: true, quotesCost: true },
    fulfillmentProvider: "PRINTFUL",
    blockedOn: [],
    async search(): Promise<SourceSearchResult> {
      return { ok: true, candidates };
    },
  };
}

/** A wholesale shape: no variant, not customisable, creates nothing. */
function wholesaleSource(candidates: SourcedCandidate[]): ProductSource {
  return {
    key: "wholesale-test",
    displayName: "Wholesale partner",
    kind: "WHOLESALE_DROPSHIP",
    capabilities: { customization: false, createsListings: false, shipsDirect: true, quotesCost: true },
    fulfillmentProvider: null,
    blockedOn: [],
    async search(): Promise<SourceSearchResult> {
      return { ok: true, candidates };
    },
  };
}

function pod(over: Partial<SourcedCandidate> = {}): SourcedCandidate {
  return {
    sourceKey: "pod-test",
    externalProductId: "p1",
    externalVariantId: "v1",
    kind: "PRINT_ON_DEMAND",
    name: "Copper Coil Print",
    description: "A print of a hand-wound copper coil",
    imageUrl: "https://images.example.test/coil.png",
    unitCostInCents: null,
    suggestedRetailInCents: null,
    currency: "USD",
    customizable: true,
    fulfillmentProvider: "PRINTFUL",
    ...over,
  };
}

function wholesale(over: Partial<SourcedCandidate> = {}): SourcedCandidate {
  return {
    sourceKey: "wholesale-test",
    externalProductId: "w1",
    // The shape difference that broke the first version of the unique key: a
    // wholesale listing has no variant at all.
    externalVariantId: null,
    kind: "WHOLESALE_DROPSHIP",
    name: "Solid Copper Wire Spool",
    description: "Bulk solid copper wire for winding coils",
    imageUrl: "https://images.example.test/wire.png",
    unitCostInCents: 600,
    suggestedRetailInCents: 2400,
    currency: "USD",
    customizable: false,
    fulfillmentProvider: null,
    ...over,
  };
}

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { discoverProducts } = await import("@/lib/sourcing/discover");
  const { adoptSourcedProduct, dismissSourcedProduct } = await import("@/lib/sourcing/adopt");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  async function reset() {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
        AND tablename <> '_genesis_test_database'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
  }

  async function makeStore(slug: string) {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    return prisma.store.create({
      data: { userId: user.id, name: `${slug} shop`, slug, tagline: "t", description: "d" },
    });
  }

  const rowsFor = (storeId: string) =>
    prisma.sourcedProduct.findMany({ where: { storeId }, orderBy: { name: "asc" } });

  try {
    // -----------------------------------------------------------------------
    console.log("\n1. Discovery holds both shapes at once");
    {
      await reset();
      const store = await makeStore("both-shapes");

      const result = await discoverProducts({
        storeId: store.id,
        context: CUBIT,
        sources: [podSource([pod()]), wholesaleSource([wholesale()])],
      });

      check("both were raised", result.suggested.length, 2);
      const rows = await rowsFor(store.id);
      const print = rows.find((r) => r.sourceKey === "pod-test")!;
      const bulk = rows.find((r) => r.sourceKey === "wholesale-test")!;

      check("the print is print-on-demand", print.kind, "PRINT_ON_DEMAND");
      check("and customisable", print.customizable, true);
      check("with its variant kept", print.externalVariantId, "v1");
      // The distinction the whole model exists for. Offering "add your artwork"
      // on a wholesale listing would be a promise to a customer that the
      // supplier has no idea was made.
      check("the wire is wholesale dropship", bulk.kind, "WHOLESALE_DROPSHIP");
      check("and is not customisable", bulk.customizable, false);
      check("with no variant, stored as the sentinel", bulk.externalVariantId, "");

      // Cost is recorded where the source gave one, and left unknown where it
      // did not. Never zero.
      check("a known cost is kept", bulk.unitCostInCents, 600);
      check("an unknown cost stays unknown", print.unitCostInCents, null);
    }

    // -----------------------------------------------------------------------
    console.log("\n2. Every suggestion carries the reasoning behind it");
    {
      await reset();
      const store = await makeStore("reasoning");
      await discoverProducts({
        storeId: store.id,
        context: CUBIT,
        sources: [wholesaleSource([wholesale()])],
      });

      const row = (await rowsFor(store.id))[0];
      const recommendation = row.recommendation as { score: number; reasons: string[]; basedOn: string[] };
      assert("a score is stored", typeof recommendation.score === "number", JSON.stringify(recommendation));
      check("and denormalised for sorting", row.score, recommendation.score);
      assert("with reasons an owner can read",
        recommendation.reasons.length > 0 && recommendation.reasons.every((r) => r.length > 10),
        JSON.stringify(recommendation.reasons));
      assert("naming the business's own words",
        recommendation.reasons.some((r) => r.toLowerCase().includes("copper")),
        JSON.stringify(recommendation.reasons));
      assert("and which signals were used", recommendation.basedOn.length > 0, recommendation.basedOn.join(", "));
      check("it starts as a suggestion", row.status, "SUGGESTED");
    }

    // -----------------------------------------------------------------------
    console.log("\n3. Running discovery again does not pile up duplicates");
    {
      await reset();
      const store = await makeStore("idempotent");
      const sources = [podSource([pod()]), wholesaleSource([wholesale()])];

      await discoverProducts({ storeId: store.id, context: CUBIT, sources });
      await discoverProducts({ storeId: store.id, context: CUBIT, sources });
      await discoverProducts({ storeId: store.id, context: CUBIT, sources });
      check("still two rows after three runs", (await rowsFor(store.id)).length, 2);

      // A supplier changing its price or wording corrects the row rather than
      // adding a second one. The variant-less candidate is the one that would
      // have duplicated under a nullable key, so it is the one checked.
      await discoverProducts({
        storeId: store.id,
        context: CUBIT,
        sources: [wholesaleSource([wholesale({ name: "Solid Copper Wire Spool", unitCostInCents: 750 })])],
      });
      const rows = await rowsFor(store.id);
      check("no new row", rows.length, 2);
      check("the price is corrected in place",
        rows.find((r) => r.sourceKey === "wholesale-test")!.unitCostInCents, 750);
    }

    // -----------------------------------------------------------------------
    console.log("\n4. A suggestion turned down stays down");
    {
      await reset();
      const store = await makeStore("dismissed");
      const sources = [wholesaleSource([wholesale()])];
      const first = await discoverProducts({ storeId: store.id, context: CUBIT, sources });

      const dismissed = await dismissSourcedProduct({
        storeId: store.id,
        sourcedProductId: first.suggested[0].id,
      });
      check("it is dismissed", dismissed.ok, true);

      // The next run finds the same supplier listing again. Raising it a second
      // time is the difference between a partner and a nag.
      const again = await discoverProducts({ storeId: store.id, context: CUBIT, sources });
      check("nothing is raised", again.suggested.length, 0);
      check("and the dismissal is counted rather than hidden", again.respectedDismissals, 1);
      check("still one row", (await rowsFor(store.id)).length, 1);
      check("still dismissed", (await rowsFor(store.id))[0].status, "DISMISSED");

      // And it cannot be adopted out from under the owner's decision.
      const adopted = await adoptSourcedProduct({
        storeId: store.id,
        sourcedProductId: first.suggested[0].id,
      });
      check("adopting it is refused", adopted.ok, false);
      assert("saying the owner turned it down",
        !adopted.ok && adopted.reason === "dismissed", JSON.stringify(adopted));
      check("no product was created", await prisma.product.count({ where: { storeId: store.id } }), 0);
    }

    // -----------------------------------------------------------------------
    console.log("\n5. Adopting one carries the sourcing facts onto the product");
    {
      await reset();
      const store = await makeStore("adopt");
      const found = await discoverProducts({
        storeId: store.id,
        context: CUBIT,
        sources: [wholesaleSource([wholesale()])],
      });

      const result = await adoptSourcedProduct({
        storeId: store.id,
        sourcedProductId: found.suggested[0].id,
        priceInCents: 2900,
      });
      assert("it is adopted", result.ok, JSON.stringify(result));
      if (!result.ok) throw new Error("adoption failed");

      const product = await prisma.product.findUniqueOrThrow({ where: { id: result.productId } });
      check("the owner's price, not the supplier's suggestion", product.priceInCents, 2900);
      check("the supplier's cost is kept", product.costInCents, 600);
      // THE FACTS THAT MUST SURVIVE. Without these the owner is shown a "buy a
      // shipping label" button for a parcel they will never hold.
      check("how it is sourced", product.sourceKind, "WHOLESALE_DROPSHIP");
      check("which source it came from", product.sourceKey, "wholesale-test");
      check("and the supplier's own id", product.externalProductId, "w1");
      // Converted back from the storage sentinel: there genuinely is no variant.
      check("no variant is invented", product.externalVariantId, null);
      // A wholesale supplier is not fulfilling on Genesis's behalf, and claiming
      // otherwise would put this in front of order-routing code with no idea
      // what to do with it.
      check("nobody is fulfilling on our behalf", product.fulfillmentProvider, null);

      const row = (await rowsFor(store.id))[0];
      check("the suggestion is marked adopted", row.status, "ADOPTED");
      check("and points at the product it became", row.adoptedProductId, result.productId);
    }

    // -----------------------------------------------------------------------
    console.log("\n6. An adopted suggestion is never raised or adopted twice");
    {
      await reset();
      const store = await makeStore("twice");
      const sources = [podSource([pod()])];
      const found = await discoverProducts({ storeId: store.id, context: CUBIT, sources });
      const first = await adoptSourcedProduct({
        storeId: store.id,
        sourcedProductId: found.suggested[0].id,
        priceInCents: 3000,
      });
      assert("adopted", first.ok);

      // Two clicks on one button.
      const second = await adoptSourcedProduct({
        storeId: store.id,
        sourcedProductId: found.suggested[0].id,
        priceInCents: 3000,
      });
      assert("the second is a no-op", second.ok && second.alreadyAdopted, JSON.stringify(second));
      check("one product, not two", await prisma.product.count({ where: { storeId: store.id } }), 1);

      // And discovery does not offer back something already in the catalogue.
      const again = await discoverProducts({ storeId: store.id, context: CUBIT, sources });
      check("nothing is re-suggested", again.suggested.length, 0);
      check("and the row stays adopted", (await rowsFor(store.id))[0].status, "ADOPTED");

      // Concurrency, which is the version of this that a status check alone
      // would not survive.
      await reset();
      const racing = await makeStore("racing");
      const raceFound = await discoverProducts({ storeId: racing.id, context: CUBIT, sources });
      const results = await Promise.all([
        adoptSourcedProduct({ storeId: racing.id, sourcedProductId: raceFound.suggested[0].id, priceInCents: 100 }),
        adoptSourcedProduct({ storeId: racing.id, sourcedProductId: raceFound.suggested[0].id, priceInCents: 100 }),
        adoptSourcedProduct({ storeId: racing.id, sourcedProductId: raceFound.suggested[0].id, priceInCents: 100 }),
      ]);
      check("every caller is told it worked", results.filter((r) => r.ok).length, 3);
      check("but only one product exists", await prisma.product.count({ where: { storeId: racing.id } }), 1);
    }

    // -----------------------------------------------------------------------
    console.log("\n7. One store's suggestions are never another's");
    {
      await reset();
      const a = await makeStore("store-a");
      const b = await makeStore("store-b");
      const sources = [wholesaleSource([wholesale()])];

      const foundA = await discoverProducts({ storeId: a.id, context: CUBIT, sources });
      await discoverProducts({ storeId: b.id, context: CUBIT, sources });

      // The same supplier listing for both stores, and two separate rows —
      // because the reasoning attached to it is about a particular business.
      check("each store has its own row", (await rowsFor(a.id)).length, 1);
      check("and so does the other", (await rowsFor(b.id)).length, 1);
      assert("they are different rows", (await rowsFor(a.id))[0].id !== (await rowsFor(b.id))[0].id);

      // Store B, holding store A's suggestion id. The id is real and valid.
      const crossed = await adoptSourcedProduct({
        storeId: b.id,
        sourcedProductId: foundA.suggested[0].id,
        priceInCents: 2900,
      });
      check("adopting across stores is refused", crossed.ok, false);
      assert("as not found, giving nothing away",
        !crossed.ok && crossed.reason === "not_found", JSON.stringify(crossed));
      check("store B gained no product", await prisma.product.count({ where: { storeId: b.id } }), 0);
      check("and store A's suggestion is untouched", (await rowsFor(a.id))[0].status, "SUGGESTED");

      // Dismissal is scoped the same way.
      const crossedDismiss = await dismissSourcedProduct({
        storeId: b.id,
        sourcedProductId: foundA.suggested[0].id,
      });
      check("dismissing across stores is refused", crossedDismiss.ok, false);
      check("store A's suggestion still stands", (await rowsFor(a.id))[0].status, "SUGGESTED");
    }

    // -----------------------------------------------------------------------
    console.log("\n8. A source that cannot be searched is named, never silently skipped");
    {
      await reset();
      const store = await makeStore("blocked");
      const { aliexpressSource } = await import("@/lib/sourcing/aliexpress");

      const result = await discoverProducts({
        storeId: store.id,
        context: CUBIT,
        sources: [wholesaleSource([wholesale()]), aliexpressSource],
      });

      check("the working source still delivered", result.suggested.length, 1);
      check("and the blocked one is reported", result.unavailable.length, 1);
      check("by name", result.unavailable[0].key, "aliexpress");
      check("as a configuration problem", result.unavailable[0].problem.reason, "not_configured");
      assert("naming what it needs",
        result.unavailable[0].problem.reason === "not_configured" &&
          result.unavailable[0].problem.missing.length > 0,
        JSON.stringify(result.unavailable[0]));
      // Nothing was invented on its behalf.
      check("and it contributed no rows", (await rowsFor(store.id)).filter((r) => r.sourceKey === "aliexpress").length, 0);

      // A source that throws mid-search is the same kind of answer, not a crash.
      const exploding: ProductSource = {
        ...wholesaleSource([]),
        key: "exploding",
        async search() {
          throw new Error("supplier is down");
        },
      };
      const withFailure = await discoverProducts({
        storeId: store.id,
        context: CUBIT,
        sources: [wholesaleSource([wholesale()]), exploding],
      });
      check("the outage is reported", withFailure.unavailable.length, 1);
      check("as a provider problem, not a configuration one",
        withFailure.unavailable[0].problem.reason, "provider_error");
    }

    // -----------------------------------------------------------------------
    console.log("\n9. Nothing worth saying is nothing written down");
    {
      await reset();
      const store = await makeStore("no-fit");
      const result = await discoverProducts({
        storeId: store.id,
        context: CUBIT,
        sources: [wholesaleSource([wholesale({ externalProductId: "w9", name: "Phone Case", description: "A case for phones" })])],
      });

      check("nothing is raised", result.suggested.length, 0);
      // Counted rather than stored: a row for something Genesis had no reason to
      // raise would be indistinguishable later from one it did.
      check("but it is counted", result.consideredAndSkipped, 1);
      check("and no row exists for it", (await rowsFor(store.id)).length, 0);
    }

    // -----------------------------------------------------------------------
    console.log("\n10. A source can only speak for itself");
    {
      await reset();
      const store = await makeStore("impersonation");
      // A candidate claiming another source's key would land on that source's
      // row through the unique key and quietly overwrite it.
      const liar: ProductSource = {
        ...wholesaleSource([wholesale({ sourceKey: "pod-test", name: "Copper Coil Print" })]),
        key: "wholesale-test",
      };

      const result = await discoverProducts({ storeId: store.id, context: CUBIT, sources: [liar] });
      check("the impostor candidate is dropped", result.suggested.length, 0);
      check("and nothing was written under the other source's key",
        (await rowsFor(store.id)).filter((r) => r.sourceKey === "pod-test").length, 0);
    }

    // -----------------------------------------------------------------------
    console.log("\n11. Deleting an adopted product does not erase the memory of finding it");
    {
      await reset();
      const store = await makeStore("deleted");
      const found = await discoverProducts({
        storeId: store.id,
        context: CUBIT,
        sources: [wholesaleSource([wholesale()])],
      });
      const adopted = await adoptSourcedProduct({
        storeId: store.id,
        sourcedProductId: found.suggested[0].id,
        priceInCents: 2900,
      });
      if (!adopted.ok) throw new Error("adoption failed");

      await prisma.product.delete({ where: { id: adopted.productId } });
      const row = (await rowsFor(store.id))[0];
      // SetNull rather than Cascade. Losing the row would mean discovery offers
      // the same thing straight back the next time it runs.
      assert("the suggestion survives", row !== undefined);
      check("with its link cleared", row.adoptedProductId, null);

      // And it can be adopted again, because it is still a real thing the
      // supplier offers.
      const readopted = await adoptSourcedProduct({
        storeId: store.id,
        sourcedProductId: found.suggested[0].id,
        priceInCents: 3100,
      });
      assert("and can be added back", readopted.ok, JSON.stringify(readopted));
      check("as one product", await prisma.product.count({ where: { storeId: store.id } }), 1);
    }

    // -----------------------------------------------------------------------
    console.log("\n12. An unpriced suggestion cannot be adopted without a price");
    {
      await reset();
      const store = await makeStore("unpriced");
      const found = await discoverProducts({
        storeId: store.id,
        context: CUBIT,
        // The print-on-demand candidate has no suggested retail — cost is only
        // fetched on demand, so there is nothing to default to.
        sources: [podSource([pod()])],
      });

      const noPrice = await adoptSourcedProduct({ storeId: store.id, sourcedProductId: found.suggested[0].id });
      check("it refuses", noPrice.ok, false);
      assert("asking the owner what they will charge",
        !noPrice.ok && noPrice.detail.includes("what you'll charge"), JSON.stringify(noPrice));
      check("nothing was created", await prisma.product.count({ where: { storeId: store.id } }), 0);
      // The claim must not have stuck, or the suggestion is lost.
      check("and the suggestion is still open", (await rowsFor(store.id))[0].status, "SUGGESTED");

      const priced = await adoptSourcedProduct({
        storeId: store.id,
        sourcedProductId: found.suggested[0].id,
        priceInCents: 4200,
      });
      assert("with a price it works", priced.ok, JSON.stringify(priced));
    }

    // -----------------------------------------------------------------------
    console.log("\n13. Products that predate any of this are unchanged");
    {
      await reset();
      const store = await makeStore("existing");
      // Cubit & Coil's own products: entered by hand by the person who makes
      // them. The default has to be true of them, because nothing backfills it.
      const own = await prisma.product.create({
        data: { storeId: store.id, name: "Copper tensor ring", description: "Hand-wound", priceInCents: 8500 },
      });
      check("owner-made by default", own.sourceKind, "OWNER_MADE");
      check("with no source", own.sourceKey, null);
      check("and nobody fulfilling it", own.fulfillmentProvider, null);
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    await db.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
