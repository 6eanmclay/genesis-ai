import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// J4 FINALLY LOOKS AT THE ORDERS (2026-09-13).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-commerce-conditions.ts" -OutFile out.txt
//
// ============ WHAT THIS PROVES =======================================
//
// The Commerce producer writes real GenesisObservations, through the existing
// upsert/resolve lifecycle, that reach the owner through the shared attention
// layer — with ONE row per condition per store no matter how many orders make
// it true.
//
// Everything is exercised against real rows written to a real database. The
// conditions are read back as observations, not as the return value of the
// function that produced them.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const DAY = 86_400_000;

async function main(): Promise<void> {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  // BEFORE ANY PRODUCT MODULE LOADS. lib/prisma builds its adapter from
  // DATABASE_URL at module-evaluation time, so the producer under test would
  // otherwise reach for the repo .env database instead of this one — which is
  // exactly how a script ends up pointed at something real. Same pattern
  // measure-office-assembly established.
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  // TWO CLIENTS, FOR TWO JOBS. `prisma` is tenant-guarded and refuses any
  // query without a store scope — which is exactly right for the producer and
  // exactly wrong for seeding, where creating the User and Store is by
  // definition unscoped. `prismaSystem` is the unguarded one the guard itself
  // documents. The producer under test still runs through the guarded client,
  // so its own store-scoping is being enforced while these assertions run.
  const { prisma, prismaSystem } = await import("@/lib/prisma");
  const {
    getCommerceConditions, proposeCommerceConditions,
    COMMERCE_CONDITION_PREFIX, STALE_FULFILMENT_DAYS,
  } = await import("@/lib/commerce/conditions");
  const { classifyAttentionRows } = await import("@/lib/attention/state");
  const { observationRef } = await import("@/lib/attention/identity");

  try {
    const stamp = Date.now();
    const now = new Date();
    const user = await prismaSystem.user.create({
      data: { email: `commerce-${stamp}@example.test`, name: "Sean McLay", password: "x" },
    });
    const shop = await prismaSystem.store.create({
      data: { userId: user.id, name: "Cubit & Coil", slug: `commerce-a-${stamp}`, currency: "USD" },
    });
    const other = await prismaSystem.store.create({
      data: { userId: user.id, name: "Other Shop", slug: `commerce-b-${stamp}`, currency: "USD" },
    });

    const order = async (storeId: string, o: {
      ageDays: number; fulfillment?: string; tracking?: string | null;
      confirmed?: boolean; status?: string;
    }) =>
      prismaSystem.order.create({
        data: {
          storeId,
          productName: "Copper saucepan",
          amountInCents: 4200,
          buyerEmail: `buyer-${Math.random().toString(36).slice(2)}@example.test`,
          status: o.status ?? "paid",
          paymentProvider: "STRIPE",
          externalOrderId: `ext-${Math.random().toString(36).slice(2)}`,
          fulfillmentStatus: o.fulfillment ?? "unfulfilled",
          trackingNumber: o.tracking ?? null,
          confirmationSentAt: o.confirmed ? new Date(now.getTime() - o.ageDays * DAY) : null,
          createdAt: new Date(now.getTime() - o.ageDays * DAY),
        },
      });

    const observations = (storeId: string) =>
      prismaSystem.genesisObservation.findMany({
        where: { storeId, dedupeKey: { startsWith: COMMERCE_CONDITION_PREFIX } },
        orderBy: { dedupeKey: "asc" },
      });
    const active = async (storeId: string) => (await observations(storeId)).filter((o) => o.status === "ACTIVE");

    // ==================================================================
    console.log("\n=== 1. A stale order is raised; a young one is not ===\n");
    // ==================================================================
    const staleOrder = await order(shop.id, { ageDays: 41, confirmed: true });
    const youngOrder = await order(shop.id, { ageDays: 3, confirmed: true });
    await proposeCommerceConditions(shop.id, now);

    let rows = await active(shop.id);
    const staleRow = rows.find((r) => r.dedupeKey.endsWith("orders_unfulfilled_stale"));
    check("a 41-day unfulfilled order raises the condition", !!staleRow,
      rows.map((r) => r.dedupeKey).join(" ") || "nothing raised");
    check("  and the sentence carries the evidence",
      staleRow?.summary.includes("1 order has") === true && staleRow?.summary.includes("41 days") === true,
      staleRow?.summary ?? "");
    check("  it is urgent", staleRow?.genesisState === "urgent", `${staleRow?.genesisState}`);

    // THE YOUNG ONE IS INVISIBLE. Both orders are unfulfilled; only one is a
    // problem, and the condition must be able to tell them apart.
    const conditions = await getCommerceConditions(shop.id, now);
    const staleCondition = conditions.find((c) => c.key === "orders_unfulfilled_stale");
    check("the 3-day order is not part of it",
      staleCondition?.orderIds.length === 1 && staleCondition.orderIds[0] === staleOrder.id,
      `${staleCondition?.orderIds.length} order(s) in evidence`);
    check(`  the threshold is ${STALE_FULFILMENT_DAYS} days, named once`,
      STALE_FULFILMENT_DAYS === 14);

    // AND WITH ONLY YOUNG WORK, NOTHING IS SAID AT ALL.
    await prismaSystem.order.update({ where: { id: staleOrder.id }, data: { fulfillmentStatus: "fulfilled", trackingNumber: "TRK1" } });
    await proposeCommerceConditions(shop.id, now);
    check("once it is fulfilled and tracked the condition resolves",
      !(await active(shop.id)).some((r) => r.dedupeKey.endsWith("orders_unfulfilled_stale")),
      (await active(shop.id)).map((r) => r.dedupeKey).join(" ") || "nothing active");
    check("  and the row is RESOLVED, not deleted",
      (await observations(shop.id)).some((r) => r.dedupeKey.endsWith("orders_unfulfilled_stale") && r.status === "RESOLVED"));

    // ==================================================================
    console.log("\n=== 2. Shipped with nothing to follow ===\n");
    // ==================================================================
    await prismaSystem.order.update({ where: { id: youngOrder.id }, data: { fulfillmentStatus: "fulfilled", trackingNumber: null } });
    await proposeCommerceConditions(shop.id, now);
    const untracked = (await active(shop.id)).find((r) => r.dedupeKey.endsWith("orders_shipped_untracked"));
    check("a fulfilled order with no tracking raises the condition", !!untracked, untracked?.summary ?? "");
    check("  and says why it matters to the buyer",
      untracked?.summary.includes("no way to follow") === true, untracked?.summary ?? "");

    await prismaSystem.order.update({ where: { id: youngOrder.id }, data: { trackingNumber: "TRK2" } });
    await proposeCommerceConditions(shop.id, now);
    check("  adding tracking resolves it",
      !(await active(shop.id)).some((r) => r.dedupeKey.endsWith("orders_shipped_untracked")));

    // ==================================================================
    console.log("\n=== 3. Receipts aggregate, never one per order ===\n");
    // ==================================================================
    const unsent = [];
    for (const age of [55, 30, 12, 6, 2, 0]) unsent.push(await order(shop.id, { ageDays: age, fulfillment: "fulfilled", tracking: "T" }));
    await proposeCommerceConditions(shop.id, now);

    const receiptRows = (await active(shop.id)).filter((r) => r.dedupeKey.endsWith("receipts_unsent"));
    check("six receiptless orders produce exactly ONE observation",
      receiptRows.length === 1, `${receiptRows.length} rows for ${unsent.length} orders`);
    check("  which counts them",
      receiptRows[0]?.summary.includes("6 buyers have") === true, receiptRows[0]?.summary ?? "");
    check("  and names the earliest",
      receiptRows[0]?.summary.includes("55 days") === true, receiptRows[0]?.summary ?? "");
    check("  the dedupeKey carries no order id",
      receiptRows[0]?.dedupeKey === `${COMMERCE_CONDITION_PREFIX}receipts_unsent`,
      receiptRows[0]?.dedupeKey ?? "");
    const receiptCondition = (await getCommerceConditions(shop.id, now)).find((c) => c.key === "receipts_unsent");
    check("  while the evidence still names every contributing order",
      receiptCondition?.orderIds.length === 6, `${receiptCondition?.orderIds.length}`);

    // A FACT, AND SEPARATELY A REASON. The test environment has no email
    // provider, so the blocked sentence must be present AND must not claim a
    // send was attempted.
    check("it states the fact without claiming a send failed",
      receiptRows[0]?.summary.includes("not been sent") === true &&
        !/failed|error|bounced|rejected/i.test(receiptRows[0]?.summary ?? ""),
      receiptRows[0]?.summary ?? "");
    check("  and names the missing capability separately",
      receiptRows[0]?.summary.includes("no email provider is connected") === true,
      "the reason it cannot be resolved, not a claim about any order");

    // ==================================================================
    console.log("\n=== 4. A broken payment connection, and only a real one ===\n");
    // ==================================================================
    const disconnected = await prismaSystem.storeIntegration.create({
      data: { storeId: shop.id, provider: "PAYPAL", status: "DISCONNECTED" },
    });
    await proposeCommerceConditions(shop.id, now);
    check("a DISCONNECTED provider is NOT a broken connection",
      !(await active(shop.id)).some((r) => r.dedupeKey.endsWith("payment_connection_broken")),
      "absence of a connection is not evidence of failure");

    await prismaSystem.storeIntegration.create({
      data: { storeId: shop.id, provider: "STRIPE", status: "FAILED" },
    });
    await proposeCommerceConditions(shop.id, now);
    const brokenRow = (await active(shop.id)).find((r) => r.dedupeKey.endsWith("payment_connection_broken"));
    check("a FAILED Stripe connection raises the condition", !!brokenRow, brokenRow?.summary ?? "");
    check("  and names the provider", brokenRow?.summary.includes("Stripe") === true, brokenRow?.summary ?? "");

    await prismaSystem.storeIntegration.updateMany({
      where: { storeId: shop.id, provider: "STRIPE" }, data: { status: "CONNECTED" },
    });
    await proposeCommerceConditions(shop.id, now);
    check("  reconnecting resolves it",
      !(await active(shop.id)).some((r) => r.dedupeKey.endsWith("payment_connection_broken")));

    // ==================================================================
    console.log("\n=== 5. Repeated sweeps update, never duplicate ===\n");
    // ==================================================================
    const beforeSweeps = await observations(shop.id);
    for (let i = 0; i < 3; i++) await proposeCommerceConditions(shop.id, now);
    const afterSweeps = await observations(shop.id);
    check("three more sweeps add no rows",
      afterSweeps.length === beforeSweeps.length, `${beforeSweeps.length} -> ${afterSweeps.length}`);
    check("  and every row keeps its identity",
      JSON.stringify(afterSweeps.map((r) => r.id).sort()) === JSON.stringify(beforeSweeps.map((r) => r.id).sort()),
      "same GenesisObservation.id — the identity contract from f762d05");

    // A CONDITION THAT GOES AWAY AND COMES BACK KEEPS ITS ROW. The identity
    // contract depends on this: upsert reactivates rather than spawning.
    const receiptId = (await active(shop.id)).find((r) => r.dedupeKey.endsWith("receipts_unsent"))!.id;
    await prismaSystem.order.updateMany({ where: { storeId: shop.id }, data: { confirmationSentAt: new Date() } });
    await proposeCommerceConditions(shop.id, now);
    check("sending the receipts resolves the condition",
      !(await active(shop.id)).some((r) => r.dedupeKey.endsWith("receipts_unsent")));
    await order(shop.id, { ageDays: 1, fulfillment: "fulfilled", tracking: "T" });
    await proposeCommerceConditions(shop.id, now);
    const revived = (await active(shop.id)).find((r) => r.dedupeKey.endsWith("receipts_unsent"));
    check("  and a new receiptless order revives the SAME row",
      revived?.id === receiptId, `${revived?.id === receiptId ? "same id" : "A NEW ROW WAS CREATED"}`);

    // ==================================================================
    console.log("\n=== 6. Two stores never see each other's conditions ===\n");
    // ==================================================================
    await order(other.id, { ageDays: 60, confirmed: true });
    await proposeCommerceConditions(other.id, now);
    const otherRows = await active(other.id);
    const shopRows = await active(shop.id);
    check("the other store raises its own stale condition",
      otherRows.some((r) => r.dedupeKey.endsWith("orders_unfulfilled_stale")),
      otherRows.map((r) => r.dedupeKey).join(" ") || "none");
    check("  with its own row id",
      !shopRows.some((r) => otherRows.some((o) => o.id === r.id)));
    check("  and this store's conditions are untouched by that sweep",
      shopRows.some((r) => r.dedupeKey.endsWith("receipts_unsent")),
      "a sweep of one business must not resolve another's rows");

    // ==================================================================
    console.log("\n=== 7. They reach the shared attention layer ===\n");
    // ==================================================================
    //
    // The point of the whole slice: these are not a Commerce notion. They are
    // observations, so they are deferrable by canonical identity exactly like
    // every other one — proven by putting one through the real classifier.
    const item = (await active(shop.id))[0];
    const ref = observationRef(item.id);
    check("a Commerce observation has a canonical attention identity",
      ref.source === "observation" && ref.id === item.id, `${ref.source}/${ref.id.slice(0, 8)}…`);

    await prismaSystem.dismissedAttentionCard.create({
      data: {
        storeId: shop.id,
        cardId: `observation:${item.dedupeKey}`,
        source: ref.source,
        sourceId: ref.id,
      },
    });
    const state = classifyAttentionRows(
      await prismaSystem.dismissedAttentionCard.findMany({
        where: { storeId: shop.id },
        select: { cardId: true, source: true, sourceId: true, dismissedAt: true },
      }),
    );
    check("  and can be set aside through the shared state",
      state.deferrals.some((d) => d.source === "observation" && d.sourceId === item.id),
      `${state.deferrals.length} deferral(s), ${state.legacyCardIds.size} legacy`);
    check("  with no legacy fallback involved",
      state.legacyCardIds.size === 0,
      "it entered as a canonical item, not as a presentation id");

    // ==================================================================
    console.log("\n=== Sabotage guards ===\n");
    // ==================================================================
    const src = readFileSync(join(process.cwd(), "lib", "commerce", "conditions.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    check("no dedupeKey is built from an order id",
      !/dedupeKey[^\n]*\$\{[^}]*(order|\.id)/i.test(src),
      "one condition per store, however many orders make it true");
    check("every write goes through the shared observation lifecycle",
      /upsertObservation\(/.test(src) && /resolveMissingObservations\(/.test(src) &&
        !/genesisObservation\.(create|update|delete)/.test(src),
      "no direct row writes — the lifecycle is the product's, not this file's");
    check("resolution is scoped to this namespace",
      /COMMERCE_CONDITION_PREFIX,?\s*\n?\s*\)/.test(src) || /COMMERCE_CONDITION_PREFIX\s*,/.test(src),
      "a sweep may never resolve another producer's rows");
    check("every query is scoped to one store",
      (src.match(/where: \{ storeId/g) ?? []).length >= 2,
      "no cross-business read");
    check("no new attention source or taxonomy is introduced",
      !/AttentionSource|ATTENTION_SOURCES|attentionRefOf/.test(src),
      "these are observations; the attention layer is untouched");
    check("missing tracking is never treated as proof of a shipment",
      /trackingNumber === null/.test(src) && !/shipmentStatus/.test(src),
      "shipmentStatus is NULL on every order in production — reading it would invent a state");
    check("the stale threshold is a named constant, not an inline number",
      /STALE_FULFILMENT_DAYS/.test(src) && !/>= 14|14 \* 86/.test(src));

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
    if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
    await prismaSystem.$disconnect();
    await db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
