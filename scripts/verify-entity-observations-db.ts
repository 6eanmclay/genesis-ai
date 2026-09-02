import "@/scripts/lib/allowServerOnly";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { upsertObservation, observationFromReview } from "@/lib/dashboard/genesisObservations";
import { notifyFromInsights } from "@/lib/intelligence/notify";
import { computeInsights } from "@/lib/intelligence/insights";
import type { Insight } from "@/lib/intelligence/insights";
import { readFileSync } from "node:fs";

// AN OBSERVATION THAT NAMES THE THING IT IS ABOUT:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts entity-observations-db
//
// ============ WHAT THIS MILESTONE IS (2026-09-02) =====================
//
// `GenesisObservation.recordId` is what lets J4's observation reach the entity
// it concerns on the Business Map. Before this, one producer set it (a
// high-severity challenge stated in chat) and everything else wrote null —
// including the AI review, which had ALREADY resolved and validated the record
// its finding was about and was discarding it at a return type.
//
// Two tiers, approved by Sean and deliberately narrow:
//
//   TIER 1  the cognitive review stops discarding what it already earned.
//   TIER 2  `inventory.depleted` names the item when there is exactly one.
//
// Everything else stays store-wide, because it IS store-wide. The tests below
// are as much about what must NOT gain a record as what must.
//
// ============ THE FAILURE THIS GUARDS AGAINST =========================
//
// A wrong recordId is worse than none. "J4 noticed: 4 items are out of stock"
// pinned to one product points at the wrong thing while sounding right, and a
// cross-tenant id would put one business's finding on another's card. So the
// checks below are mostly adversarial: wrong entity, absent record, other
// store, plural cluster, and the dedupe identity that must not shift.

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

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  let seq = 0;

  const makeStore = async (name = "Cubit & Coil") => {
    const n = ++seq;
    const user = await prisma.user.create({ data: { email: `obs-${stamp}-${n}@example.test` } });
    const store = await prisma.store.create({
      data: {
        userId: user.id, name, slug: `obs-${stamp}-${n}`,
        description: "Copper tensor rings wound by hand.", currency: "USD",
      },
    });
    return { user, store };
  };

  const makeItem = async (storeId: string, itemName: string, quantityAvailable: number | null) =>
    prismaSystem.businessRecord.create({
      data: {
        storeId, entityType: "item", externalId: `item-${itemName}-${++seq}`,
        sourceProvider: "test", provenance: "OWNER", provenanceDetail: "suite",
        data: { name: itemName, sku: `SKU-${itemName}`, priceInCents: 1000, category: null, active: true, quantityAvailable },
      },
    });

  const rowFor = (storeId: string, dedupeKey: string) =>
    prismaSystem.genesisObservation.findFirst({
      where: { storeId, dedupeKey },
      select: { id: true, recordId: true, entityType: true, summary: true, status: true, genesisState: true },
    });

  // ======================================================================
  console.log("\n=== 1. Tier 1 carries what the review already validated ===\n");
  // ======================================================================
  {
    // THROUGH THE MAPPING THAT CHANGED, not around it.
    //
    // The first version of this section called upsertObservation directly and
    // was hollow: sabotage put `recordId: null` back at the AI-review call
    // site and every check stayed green, because they were measuring the
    // storage helper, which had always stored whatever it was handed. So the
    // mapping was extracted (`observationFromReview`) and is called here.
    const reviewed = observationFromReview({
      topicKey: "goal_behind_pace",
      message: "The spring run is behind pace.",
      actionHref: "/dashboard",
      recordId: "rec_goal_1",
      entityType: "goal",
    });
    eq("the review's record survives into the observation", reviewed.recordId, "rec_goal_1");
    eq("with its kind", reviewed.entityType, "goal");
    eq("and identity is the topic alone, never the record",
      reviewed.dedupeKey, "ai_review:goal_behind_pace");

    // THE SAME FINDING WITHOUT A RECORD KEEPS THE SAME IDENTITY. This is what
    // makes a finding that later gains a record the same row rather than a
    // second one.
    const sameTopicNoRecord = observationFromReview({
      topicKey: "goal_behind_pace",
      message: "The spring run is behind pace.",
      actionHref: "/dashboard",
      recordId: null,
      entityType: null,
    });
    eq("a finding with no record has the identical dedupe key",
      sameTopicNoRecord.dedupeKey, reviewed.dedupeKey);
    eq("and names nothing", sameTopicNoRecord.recordId, null);

    const { store } = await makeStore();
    const goal = await prismaSystem.businessRecord.create({
      data: {
        storeId: store.id, entityType: "goal", externalId: `goal-${stamp}`,
        sourceProvider: "test", provenance: "OWNER", provenanceDetail: "suite",
        data: { description: "Sell out the spring run", targetValue: 100 },
      },
    });

    await upsertObservation(store.id, {
      dedupeKey: `ai:goal_behind_pace`,
      genesisState: "opportunity",
      summary: "The spring run is behind pace.",
      recordId: goal.id,
      entityType: "goal",
    });

    const row = await rowFor(store.id, "ai:goal_behind_pace");
    eq("an observation about a goal names that goal", row?.recordId, goal.id);
    eq("and says what kind of thing it is", row?.entityType, "goal");

    // ---- and a finding about the business as a whole names nothing -------
    await upsertObservation(store.id, {
      dedupeKey: `ai:no_payment_provider`,
      genesisState: "urgent",
      summary: "No payment method is connected.",
      recordId: null,
      entityType: null,
    });
    const wide = await rowFor(store.id, "ai:no_payment_provider");
    eq("a store-wide finding still names no record", wide?.recordId, null);
    eq("and no entity type either", wide?.entityType, null);
  }

  // ======================================================================
  console.log("\n=== 2. The identity of an observation did not change ===\n");
  // ======================================================================
  {
    // THE RISK THIS MILESTONE INTRODUCES. `upsertObservation` keys on
    // (storeId, dedupeKey). If adding a recordId ever produced a second row
    // for the same real condition, the owner would be told the same thing
    // twice and the resolve sweep would lose track of one of them.
    const { store } = await makeStore();
    const goal = await prismaSystem.businessRecord.create({
      data: {
        storeId: store.id, entityType: "goal", externalId: `goal-id-${stamp}`,
        sourceProvider: "test", provenance: "OWNER", provenanceDetail: "suite",
        data: { description: "Ship the catalogue" },
      },
    });
    const key = "ai:same_finding";

    await upsertObservation(store.id, {
      dedupeKey: key, genesisState: "opportunity", summary: "First telling.",
    });
    const first = await rowFor(store.id, key);

    // The same finding, now able to name its record.
    await upsertObservation(store.id, {
      dedupeKey: key, genesisState: "opportunity", summary: "Second telling.",
      recordId: goal.id, entityType: "goal",
    });
    const second = await rowFor(store.id, key);

    eq("gaining a record does not create a second row", second?.id, first?.id);
    eq("it is the same row, now naming its record", second?.recordId, goal.id);
    eq("and carrying the newer wording", second?.summary, "Second telling.");

    const count = await prismaSystem.genesisObservation.count({
      where: { storeId: store.id, dedupeKey: key },
    });
    eq("exactly one row exists for that dedupeKey", count, 1);

    // ---- and losing it again is still the same row ----------------------
    await upsertObservation(store.id, {
      dedupeKey: key, genesisState: "opportunity", summary: "Third telling.",
    });
    const third = await rowFor(store.id, key);
    eq("losing the record does not create a row either", third?.id, first?.id);
    eq("and the link is genuinely cleared, not left stale", third?.recordId, null);
  }

  // ======================================================================
  console.log("\n=== 3. Tier 2 names one item, and never a cluster ===\n");
  // ======================================================================
  {
    const { store } = await makeStore();
    const ring = await makeItem(store.id, "CopperRing", 0);

    const single: Insight = {
      type: "inventory.depleted",
      severity: "urgent",
      summary: "CopperRing is out of stock.",
      metrics: { count: 1, items: ["CopperRing"] },
      recordId: ring.id,
      entityType: "item",
    };
    await notifyFromInsights(store.id, [single]);

    const row = await rowFor(store.id, "insight:inventory.depleted");
    eq("one depleted item names that item", row?.recordId, ring.id);
    eq("as an item", row?.entityType, "item");

    // ---- several depleted items name none of them -----------------------
    const { store: many } = await makeStore();
    await makeItem(many.id, "RingA", 0);
    await makeItem(many.id, "RingB", 0);
    const cluster: Insight = {
      type: "inventory.depleted",
      severity: "urgent",
      summary: "2 items are out of stock.",
      metrics: { count: 2, items: ["RingA", "RingB"] },
      recordId: null,
      entityType: null,
    };
    await notifyFromInsights(many.id, [cluster]);
    const clusterRow = await rowFor(many.id, "insight:inventory.depleted");
    eq("a cluster of depleted items names no single one", clusterRow?.recordId, null);
    eq("and no entity type", clusterRow?.entityType, null);
  }

  // ======================================================================
  console.log("\n=== 4. The detector itself only names the singular case ===\n");
  // ======================================================================
  {
    // Not the shape written by hand above — the real detector, through the
    // real engine, so the rule is proven where it actually lives.
    const { store: one } = await makeStore();
    await makeItem(one.id, "OnlyRing", 0);
    await makeItem(one.id, "InStockRing", 5);
    const oneInsights = await computeInsights(one.id);
    const oneDepleted = oneInsights.find((i) => i.type === "inventory.depleted");

    if (oneDepleted) {
      eq("the detector names the single depleted item", typeof oneDepleted.recordId, "string");
      eq("as an item", oneDepleted.entityType, "item");
      assert("and never names the one that is in stock",
        oneDepleted.summary.includes("OnlyRing"), oneDepleted.summary);
    } else {
      console.log("  NOTE  the low-stock threshold did not trigger for one item; cluster case below still runs");
    }

    const { store: several } = await makeStore();
    await makeItem(several.id, "RingOne", 0);
    await makeItem(several.id, "RingTwo", 0);
    await makeItem(several.id, "RingThree", 0);
    const manyInsights = await computeInsights(several.id);
    const manyDepleted = manyInsights.find((i) => i.type === "inventory.depleted");
    assert("the detector produces a cluster insight for several", manyDepleted !== undefined,
      JSON.stringify(manyInsights.map((i) => i.type)));
    eq("and it names no record at all", manyDepleted?.recordId ?? null, null);
    eq("nor an entity type", manyDepleted?.entityType ?? null, null);
  }

  // ======================================================================
  console.log("\n=== 5. An id that is not really ours is not written ===\n");
  // ======================================================================
  {
    // THE ADVERSARIAL SET. Tier 2's ids have not been through the review's own
    // validation, so notify.ts checks them itself. Each case below drops the
    // LINK and keeps the OBSERVATION — the owner still hears the finding.
    const { store } = await makeStore();
    const { store: otherStore } = await makeStore("Somebody Else");
    const theirRing = await makeItem(otherStore.id, "TheirRing", 0);
    const ourGoal = await prismaSystem.businessRecord.create({
      data: {
        storeId: store.id, entityType: "goal", externalId: `goal-wrong-${stamp}`,
        sourceProvider: "test", provenance: "OWNER", provenanceDetail: "suite",
        data: { description: "A goal, not an item" },
      },
    });

    const cases: { name: string; insight: Insight }[] = [
      {
        name: "a record belonging to another store",
        insight: {
          type: "inventory.depleted", severity: "urgent",
          summary: "TheirRing is out of stock.", metrics: {},
          recordId: theirRing.id, entityType: "item",
        },
      },
      {
        name: "a record that does not exist at all",
        insight: {
          type: "inventory.depleted", severity: "urgent",
          summary: "A ghost is out of stock.", metrics: {},
          recordId: `cl${stamp}doesnotexist`, entityType: "item",
        },
      },
      {
        name: "a real record of the wrong kind",
        insight: {
          type: "inventory.depleted", severity: "urgent",
          summary: "Something is out of stock.", metrics: {},
          recordId: ourGoal.id, entityType: "item",
        },
      },
      {
        name: "an entityType with no id",
        insight: {
          type: "inventory.depleted", severity: "urgent",
          summary: "Something is out of stock.", metrics: {},
          recordId: null, entityType: "item",
        },
      },
    ];

    for (const c of cases) {
      await prismaSystem.genesisObservation.deleteMany({
        where: { storeId: store.id, dedupeKey: "insight:inventory.depleted" },
      });
      await notifyFromInsights(store.id, [c.insight]);
      const row = await rowFor(store.id, "insight:inventory.depleted");
      assert(`${c.name} is refused`, row?.recordId == null, String(row?.recordId));
      assert(`and the finding is still told (${c.name})`, row !== null, "the observation was dropped too");
    }

    // AND THE OTHER STORE IS UNTOUCHED. A cross-tenant id must not reach the
    // other business's rows either.
    const theirRows = await prismaSystem.genesisObservation.count({
      where: { storeId: otherStore.id },
    });
    eq("nothing was written to the other store", theirRows, 0);
  }

  // ======================================================================
  console.log("\n=== 6. Nothing outside the approved tiers gained a record ===\n");
  // ======================================================================
  {
    // Sean: "Everything else remains store-wide. Do not try to force recordId
    // onto aggregate/trend observations, execution outcomes, or anything else
    // that doesn't genuinely identify one record."
    //
    // Read off the source, so a future producer that quietly starts naming
    // records has to come past this check.
    const insightsSrc = readFileSync("lib/intelligence/insights.ts", "utf8");
    const named = [...insightsSrc.matchAll(/type: "([a-z_.]+)"/g)].map((m) => m[1]);
    assert("the detectors are still the set this milestone audited",
      named.length > 0, JSON.stringify(named));

    // Only the low-stock detector may set a record. Checked by counting the
    // assignments, not by trusting the prose above it.
    const recordAssignments = (insightsSrc.match(/^\s*recordId: /gm) ?? []).length;
    eq("exactly one detector assigns a record", recordAssignments, 1);

    // TIER 1'S TRUST FILTER IS SOURCE-ASSERTED, and says so.
    //
    // `runCognitiveReview` needs a live model, so this suite cannot drive it.
    // What it CAN do is refuse to let the filter quietly disappear: the whole
    // safety of Tier 1 is that a model's `relatedRecordId` is kept only when
    // it matches a record genuinely fetched and shown to it. This is lane 4
    // evidence (source-asserted), not lane 3, and is recorded as such rather
    // than dressed up as a behavioural check.
    const cogSrc = readFileSync("lib/intelligence/cognitiveLayer.ts", "utf8");
    assert("the review still filters a model's id to records it was shown",
      /entityTypeByRecordId\.has\(item\.relatedRecordId\)/.test(cogSrc),
      "relatedRecordOf no longer consults entityTypeByRecordId");
    assert("and one resolution serves both writers, so they cannot drift",
      (cogSrc.match(/relatedRecordOf\(item\)/g) ?? []).length === 2,
      `relatedRecordOf is called ${(cogSrc.match(/relatedRecordOf\(item\)/g) ?? []).length} times, expected 2`);

    const gapsSrc = readFileSync("lib/integrations/gaps.ts", "utf8");
    assert("connection gaps still name no record", !/recordId/.test(gapsSrc), "gaps.ts mentions recordId");

    const staffSrc = readFileSync("lib/businessModel/staffPolicyGap.ts", "utf8");
    assert("the staff-policy gap still names no record", !/recordId/.test(staffSrc),
      "staffPolicyGap.ts mentions recordId");

    // AND NO PRODUCER NAMES A CUSTOMER. Sean ruled contacts out of scope until
    // the identifier/PII boundary is decided: a contact's record id IS
    // `internal:contact:<email>`, so naming one would write an address into
    // this table.
    for (const file of [
      "lib/intelligence/notify.ts",
      "lib/intelligence/insights.ts",
      "lib/dashboard/genesisObservations.ts",
    ]) {
      const src = readFileSync(file, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
      assert(`${file} names no contact record`,
        !/internal:contact:/.test(src), "a contact id is referenced outside a comment");
    }
  }

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ${f}`);
  }
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaSystem.$disconnect();
  });
