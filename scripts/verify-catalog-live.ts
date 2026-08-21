import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// THE CATALOG, against a real database:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-catalog-live.ts" -OutFile out.txt
//
// "The catalog is not the product. The intelligence behind the catalog is the
// product." So what is proven here is not that a list renders. It is that every
// row carries a judgement that came from the functions that already make it —
// fit, feasibility, framing, provenance — and that none of them was quietly
// re-implemented behind a screen.
//
// The four things a catalog could most easily get wrong, and each has a section:
// naming a supplier, inventing a price, claiming a fit it cannot judge, and
// letting one business see another's shelf.

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

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { catalogView } = await import("@/lib/sourcing/catalogView");
  const { adoptSourcedProduct, dismissSourcedProduct } = await import("@/lib/sourcing/adopt");
  const { recordOwnerQuote, ingestFromSupplier } = await import("@/lib/sourcing/economicsIngest");
  const { stateCapital } = await import("@/lib/sourcing/progression");
  const { getProductSources } = await import("@/lib/sourcing/registry");
  const { framingFor } = await import("@/lib/sourcing/framing");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  const SOURCE = getProductSources()[0].key;
  const SUPPLIER_NAMES = getProductSources().map((s) => s.displayName);

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

  async function makeStore(
    slug: string,
    description: string | null,
    currency = "USD",
    over: { tagline?: string } = {}
  ) {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    return prisma.store.create({
      data: {
        userId: user.id, name: `${slug} co`, slug,
        // The tagline is part of "the business in its own words" too, so a
        // store meant to have said NOTHING has to have said nothing here either.
        tagline: over.tagline ?? "t",
        description: description ?? "", brandPositioning: "minimalist", currency,
      },
    });
  }

  let n = 0;
  const suggest = (
    storeId: string,
    over: Partial<{
      name: string; kind: "PRINT_ON_DEMAND" | "WHOLESALE_DROPSHIP"; score: number;
      customizable: boolean; unitCostInCents: number | null; suggestedRetailInCents: number | null;
      externalProductId: string; description: string;
    }> = {}
  ) =>
    prisma.sourcedProduct.create({
      data: {
        storeId,
        sourceKey: SOURCE,
        externalProductId: over.externalProductId ?? `cand-${++n}`,
        kind: over.kind ?? "WHOLESALE_DROPSHIP",
        name: over.name ?? "Foam roller for recovery training",
        description: over.description ?? "A recovery and training tool for use at home",
        customizable: over.customizable ?? false,
        score: over.score ?? 20,
        unitCostInCents: over.unitCostInCents ?? null,
        suggestedRetailInCents: over.suggestedRetailInCents ?? null,
        status: "SUGGESTED",
      },
    });

  const FITNESS = "A fitness and recovery brand for people who train at home.";

  try {
    // =======================================================================
    console.log("\n1. Every row is a recommendation, grouped by what it means");
    {
      await reset();
      const store = await makeStore("shelf", FITNESS);
      await suggest(store.id, { name: "Foam roller", kind: "WHOLESALE_DROPSHIP", score: 30 });
      await suggest(store.id, {
        name: "Training tee", kind: "PRINT_ON_DEMAND", customizable: true, score: 24,
        description: "A training top you can put your own design on",
      });

      const view = await catalogView(store.id);
      check("Genesis knows the business", view.knowsTheBusiness, true);
      check("both suggestions are shown", view.totalSuggested, 2);

      // GROUPED BY WHAT IT MEANS FOR THE OWNER, and branded first, because that
      // is the move the framing calls "build your brand".
      check("two groups, branded first", view.groups.map((g) => g.kind),
        ["PRINT_ON_DEMAND", "WHOLESALE_DROPSHIP"]);
      check("with the owner's label", view.groups[0].label, framingFor("PRINT_ON_DEMAND").label);
      check("and the move it represents", view.groups[0].intent, framingFor("PRINT_ON_DEMAND").intent);

      // NO EMPTY GROUPS. A "Customizable products" heading with nothing under it
      // promises a branded route that is not there.
      assert("no group is empty", view.groups.every((g) => g.items.length > 0),
        view.groups.map((g) => `${g.kind}:${g.items.length}`).join(", "));

      // EVERY ROW CARRIES REASONING. This is the whole difference between a
      // recommendation and a listing.
      for (const group of view.groups) {
        for (const item of group.items) {
          assert(`${item.name}: has a verdict`, item.outcome.kind.length > 0);
          const speaks =
            item.outcome.kind === "not_a_fit"
              ? item.outcome.concerns.length > 0
              : item.outcome.kind === "cannot_assess"
                ? item.outcome.missing.length > 0
                : item.outcome.reasons.length > 0;
          assert(`${item.name}: and says something`, speaks, JSON.stringify(item.outcome));
        }
      }
    }

    // =======================================================================
    console.log("\n2. The owner never sees a supplier's name");
    {
      await reset();
      const store = await makeStore("unnamed", FITNESS);
      await suggest(store.id, { name: "Foam roller", score: 30 });
      await suggest(store.id, { name: "Training tee", kind: "PRINT_ON_DEMAND", customizable: true, score: 20 });

      const view = await catalogView(store.id);
      // Everything the owner reads AS A RECOMMENDATION. The blocked list is
      // deliberately excluded and checked separately below.
      const recommendations = JSON.stringify({
        describedAs: view.describedAs,
        groups: view.groups,
        startingSet: view.startingSet,
      });

      // "Printful" is an answer to a question nobody building a business is
      // asking. Every group, every row, every reason is searched.
      for (const name of SUPPLIER_NAMES) {
        assert(`"${name}" appears in no recommendation`,
          !recommendations.includes(name), recommendations.slice(0, 200));
      }
      // The source KEY is a supplier's name by another spelling.
      for (const source of getProductSources()) {
        assert(`nor does the key "${source.key}"`, !recommendations.includes(source.key));
      }

      // THE ONE EXCEPTION, AND IT IS THE POINT OF IT. A source Genesis could not
      // search is named, because the alternative is searching less than it
      // claims to and saying nothing — and "why did this only look in one place"
      // has to be answerable without reading code.
      assert("a source that could not be searched IS named",
        view.blockedSources.length === 0 ||
          view.blockedSources.every((b) => b.displayName.length > 0 && b.blockedOn.length > 0),
        JSON.stringify(view.blockedSources));
    }

    // =======================================================================
    console.log("\n3. Nothing about money is invented");
    {
      await reset();
      const store = await makeStore("money", FITNESS);
      await suggest(store.id, { name: "Foam roller", externalProductId: "roller-1", score: 30 });

      // NOBODY HAS SAID ANYTHING YET.
      const blank = (await catalogView(store.id)).groups[0].items[0];
      check("no cost is claimed", blank.economics.unitCostInCents, null);
      check("no minimum is claimed", blank.economics.minimumOrderUnits, null);
      check("and nobody is credited with saying so", blank.economics.attribution, []);

      // THE SUPPLIER SAID SO.
      await ingestFromSupplier({
        storeId: store.id, sourceKey: SOURCE,
        records: [{ externalProductId: "roller-1", unitCostInCents: 410, minimumOrderUnits: 100 }],
      });
      const supplied = (await catalogView(store.id)).groups[0].items[0];
      check("the figure is shown", supplied.economics.unitCostInCents, 410);
      check("credited to the catalogue",
        supplied.economics.attribution.find((a) => a.fact === "unitCost")?.said, "their catalogue");

      // THE OWNER SAID SO — and only about the thing they said.
      await recordOwnerQuote({ storeId: store.id, ref: { sourceKey: SOURCE, externalProductId: "roller-1", externalVariantId: null }, minimumOrderUnits: 50 });
      const mixed = (await catalogView(store.id)).groups[0].items[0];
      check("the owner's minimum is theirs",
        mixed.economics.attribution.find((a) => a.fact === "minimumOrder")?.said, "you");
      check("and the supplier's price is still the supplier's",
        mixed.economics.attribution.find((a) => a.fact === "unitCost")?.said, "their catalogue");
      check("both figures usable", [mixed.economics.minimumOrderUnits, mixed.economics.unitCostInCents], [50, 410]);

      // A REFUSAL IS NOT A PRICE.
      await reset();
      const refused = await makeStore("refused", FITNESS);
      await suggest(refused.id, { name: "Foam roller", externalProductId: "roller-1", score: 30 });
      const { recordUnavailable } = await import("@/lib/sourcing/economicsIngest");
      await recordUnavailable({ storeId: refused.id, ref: { sourceKey: SOURCE, externalProductId: "roller-1", externalVariantId: null } });
      const norefusal = (await catalogView(refused.id)).groups[0].items[0];
      check("a refusal shows no figure", norefusal.economics.unitCostInCents, null);
      check("and is credited as a refusal",
        norefusal.economics.attribution.find((a) => a.fact === "unitCost")?.said, "nobody would say");
    }

    // =======================================================================
    console.log("\n4. Foreign money is shown as foreign money");
    {
      await reset();
      const store = await makeStore("foreign", FITNESS, "USD");
      await suggest(store.id, { name: "Foam roller", externalProductId: "roller-1", score: 30 });
      // A STOCKED shape, because that is where money actually leaves the
      // owner's hands. At rung 0 nothing is bought, so there is no figure to
      // compare and no currency to disagree about — `assessFeasibility` returns
      // affordable before it ever looks, which is right.
      await prisma.sourcedProduct.updateMany({
        where: { storeId: store.id }, data: { kind: "WHOLESALE_STOCKED" },
      });
      await ingestFromSupplier({
        storeId: store.id, sourceKey: SOURCE, currency: "EUR",
        records: [{ externalProductId: "roller-1", unitCostInCents: 410, minimumOrderUnits: 100 }],
      });

      const item = (await catalogView(store.id)).groups[0].items[0];
      check("stored and shown in the supplier's currency", item.economics.currency, "EUR");
      // The engine refuses to compare rather than converting, and the row says
      // so rather than quietly showing a number nobody can act on.
      check("and it cannot be judged", item.outcome.kind, "cannot_assess");
      assert("naming the exchange rate it will not guess",
        item.outcome.kind === "cannot_assess" && item.outcome.missing.some((m) => m.includes("exchange rate")),
        JSON.stringify(item.outcome));
    }

    // =======================================================================
    console.log("\n5. 'I don't know you yet' is not 'nothing fits you'");
    {
      await reset();
      // A business that has described itself as nothing at all.
      const store = await makeStore("silent", null, "USD", { tagline: "" });
      await suggest(store.id, { name: "Foam roller", score: 30 });

      const view = await catalogView(store.id);
      check("Genesis says it does not know the business", view.knowsTheBusiness, false);
      // The suggestion is still listed, and still honest about why it cannot be
      // judged. Hiding it would be pretending nothing was found.
      const item = view.groups[0]?.items[0];
      assert("the row is still shown", item !== undefined);
      check("and cannot be judged", item?.outcome.kind, "cannot_assess");
    }

    // =======================================================================
    console.log("\n6. The first shelf, and only for a business without one");
    {
      await reset();
      const store = await makeStore("first", FITNESS);
      for (let i = 0; i < 4; i++) await suggest(store.id, { name: `Recovery item ${i}`, score: 30 - i });
      await suggest(store.id, {
        name: "Branded training tee", kind: "PRINT_ON_DEMAND", customizable: true, score: 10,
        description: "A training top you can put your own design on",
      });

      const empty = await catalogView(store.id);
      assert("a business with no shelf gets a starting set", empty.startingSet !== null);
      assert("with real picks", (empty.startingSet?.picks.length ?? 0) > 0, JSON.stringify(empty.startingSet));
      assert("and J4 says why that shape",
        (empty.startingSet?.advice.length ?? 0) > 0, JSON.stringify(empty.startingSet?.advice));

      // Offering "I'd start with these five" to somebody with a shelf is not
      // advice, so it stops the moment there is one.
      await prisma.product.create({
        data: {
          storeId: store.id, name: "Something they already sell", description: "d",
          priceInCents: 1_000, sourceKind: "OWNER_MADE", active: true,
        },
      });
      check("a business with a shelf gets none", (await catalogView(store.id)).startingSet, null);
    }

    // =======================================================================
    console.log("\n7. Adding, and turning down");
    {
      await reset();
      const store = await makeStore("acting", FITNESS);
      const candidate = await suggest(store.id, { name: "Foam roller", score: 30, suggestedRetailInCents: 1_800 });
      const other = await suggest(store.id, { name: "Resistance bands", score: 20 });

      // ADD — the owner's price wins.
      const adopted = await adoptSourcedProduct({
        storeId: store.id, sourcedProductId: candidate.id, priceInCents: 2_400,
      });
      assert("it was adopted", adopted.ok, JSON.stringify(adopted));
      const product = await prisma.product.findFirstOrThrow({ where: { storeId: store.id } });
      check("at the owner's price", product.priceInCents, 2_400);
      check("carrying where it came from", [product.sourceKey, product.externalProductId],
        [SOURCE, candidate.externalProductId]);
      check("and it leaves the suggestions", (await catalogView(store.id)).totalSuggested, 1);

      // NOT FOR ME — recorded, so it does not come back.
      await dismissSourcedProduct({ storeId: store.id, sourcedProductId: other.id });
      check("nothing is suggested now", (await catalogView(store.id)).totalSuggested, 0);
      check("and the catalog says so plainly", (await catalogView(store.id)).groups.length, 0);
      // The dismissal is a real record, not a hidden row.
      check("the dismissal is remembered",
        (await prisma.sourcedProduct.findUniqueOrThrow({ where: { id: other.id } })).status, "DISMISSED");
    }

    // =======================================================================
    console.log("\n8. One business never sees another's shelf");
    {
      await reset();
      const owner = await prisma.user.create({ data: { email: "two-shelves@example.test" } });
      const gym = await prisma.store.create({
        data: {
          userId: owner.id, name: "gym", slug: "gym-cat", tagline: "t",
          description: FITNESS, brandPositioning: "minimalist", currency: "USD",
        },
      });
      const coil = await prisma.store.create({
        data: {
          userId: owner.id, name: "coil", slug: "coil-cat", tagline: "t",
          description: "Hand-wound copper jewellery, made one at a time.",
          brandPositioning: "minimalist", currency: "USD",
        },
      });
      await suggest(gym.id, { name: "Foam roller", score: 30 });
      await suggest(coil.id, { name: "Copper wire spool", score: 25, description: "Copper wire for hand-wound jewellery" });

      const gymView = await catalogView(gym.id);
      const coilView = await catalogView(coil.id);
      check("the gym sees one thing", gymView.totalSuggested, 1);
      check("and it is its own", gymView.groups[0].items[0].name, "Foam roller");
      check("the other sees one thing", coilView.totalSuggested, 1);
      check("and it is its own", coilView.groups[0].items[0].name, "Copper wire spool");
      assert("neither contains the other's",
        !JSON.stringify(gymView).includes("Copper wire") && !JSON.stringify(coilView).includes("Foam roller"));
    }

    // =======================================================================
    console.log("\n9. Affordability is the engine's answer, not the screen's");
    {
      await reset();
      const store = await makeStore("afford", FITNESS);
      await suggest(store.id, { name: "Foam roller", externalProductId: "roller-1", score: 30 });
      // A stocked shape with real terms: something that costs money up front.
      await prisma.sourcedProduct.updateMany({
        where: { storeId: store.id },
        data: { kind: "WHOLESALE_STOCKED" },
      });
      await ingestFromSupplier({
        storeId: store.id, sourceKey: SOURCE,
        records: [{ externalProductId: "roller-1", unitCostInCents: 410, minimumOrderUnits: 100, shippingPerUnitInCents: 0, leadTimeDays: 7 }],
      });

      // Nothing stated about capital: shown, with the assumption named, never
      // hidden because today it cannot be afforded.
      const poor = (await catalogView(store.id)).groups[0].items[0];
      check("it is not yet", poor.outcome.kind, "not_yet");
      assert("with the assumption named",
        poor.outcome.kind === "not_yet" && poor.outcome.blockers.some((b) => b.includes("assumption")),
        JSON.stringify(poor.outcome));

      // The owner says what they have. Same row, different answer, and the
      // screen did not decide either one.
      await stateCapital(store.id, 50_000, ["hold_stock"]);
      const funded = (await catalogView(store.id)).groups[0].items[0];
      check("now it is recommended", funded.outcome.kind, "recommended_now");
    }

    // =======================================================================
    console.log("\n10. Genesis's own verdict survives the request");
    {
      await reset();
      const store = await makeStore("declined", FITNESS);

      // A source offering one thing that fits and one that plainly does not.
      const { discoverProducts } = await import("@/lib/sourcing/discover");
      const { buildSourcingContext } = await import("@/lib/sourcing/context");
      const source = {
        key: SOURCE, displayName: "Test partner", kind: "WHOLESALE_DROPSHIP" as const,
        capabilities: { customization: false, createsListings: false, shipsDirect: true, quotesCost: false, statesEconomics: false },
        fulfillmentProvider: null, blockedOn: [] as string[],
        async search() {
          return {
            ok: true as const,
            candidates: [
              {
                sourceKey: SOURCE, externalProductId: "fits", externalVariantId: null,
                kind: "WHOLESALE_DROPSHIP" as const, name: "Foam roller",
                description: "A recovery and training tool for use at home",
                imageUrl: null, unitCostInCents: null, suggestedRetailInCents: null,
                currency: "USD", customizable: false, fulfillmentProvider: null,
              },
              {
                sourceKey: SOURCE, externalProductId: "does-not", externalVariantId: null,
                kind: "WHOLESALE_DROPSHIP" as const, name: "Wedding veil",
                description: "A lace wedding veil for a bride",
                imageUrl: null, unitCostInCents: null, suggestedRetailInCents: null,
                currency: "USD", customizable: false, fulfillmentProvider: null,
              },
            ],
          };
        },
      };

      const run = await discoverProducts({
        storeId: store.id,
        context: await buildSourcingContext(store.id),
        sources: [source],
      });
      assert("something was ruled out", run.ruledOut.length > 0, JSON.stringify(run.ruledOut));

      // THE WHOLE POINT: it is a row now, so it is still true on a page opened
      // later rather than only inside the request that produced it.
      const view = await catalogView(store.id);
      assert("and it is still there afterwards", view.ruledOut.length > 0, JSON.stringify(view.ruledOut));
      assert("with the reason Genesis gave",
        view.ruledOut[0].concerns.length > 0, JSON.stringify(view.ruledOut[0]));
      // It is NOT offered as something to add.
      assert("but never as a suggestion",
        !view.groups.some((g) => g.items.some((i) => i.name === "Wedding veil")),
        JSON.stringify(view.groups.map((g) => g.items.map((i) => i.name))));

      // AND IT IS RE-EVALUATED, because the judgement is only ever true of the
      // business as it was understood at the time. A business that changes what
      // it says about itself gets a different answer.
      await prisma.store.update({
        where: { id: store.id },
        data: { description: "A bridal boutique — veils, dresses and wedding accessories." },
      });
      await discoverProducts({
        storeId: store.id,
        context: await buildSourcingContext(store.id),
        sources: [source],
      });
      const after = await catalogView(store.id);
      assert("the veil is now suggested to a bridal business",
        after.groups.some((g) => g.items.some((i) => i.name === "Wedding veil")),
        JSON.stringify(after.groups.map((g) => g.items.map((i) => i.name))));

      // A DISMISSAL IS THE OWNER'S AND IS NEVER OVERWRITTEN BY A RE-RUN.
      const suggested = await prisma.sourcedProduct.findFirstOrThrow({
        where: { storeId: store.id, externalProductId: "does-not" },
      });
      await dismissSourcedProduct({ storeId: store.id, sourcedProductId: suggested.id });
      await discoverProducts({
        storeId: store.id,
        context: await buildSourcingContext(store.id),
        sources: [source],
      });
      check("a dismissal survives re-discovery",
        (await prisma.sourcedProduct.findUniqueOrThrow({ where: { id: suggested.id } })).status,
        "DISMISSED");
    }

    // =======================================================================
    console.log("\n11. Genesis goes looking on its own, but only with reason");
    {
      const { discoverIfWorthwhile } = await import("@/lib/sourcing/discoveryLifecycle");

      // NOTHING TO SEARCH ON. A description nobody wrote returns things nobody
      // can be told a reason for.
      await reset();
      const quiet = await makeStore("no-words", null, "USD", { tagline: "" });
      check("a business it does not know is not searched for",
        (await discoverIfWorthwhile(quiet.id)), { ran: false, reason: "no_description" });

      // ALREADY HAS A LIST. Discovery fills an empty catalog; refreshing a full
      // one is the owner's own "Look again".
      await reset();
      const full = await makeStore("has-list", FITNESS);
      await suggest(full.id, { name: "Foam roller" });
      check("a business with suggestions is left alone",
        (await discoverIfWorthwhile(full.id)), { ran: false, reason: "already_has_suggestions" });

      // EVERYTHING RULED OUT IS STILL A RECENT LOOK. A business where nothing
      // fitted has rows but no suggestions, and must not be re-searched on every
      // page load.
      await reset();
      const barren = await makeStore("all-ruled-out", FITNESS);
      await prisma.sourcedProduct.create({
        data: {
          storeId: barren.id, sourceKey: SOURCE, externalProductId: "no",
          kind: "WHOLESALE_DROPSHIP", name: "Wedding veil", status: "RULED_OUT", score: 0,
        },
      });
      check("it is not searched again immediately",
        (await discoverIfWorthwhile(barren.id)), { ran: false, reason: "ran_recently" });
    }

    // =======================================================================
    console.log("\n12. Genesis's verdict is an opinion, not a rule");
    {
      await reset();
      const store = await makeStore("override", FITNESS);
      const declined = await prisma.sourcedProduct.create({
        data: {
          storeId: store.id, sourceKey: SOURCE, externalProductId: "veil",
          kind: "WHOLESALE_DROPSHIP", name: "Wedding veil", status: "RULED_OUT", score: 0,
          suggestedRetailInCents: 4_500,
          recommendation: { verdict: "does_not_fit", concerns: ["It doesn't fit the brand you've described."] },
        },
      });

      const view = await catalogView(store.id);
      check("it is shown as ruled out", view.ruledOut.map((r) => r.name), ["Wedding veil"]);
      check("and never as a suggestion", view.groups.length, 0);
      // THE OVERRIDE HAS TO BE REACHABLE, which means the row carries what an
      // adoption needs. A form with no fallback price would refuse for a reason
      // that has nothing to do with the owner's judgement.
      check("carrying what an adoption needs", view.ruledOut[0].suggestedRetailInCents, 4_500);

      // THE OWNER OVERRULES IT. Genesis's opinion does not bind; only the
      // owner's own decision does.
      const adopted = await adoptSourcedProduct({
        storeId: store.id, sourcedProductId: declined.id, priceInCents: 5_000,
      });
      assert("adding anyway works", adopted.ok, JSON.stringify(adopted));
      const product = await prisma.product.findFirstOrThrow({ where: { storeId: store.id } });
      check("at the owner's price", product.priceInCents, 5_000);
      check("the row is theirs now",
        (await prisma.sourcedProduct.findUniqueOrThrow({ where: { id: declined.id } })).status, "ADOPTED");
      check("and it has left the ruled-out list", (await catalogView(store.id)).ruledOut, []);

      // A DISMISSAL STILL BINDS, and that is the whole reason the two statuses
      // are separate. One is Genesis's opinion; the other is the owner's
      // decision, and only the decision is a rule.
      const second = await prisma.sourcedProduct.create({
        data: {
          storeId: store.id, sourceKey: SOURCE, externalProductId: "veil-2",
          kind: "WHOLESALE_DROPSHIP", name: "Another veil", status: "DISMISSED", score: 0,
          suggestedRetailInCents: 4_500,
        },
      });
      const refused = await adoptSourcedProduct({ storeId: store.id, sourcedProductId: second.id });
      check("the owner's own decision still binds", refused.ok, false);
      check("for the right reason", refused.ok ? null : refused.reason, "dismissed");
    }

    // =======================================================================
    console.log("\n13. Nothing about the ruled-out list is silently truncated");
    {
      await reset();
      const store = await makeStore("many-declined", FITNESS);
      for (let i = 0; i < 45; i++) {
        await prisma.sourcedProduct.create({
          data: {
            storeId: store.id, sourceKey: SOURCE, externalProductId: `veil-${i}`,
            kind: "WHOLESALE_DROPSHIP", name: `Wedding veil ${i}`, status: "RULED_OUT", score: 0,
          },
        });
      }

      const view = await catalogView(store.id, { limit: 40 });
      check("the count is the real one", view.totalRuledOut, 45);
      check("while the list is capped", view.ruledOut.length, 40);
      // The page renders "Showing 40 of 45" from exactly these two numbers, so a
      // shortened list can never read as the whole of what Genesis decided
      // against.
      assert("and the two disagree, which is what makes the cap sayable",
        view.totalRuledOut > view.ruledOut.length);
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
