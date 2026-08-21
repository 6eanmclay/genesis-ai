import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// THE ONLY WAY SUPPLIER ECONOMICS GET WRITTEN, proven against real Postgres:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-economics-ingest.ts" -OutFile out.txt
//
// A connector, an owner-entry flow and a bulk import will all eventually write
// here, and they are not the same caller with different arguments. What each is
// ALLOWED to say is a property of the writer, so each has its own entry point.
//
// Two of the protections are structural rather than checked, and sections 1 and
// 4 are what prove that: a sync cannot reach another supplier's row because it
// never supplies a source key, and it cannot erase what a person found out
// because an OWNER row refuses it.

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

  const { ingestFromSupplier, recordOwnerQuote, recordUnavailable, recordProblem } =
    await import("@/lib/sourcing/economicsIngest");
  const { supplierEconomics, bulkTerms, provenanceOf } = await import("@/lib/sourcing/economics");
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

  const makeStore = async (slug: string) => {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    const store = await prisma.store.create({
      data: {
        userId: user.id, name: slug, slug, tagline: "t",
        description: "A fitness brand.", brandPositioning: "minimalist", currency: "USD",
      },
    });
    return { user, store };
  };

  const ref = (sourceKey: string, externalProductId: string, externalVariantId: string | null = null) => ({
    sourceKey, externalProductId, externalVariantId,
  });

  try {
    // -----------------------------------------------------------------------
    console.log("\n1. A connector cannot write under another supplier's key");
    {
      await reset();
      const { store } = await makeStore("ingest-identity");

      await ingestFromSupplier({
        storeId: store.id, sourceKey: "supplier-a",
        records: [{ externalProductId: "SHARED", minimumOrderUnits: 50, unitCostInCents: 410 }],
      });

      // The SAME external id, synced by a different connector. In a payload-
      // carries-the-key design this is the row that lands on the wrong product;
      // here the connector's own key is the only one it can write under, so the
      // two cannot collide however wrong the payload is.
      await ingestFromSupplier({
        storeId: store.id, sourceKey: "supplier-b",
        records: [{ externalProductId: "SHARED", minimumOrderUnits: 5000, unitCostInCents: 9999 }],
      });

      const a = await supplierEconomics(store.id, ref("supplier-a", "SHARED"));
      const b = await supplierEconomics(store.id, ref("supplier-b", "SHARED"));
      check("each keeps its own terms", [a?.minimumOrderUnits, b?.minimumOrderUnits], [50, 5000]);
      check("two rows, not one overwritten", await prisma.supplierEconomics.count({ where: { storeId: store.id } }), 2);

      // THERE IS NO FIELD TO GET WRONG. A record has no sourceKey, so a payload
      // that "claims" to be from elsewhere is written as what it actually is:
      // something supplier-a said.
      await ingestFromSupplier({
        storeId: store.id, sourceKey: "supplier-a",
        records: [
          { externalProductId: "SHARED", minimumOrderUnits: 7, unitCostInCents: 1 } as unknown as {
            externalProductId: string; minimumOrderUnits: number; unitCostInCents: number; sourceKey: string;
          },
        ],
      });
      check("supplier-b is untouched by supplier-a's sync",
        (await supplierEconomics(store.id, ref("supplier-b", "SHARED")))?.minimumOrderUnits, 5000);
      check("supplier-a's own row moved",
        (await supplierEconomics(store.id, ref("supplier-a", "SHARED")))?.minimumOrderUnits, 7);

      // Variants are part of identity too.
      await ingestFromSupplier({
        storeId: store.id, sourceKey: "supplier-a",
        records: [{ externalProductId: "SHARED", externalVariantId: "large", minimumOrderUnits: 200, unitCostInCents: 300 }],
      });
      check("the variant-less row is untouched",
        (await supplierEconomics(store.id, ref("supplier-a", "SHARED")))?.minimumOrderUnits, 7);
      check("and the variant has its own",
        (await supplierEconomics(store.id, ref("supplier-a", "SHARED", "large")))?.minimumOrderUnits, 200);

      // And no business reaches another's.
      const other = await makeStore("ingest-identity-2");
      check("another business sees nothing",
        await supplierEconomics(other.store.id, ref("supplier-a", "SHARED")), null);
    }

    // -----------------------------------------------------------------------
    console.log("\n2. A bad record is refused, and takes nothing with it");
    {
      await reset();
      const { store } = await makeStore("ingest-reject");

      const report = await ingestFromSupplier({
        storeId: store.id, sourceKey: "w",
        records: [
          { externalProductId: "good-1", minimumOrderUnits: 100, unitCostInCents: 410 },
          { externalProductId: "", minimumOrderUnits: 10, unitCostInCents: 100 },
          { externalProductId: "bad-negative", unitCostInCents: -5 },
          { externalProductId: "bad-fractional", minimumOrderUnits: 10.5 },
          { externalProductId: "bad-zero-minimum", minimumOrderUnits: 0, unitCostInCents: 410 },
          { externalProductId: "bad-tiers", tiers: [{ minUnits: 100, unitCostInCents: 410 }, { minUnits: 100, unitCostInCents: 380 }] },
          { externalProductId: "good-2", minimumOrderUnits: 50, unitCostInCents: 700 },
        ],
      });

      // THE GOOD ROWS SURVIVE. A sync of four hundred products must not lose
      // three hundred and ninety-nine because one had a negative price.
      check("the good ones landed", report.recorded, 2);
      check("the bad ones did not", report.rejected, 5);
      check("and only the good ones exist",
        (await prisma.supplierEconomics.findMany({ where: { storeId: store.id }, orderBy: { externalProductId: "asc" } }))
          .map((r) => r.externalProductId),
        ["good-1", "good-2"]);

      const problems = report.outcomes
        .filter((o) => o.status === "rejected")
        .map((o) => (o as { problem: string }).problem);
      assert("a zero minimum is called what it is",
        problems.some((p) => p.includes("nobody can order")), problems.join(" | "));
      assert("and contradictory price breaks are named",
        problems.some((p) => p.includes("same quantity")), problems.join(" | "));

      // NOTHING PARTIAL WAS WRITTEN. The failure this prevents is a row holding
      // the half that parsed, which looks answered.
      check("the rejected product has no row at all",
        await supplierEconomics(store.id, ref("w", "bad-tiers")), null);
    }

    // -----------------------------------------------------------------------
    console.log("\n3. Validation is a pure function, and says why");
    {
      check("a whole record is fine",
        recordProblem({ externalProductId: "p", minimumOrderUnits: 100, unitCostInCents: 410 }), null);
      check("an empty record about a real product is fine too",
        recordProblem({ externalProductId: "p" }), null);
      assert("a missing product id is refused",
        recordProblem({ externalProductId: "  " })?.includes("specific product") === true);
      assert("an unknown capability is refused",
        recordProblem({ externalProductId: "p", requiresCapabilities: ["fly_a_plane" as never] })
          ?.includes("not something Genesis knows how to ask") === true);
      // A stated 0 for shipping IS an answer — "delivery included" — and must
      // not be confused with the missing value it looks like.
      check("shipping of zero is a real answer",
        recordProblem({ externalProductId: "p", shippingPerUnitInCents: 0 }), null);
    }

    // -----------------------------------------------------------------------
    console.log("\n4. A sync cannot erase what a person found out");
    {
      await reset();
      const { user, store } = await makeStore("ingest-precedence");
      const productRef = ref("w", "roller-1");

      const quoted = await recordOwnerQuote({
        storeId: store.id, ref: productRef,
        minimumOrderUnits: 50, bulkUnitCostInCents: 380,
        userId: user.id, note: "quoted by phone",
      });
      check("the owner's quote is recorded", quoted.status, "recorded");

      // THE RULE THAT WAS WRITTEN DOWN AND ENFORCED BY NOTHING, now enforced PER
      // FACT. A catalogue sync cannot touch a figure a person obtained — but it
      // no longer has to give up everything else to leave that figure alone,
      // which is exactly what one provenance column forced.
      const sync = await ingestFromSupplier({
        storeId: store.id, sourceKey: "w",
        records: [{ externalProductId: "roller-1", minimumOrderUnits: 500, unitCostInCents: 900 }],
      });
      const outcome = sync.outcomes[0];
      assert("the sync ran", outcome.status === "recorded", JSON.stringify(outcome));
      if (outcome.status === "recorded") {
        check("and left the owner's two figures alone",
          [...outcome.preserved].sort(), ["minimumOrder", "unitCost"]);
        // It DID state everything the owner had not claimed: those facts are the
        // catalogue's to keep current, and refusing them would be the whole-row
        // refusal this change exists to end.
        check("while stating what nobody had claimed",
          [...outcome.wrote].sort(), ["handling", "shipping", "tiers"]);
      }

      const kept = await supplierEconomics(store.id, productRef);
      check("the owner's figures stand", [kept?.minimumOrderUnits, kept?.unitCostInCents], [50, 380]);
      check("as the owner's", [provenanceOf(kept, "minimumOrder"), provenanceOf(kept, "unitCost")], ["OWNER", "OWNER"]);
      check("with their note", kept?.note, "quoted by phone");

      // THE OWNER MAY ALWAYS CORRECT THEMSELVES. The rule protects a person from
      // a machine, not a person from themselves.
      await recordOwnerQuote({
        storeId: store.id, ref: productRef, minimumOrderUnits: 100, bulkUnitCostInCents: 410, userId: user.id,
      });
      check("a second quote replaces the first",
        (await supplierEconomics(store.id, productRef))?.minimumOrderUnits, 100);

      // AND A REFUSAL DOES NOT DELETE AN ANSWER. If somebody is turned away
      // today, what a person was told last month is still the last thing anybody
      // actually knew.
      const refused = await recordUnavailable({ storeId: store.id, ref: productRef, note: "wouldn't quote today" });
      check("marking it unavailable is refused too", refused.status, "preserved");
      check("and the terms survive",
        bulkTerms(await supplierEconomics(store.id, productRef)).bulkUnitCostInCents, 410);
    }

    // -----------------------------------------------------------------------
    console.log("\n5. A sync may replace a sync, and may answer an unanswered question");
    {
      await reset();
      const { store } = await makeStore("ingest-refresh");

      await ingestFromSupplier({
        storeId: store.id, sourceKey: "w",
        records: [{ externalProductId: "p1", minimumOrderUnits: 500, unitCostInCents: 900 }],
      });
      const second = await ingestFromSupplier({
        storeId: store.id, sourceKey: "w",
        records: [{ externalProductId: "p1", minimumOrderUnits: 100, unitCostInCents: 410 }],
      });
      check("a later sync wins over an earlier one", second.recorded, 1);
      check("with the newer figures",
        (await supplierEconomics(store.id, ref("w", "p1")))?.minimumOrderUnits, 100);

      // UNAVAILABLE means "we looked and there was no answer". A supplier that
      // now HAS an answer supersedes it — that is the whole point of asking again.
      await recordUnavailable({ storeId: store.id, ref: ref("w", "p2") });
      check("nothing is known about p2",
        bulkTerms(await supplierEconomics(store.id, ref("w", "p2"))).bulkUnitCostInCents, null);
      const answered = await ingestFromSupplier({
        storeId: store.id, sourceKey: "w",
        records: [{ externalProductId: "p2", minimumOrderUnits: 25, unitCostInCents: 310 }],
      });
      check("a catalogue that now quotes supersedes the refusal", answered.recorded, 1);
      check("and it becomes a supplier fact",
        provenanceOf(await supplierEconomics(store.id, ref("w", "p2")), "unitCost"), "SUPPLIER");
    }

    // -----------------------------------------------------------------------
    console.log("\n6. Absent stays absent across a re-sync");
    {
      await reset();
      const { store } = await makeStore("ingest-absence");

      await ingestFromSupplier({
        storeId: store.id, sourceKey: "w",
        records: [{
          externalProductId: "p1", minimumOrderUnits: 100, unitCostInCents: 410,
          tiers: [{ minUnits: 100, unitCostInCents: 410 }, { minUnits: 500, unitCostInCents: 300 }],
          shippingPerUnitInCents: 40, leadTimeDays: 21,
        }],
      });
      check("everything landed",
        (await supplierEconomics(store.id, ref("w", "p1")))?.tiers?.length, 2);

      // A LATER SYNC THAT SAYS NOTHING ABOUT PRICE BREAKS IS SAYING THERE ARE
      // NONE, not "leave the old ones". Prisma reads `undefined` as "don't touch
      // this column", so without the explicit null the engine would go on
      // quoting a price break the supplier had withdrawn.
      await ingestFromSupplier({
        storeId: store.id, sourceKey: "w",
        records: [{ externalProductId: "p1", minimumOrderUnits: 100, unitCostInCents: 410 }],
      });
      const after = await supplierEconomics(store.id, ref("w", "p1"));
      check("withdrawn price breaks are gone", after?.tiers, null);
      check("withdrawn shipping is unknown again", after?.shippingPerUnitInCents, null);
      check("withdrawn lead time too", after?.leadTimeDays, null);
      check("and what was restated stands", after?.minimumOrderUnits, 100);
    }

    // -----------------------------------------------------------------------
    console.log("\n7. An owner adding a fact does not retract the last one");
    {
      await reset();
      const { user, store } = await makeStore("ingest-merge");
      const productRef = ref("w", "roller-1");

      // Monday: they rang and got the minimum.
      await recordOwnerQuote({
        storeId: store.id, ref: productRef, minimumOrderUnits: 100, userId: user.id, note: "quoted by phone",
      });
      check("the minimum is on file",
        (await supplierEconomics(store.id, productRef))?.minimumOrderUnits, 100);

      // Tuesday: they ring back with the price. THIS IS ANSWERING THE SECOND
      // QUESTION, not restating the record — and before this was fixed,
      // Tuesday's message silently erased Monday's answer.
      await recordOwnerQuote({
        storeId: store.id, ref: productRef, bulkUnitCostInCents: 410, userId: user.id,
      });
      const merged = await supplierEconomics(store.id, productRef);
      check("Monday's minimum survives Tuesday's price",
        [merged?.minimumOrderUnits, merged?.unitCostInCents], [100, 410]);
      check("and it is all still theirs", [provenanceOf(merged, "minimumOrder"), provenanceOf(merged, "unitCost")], ["OWNER", "OWNER"]);
      check("with the note they gave", merged?.note, "quoted by phone");

      // A correction still wins — the rule protects a person from being erased,
      // not from changing their own mind.
      await recordOwnerQuote({
        storeId: store.id, ref: productRef, minimumOrderUnits: 50, userId: user.id,
      });
      const corrected = await supplierEconomics(store.id, productRef);
      check("a correction replaces the old figure",
        [corrected?.minimumOrderUnits, corrected?.unitCostInCents], [50, 410]);

      // AND A SYNC STILL MEANS WHAT IT SAID. Absent is absent for a connector: a
      // supplier that stops publishing a figure has withdrawn it, and carrying
      // the old one forward would quote a price nobody offers any more.
      await reset();
      const machine = await makeStore("ingest-merge-sync");
      await ingestFromSupplier({
        storeId: machine.store.id, sourceKey: "w",
        records: [{ externalProductId: "p1", minimumOrderUnits: 100, unitCostInCents: 410 }],
      });
      await ingestFromSupplier({
        storeId: machine.store.id, sourceKey: "w",
        records: [{ externalProductId: "p1", unitCostInCents: 410 }],
      });
      check("a withdrawn supplier figure does not linger",
        (await supplierEconomics(machine.store.id, ref("w", "p1")))?.minimumOrderUnits, null);

      // THE LIMIT THAT USED TO BE HERE IS GONE (2026-08-21). A partial owner
      // answer over a supplier's row used to drop the supplier's other figure,
      // because one row carried one provenance and carrying 410 into a row
      // stamped OWNER would have relabelled the supplier's number as the
      // owner's. Per-field provenance is what makes both true at once.
      await ingestFromSupplier({
        storeId: machine.store.id, sourceKey: "w",
        records: [{ externalProductId: "p2", unitCostInCents: 410 }],
      });
      await recordOwnerQuote({
        storeId: machine.store.id, ref: ref("w", "p2"), minimumOrderUnits: 100,
      });
      const mixed = await supplierEconomics(machine.store.id, ref("w", "p2"));
      check("the owner's fact is theirs",
        [provenanceOf(mixed, "minimumOrder"), mixed?.minimumOrderUnits], ["OWNER", 100]);
      check("the supplier's fact is still the supplier's",
        [provenanceOf(mixed, "unitCost"), mixed?.unitCostInCents], ["SUPPLIER", 410]);
      // BOTH FIGURES USABLE, EACH ATTRIBUTED TO WHOEVER ACTUALLY SAID IT. This
      // is the whole point of the change: the decision now has everything it
      // needs, and nothing in it is credited to the wrong party.
      check("and a bulk decision has what it needs",
        [bulkTerms(mixed).minimumOrderUnits, bulkTerms(mixed).bulkUnitCostInCents], [100, 410]);

      // And the sync that follows refreshes ITS figure without touching theirs.
      await ingestFromSupplier({
        storeId: machine.store.id, sourceKey: "w",
        records: [{ externalProductId: "p2", unitCostInCents: 380 }],
      });
      const refreshed = await supplierEconomics(machine.store.id, ref("w", "p2"));
      check("the catalogue updates its own price", refreshed?.unitCostInCents, 380);
      check("and the owner's minimum is untouched",
        [provenanceOf(refreshed, "minimumOrder"), refreshed?.minimumOrderUnits], ["OWNER", 100]);
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
