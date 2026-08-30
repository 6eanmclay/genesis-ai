import "@/scripts/lib/allowServerOnly";

import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { handleDisputeEvent, nextStatus, isDisputeEvent, DISPUTE_EVENT_TYPES } from "@/lib/payments/stripeDispute";
import {
  ORDER_STATUS, ORDER_STATUSES, isMoneyGoneForGood, countsAsRevenue,
  isMoneyReversed, isInquiryOnly, refusalReason,
} from "@/lib/orders/orderStatus";
import { stageOf, STAGE_LABEL } from "@/lib/carriage/lifecycle";
import { mapOrdersToTransactions } from "@/lib/businessModel/internalMapper";
import type Stripe from "stripe";
import { readFileSync } from "node:fs";

// DISPUTES, AND THE ORDER LIFECYCLE THEY BELONG TO:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts order-disputes-db
//
// ============ WHAT WAS HAPPENING BEFORE (2026-08-30) ==================
//
// A chargeback reached this platform, was verified, recorded verbatim, matched
// no branch, answered 200 and was marked PROCESSED. The order stayed "paid",
// reporting counted it as a sale, and the owner could buy a shipping label and
// post the goods for money the bank had already taken back.
//
// ============ THE ONE DISTINCTION EVERYTHING RESTS ON =================
//
// Sean, 2026-08-30: "A warning/inquiry does not mean money moved;
// funds_withdrawn and funds_reinstated are the financial transitions."
//
// So the central assertion here is NOT that a dispute changes the order. It is
// that an INQUIRY DOES NOT — and that only positive evidence of funds moving
// touches the money axis. Getting that backwards reports losses that never
// happened, which is its own kind of lying about money.
//
// ============ AND THE DECISION THAT LOOKS LIKE A BUG ==================
//
// A disputed order stays fulfillable. Sean: "Disputed orders remain
// fulfillable. Surface a clear warning/risk state, but do not block shipping."
// Shipping and proving delivery is how a merchant WINS a dispute. Refunded and
// charged-back orders keep the protection, because that money is not coming
// back and posting goods is a second loss.

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

let clock = Math.floor(Date.now() / 1000);

/** A Stripe dispute event, shaped as Stripe sends it. */
function disputeEvent(
  type: (typeof DISPUTE_EVENT_TYPES)[number],
  over: { id: string; paymentIntent?: string; status: string; amount?: number; reason?: string },
): Stripe.Event {
  clock += 60;
  return {
    id: `evt_${over.id}_${type}`,
    object: "event",
    api_version: "2024-06-20",
    created: clock,
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type,
    data: {
      object: {
        id: over.id,
        object: "dispute",
        amount: over.amount ?? 4500,
        charge: `ch_${over.id}`,
        payment_intent: over.paymentIntent ?? null,
        reason: over.reason ?? "fraudulent",
        status: over.status,
        currency: "usd",
      } as unknown as Stripe.Dispute,
    },
  } as unknown as Stripe.Event;
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  const owner = await prisma.user.create({ data: { email: `dp-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "DP", slug: `dp-${stamp}`, tagline: "t", description: "d" },
  });

  let n = 0;
  const makeOrder = async (over: Record<string, unknown> = {}) => {
    n += 1;
    return prisma.order.create({
      data: {
        storeId: store.id, productName: "A thing", quantity: 1, amountInCents: 4500,
        buyerEmail: `buyer-${n}-${stamp}@example.test`,
        paymentProvider: "STRIPE",
        externalOrderId: `cs_${n}_${stamp}`,
        externalPaymentId: `pi_${n}_${stamp}`,
        ...over,
      },
    });
  };

  console.log("\n--- the vocabulary is closed and owned in one place ---\n");
  {
    eq("there are exactly four money states", ORDER_STATUSES.sort(),
      ["charged_back", "disputed", "paid", "refunded"]);
    eq("a new order is paid", (await makeOrder()).status, ORDER_STATUS.PAID);

    // Every one of the five events is recognised, and nothing else is.
    for (const type of DISPUTE_EVENT_TYPES) assert(`${type} is a dispute event`, isDisputeEvent(type));
    for (const type of ["charge.refunded", "checkout.session.completed", "charge.dispute"]) {
      assert(`${type} is not`, !isDisputeEvent(type));
    }
    eq("all five are handled", DISPUTE_EVENT_TYPES.length, 5);
  }

  console.log("\n--- the money rule, without a database or Stripe ---\n");
  {
    // ============ THE PURE HEART OF THE FEATURE ==================
    //
    // Every ambiguous thing about disputes is decided here, so it is proven
    // here, exhaustively, before anything writes a row.
    const P = ORDER_STATUS.PAID, D = ORDER_STATUS.DISPUTED, C = ORDER_STATUS.CHARGED_BACK, R = ORDER_STATUS.REFUNDED;

    // An inquiry moves nothing, whatever it says.
    for (const status of ["warning_needs_response", "warning_under_review"]) {
      eq(`created (${status}) leaves the money alone`,
        nextStatus({ current: P, eventType: "charge.dispute.created", disputeStatus: status, fundsWithdrawn: false }), P);
    }
    // NOR DOES A REAL DISPUTE, UNTIL THE FUNDS EVENT. The claim existing is not
    // the money moving, and this is the line the whole design rests on.
    eq("created (needs_response) still leaves the money alone",
      nextStatus({ current: P, eventType: "charge.dispute.created", disputeStatus: "needs_response", fundsWithdrawn: false }), P);
    eq("updated leaves the money alone",
      nextStatus({ current: P, eventType: "charge.dispute.updated", disputeStatus: "under_review", fundsWithdrawn: false }), P);

    // Only these two move it.
    eq("funds_withdrawn takes the money",
      nextStatus({ current: P, eventType: "charge.dispute.funds_withdrawn", disputeStatus: "needs_response", fundsWithdrawn: false }), D);
    eq("funds_reinstated gives it back",
      nextStatus({ current: D, eventType: "charge.dispute.funds_reinstated", disputeStatus: "won", fundsWithdrawn: true }), P);

    // A verdict only matters if money actually left.
    eq("lost, with funds withdrawn, is a charge-back",
      nextStatus({ current: D, eventType: "charge.dispute.closed", disputeStatus: "lost", fundsWithdrawn: true }), C);
    eq("lost, with NO funds withdrawn, invents no loss",
      nextStatus({ current: P, eventType: "charge.dispute.closed", disputeStatus: "lost", fundsWithdrawn: false }), P);
    eq("won leaves whatever the funds events decided",
      nextStatus({ current: P, eventType: "charge.dispute.closed", disputeStatus: "won", fundsWithdrawn: false }), P);
    eq("warning_closed is not a loss",
      nextStatus({ current: P, eventType: "charge.dispute.closed", disputeStatus: "warning_closed", fundsWithdrawn: false }), P);

    // A refund outranks every dispute event there is.
    for (const type of DISPUTE_EVENT_TYPES) {
      eq(`a refunded order stays refunded through ${type}`,
        nextStatus({ current: R, eventType: type, disputeStatus: "lost", fundsWithdrawn: true }), R);
    }
  }

  console.log("\n--- 1. the full lifecycle of a dispute that is lost ---\n");
  {
    const order = await makeOrder();
    const id = `dp_lost_${stamp}`;

    // created: a claim exists, no money has moved.
    await handleDisputeEvent(disputeEvent("charge.dispute.created", {
      id, paymentIntent: order.externalPaymentId!, status: "needs_response", reason: "product_not_received",
    }));
    let row = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    eq("after created the money is untouched", row.status, ORDER_STATUS.PAID);
    eq("but the claim is recorded", row.disputeStatus, "needs_response");
    eq("with the network's own reason", row.disputeReason, "product_not_received");
    eq("and the amount claimed", row.disputeAmountInCents, 4500);
    assert("and when it began", !!row.disputedAt);
    eq("the claim id is remembered", row.externalDisputeId, id);
    eq("and no funds have moved", row.disputeFundsWithdrawnAt, null);

    // funds_withdrawn: NOW the money is gone.
    await handleDisputeEvent(disputeEvent("charge.dispute.funds_withdrawn", { id, status: "needs_response" }));
    row = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    eq("funds_withdrawn moves the money axis", row.status, ORDER_STATUS.DISPUTED);
    assert("and records that funds left", !!row.disputeFundsWithdrawnAt);

    // updated: evidence submitted. Money unchanged.
    await handleDisputeEvent(disputeEvent("charge.dispute.updated", { id, status: "under_review" }));
    row = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    eq("an update does not move the money", row.status, ORDER_STATUS.DISPUTED);
    eq("but does move the claim", row.disputeStatus, "under_review");

    // ============ WHEN THE CLAIM BEGAN IS FIXED (2026-08-30) ======
    //
    // Captured before the later events, because sabotage proved the redelivery
    // test could not see this: redelivering the SAME event carries the same
    // timestamp, so an unconditional `disputedAt: now` looked identical. Only a
    // genuinely later event can show the difference.
    const began = row.disputedAt!.toISOString();

    // closed lost: the money is gone for good.
    await handleDisputeEvent(disputeEvent("charge.dispute.closed", { id, status: "lost" }));
    row = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    eq("a lost verdict is a charge-back", row.status, ORDER_STATUS.CHARGED_BACK);
    eq("and a later event does not rewrite when the claim began",
      row.disputedAt?.toISOString(), began);
    assert("which is genuinely earlier than the resolution",
      row.disputedAt!.getTime() < row.disputeResolvedAt!.getTime(),
      `${row.disputedAt?.toISOString()} vs ${row.disputeResolvedAt?.toISOString()}`);
    eq("with the final claim status", row.disputeStatus, "lost");
    assert("and a resolution time", !!row.disputeResolvedAt);
  }

  console.log("\n--- 2. the full lifecycle of a dispute that is won ---\n");
  {
    const order = await makeOrder();
    const id = `dp_won_${stamp}`;

    await handleDisputeEvent(disputeEvent("charge.dispute.created", {
      id, paymentIntent: order.externalPaymentId!, status: "needs_response",
    }));
    await handleDisputeEvent(disputeEvent("charge.dispute.funds_withdrawn", { id, status: "needs_response" }));
    let row = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    eq("the money is out while the claim is decided", row.status, ORDER_STATUS.DISPUTED);

    // funds_reinstated: the money comes back.
    await handleDisputeEvent(disputeEvent("charge.dispute.funds_reinstated", { id, status: "won" }));
    row = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    eq("reinstated funds return the order to paid", row.status, ORDER_STATUS.PAID);
    assert("and record that they came back", !!row.disputeFundsReinstatedAt);

    // closed won, arriving after the money is already back.
    await handleDisputeEvent(disputeEvent("charge.dispute.closed", { id, status: "won" }));
    row = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    eq("a won verdict leaves it paid", row.status, ORDER_STATUS.PAID);
    // ============ THE HISTORY SURVIVES THE WIN ==================
    //
    // Winning does not erase that it happened. An owner disputed twice in a
    // month is a fact worth keeping even when both were won.
    eq("and the claim is still on the record", row.disputeStatus, "won");
    assert("with when it began", !!row.disputedAt);
    assert("and when it resolved", !!row.disputeResolvedAt);
  }

  console.log("\n--- 3. an inquiry that never becomes a chargeback ---\n");
  {
    // ============ THE CASE THAT WOULD INVENT A LOSS ==============
    //
    // A bank asking a question. No funds ever move. An implementation that
    // flipped the order on `created` would report this business as having lost
    // a sale it never lost, and then never correct itself, because
    // warning_closed is not a refund.
    const order = await makeOrder();
    const id = `dp_inq_${stamp}`;

    await handleDisputeEvent(disputeEvent("charge.dispute.created", {
      id, paymentIntent: order.externalPaymentId!, status: "warning_needs_response",
    }));
    let row = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    eq("an inquiry does not touch the money", row.status, ORDER_STATUS.PAID);
    assert("and is recognisable as an inquiry", isInquiryOnly(row.disputeStatus));

    await handleDisputeEvent(disputeEvent("charge.dispute.updated", { id, status: "warning_under_review" }));
    row = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    eq("nor does reviewing it", row.status, ORDER_STATUS.PAID);

    await handleDisputeEvent(disputeEvent("charge.dispute.closed", { id, status: "warning_closed" }));
    row = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    eq("and closing it leaves the sale intact", row.status, ORDER_STATUS.PAID);
    eq("no funds were ever withdrawn", row.disputeFundsWithdrawnAt, null);
    // The inquiry is still on the record — it happened.
    eq("but the inquiry is remembered", row.disputeStatus, "warning_closed");
  }

  console.log("\n--- 4. a dispute against an already-refunded order ---\n");
  {
    // Sean: keep `refunded` authoritative while recording the dispute detail.
    // The money already went back deliberately; a claim about the same money
    // must not overwrite the truer fact.
    const order = await makeOrder({ status: ORDER_STATUS.REFUNDED });
    const id = `dp_ref_${stamp}`;

    await handleDisputeEvent(disputeEvent("charge.dispute.created", {
      id, paymentIntent: order.externalPaymentId!, status: "needs_response",
    }));
    await handleDisputeEvent(disputeEvent("charge.dispute.funds_withdrawn", { id, status: "needs_response" }));
    await handleDisputeEvent(disputeEvent("charge.dispute.closed", { id, status: "lost" }));

    const row = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    eq("the order is still refunded", row.status, ORDER_STATUS.REFUNDED);
    // And the dispute is not lost from the record.
    eq("and the dispute is recorded anyway", row.disputeStatus, "lost");
    assert("including that funds were withdrawn", !!row.disputeFundsWithdrawnAt);
  }

  console.log("\n--- 5. a disputed order can still be fulfilled; a lost one cannot ---\n");
  {
    // ============ SEAN'S DECISION, ASSERTED BOTH WAYS ===========
    //
    // Shipping and proving delivery is how a merchant wins a dispute. Blocking
    // it would remove a real strategy for preventing a loss that has not
    // happened. Refunded and charged-back keep the protection they had.
    eq("a paid order may be fulfilled", isMoneyGoneForGood(ORDER_STATUS.PAID), false);
    eq("a DISPUTED order may still be fulfilled", isMoneyGoneForGood(ORDER_STATUS.DISPUTED), false);
    eq("a refunded order may not", isMoneyGoneForGood(ORDER_STATUS.REFUNDED), true);
    eq("and neither may a charged-back one", isMoneyGoneForGood(ORDER_STATUS.CHARGED_BACK), true);

    // The refusal an owner actually reads, and its absence where they may act.
    eq("no refusal for a disputed order", refusalReason(ORDER_STATUS.DISPUTED), null);
    assert("a charged-back order says why, in the owner's terms",
      (refusalReason(ORDER_STATUS.CHARGED_BACK) ?? "").includes("bank returned the money"));
    assert("and a refunded one keeps its original wording",
      (refusalReason(ORDER_STATUS.REFUNDED) ?? "").includes("at your expense"));

    // The guards themselves, at the two call sites that spend money.
    const shipping = readFileSync("lib/execution/executables/shipping.ts", "utf8");
    const orders = readFileSync("lib/execution/executables/orders.ts", "utf8");
    assert("the shipping executable asks the shared rule",
      shipping.includes("refusalReason(order.status)"), "it decides for itself again");
    assert("and no longer compares to a bare string",
      !/order\.status === "refunded"/.test(shipping));
    assert("the fulfilment executable asks the shared rule",
      orders.includes("isMoneyGoneForGood(order.status)"));
  }

  console.log("\n--- 6. what the owner sees, and what reporting counts ---\n");
  {
    const base = { fulfillmentStatus: "unfulfilled", trackingNumber: null, deliveredAt: null };
    eq("a paid order reads as paid", stageOf({ ...base, status: ORDER_STATUS.PAID }), "paid");
    eq("a disputed order reads as disputed", stageOf({ ...base, status: ORDER_STATUS.DISPUTED }), "disputed");
    eq("a charged-back order says so", stageOf({ ...base, status: ORDER_STATUS.CHARGED_BACK }), "charged_back");

    // ============ MONEY OUTRANKS THE PARCEL =====================
    //
    // A disputed order may well have been delivered. Saying "Delivered"
    // describes the parcel and hides the thing the owner must act on.
    eq("a delivered but disputed order still reads as disputed",
      stageOf({ ...base, status: ORDER_STATUS.DISPUTED, trackingNumber: "1Z", deliveredAt: new Date() }), "disputed");
    eq("and a delivered charged-back one reads as charged back",
      stageOf({ ...base, status: ORDER_STATUS.CHARGED_BACK, deliveredAt: new Date() }), "charged_back");

    assert("every stage has words for the owner",
      (["paid", "processing", "shipped", "delivered", "refunded", "disputed", "charged_back"] as const)
        .every((s) => typeof STAGE_LABEL[s] === "string" && STAGE_LABEL[s].length > 0));

    // Reporting. A disputed order's money is with the bank.
    eq("paid counts as revenue", countsAsRevenue(ORDER_STATUS.PAID), true);
    eq("disputed does not", countsAsRevenue(ORDER_STATUS.DISPUTED), false);
    eq("charged back does not", countsAsRevenue(ORDER_STATUS.CHARGED_BACK), false);
    eq("refunded does not", countsAsRevenue(ORDER_STATUS.REFUNDED), false);
    eq("and everything but paid is a reversal", ORDER_STATUSES.filter(isMoneyReversed).sort(),
      ["charged_back", "disputed", "refunded"]);

    // Through the real mapper, which is what BI and the owner's numbers read.
    const rows = await prisma.order.findMany({ where: { storeId: store.id } });
    const mapped = mapOrdersToTransactions(rows);
    const byStatus = new Map(rows.map((r) => [r.id, r.status]));
    for (const record of mapped) {
      const orderId = rows.find((r) => record.id.includes(r.id))?.id;
      const status = orderId ? byStatus.get(orderId) : undefined;
      if (!status) continue;
      const data = record.data as { type: string };
      eq(`a ${status} order maps to ${status === "paid" ? "a sale" : "a reversal"}`,
        data.type, status === "paid" ? "sale" : "refund");
    }
  }

  console.log("\n--- 7. redelivery and out-of-order events ---\n");
  {
    // Stripe redelivers. The same event twice must not change the answer.
    const order = await makeOrder();
    const id = `dp_dup_${stamp}`;
    const created = disputeEvent("charge.dispute.created", {
      id, paymentIntent: order.externalPaymentId!, status: "needs_response",
    });
    await handleDisputeEvent(created);
    const first = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    await handleDisputeEvent(created);
    const second = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    eq("a redelivered created changes nothing", second.status, first.status);
    eq("and does not move when the claim began",
      second.disputedAt?.toISOString(), first.disputedAt?.toISOString());

    const withdrawn = disputeEvent("charge.dispute.funds_withdrawn", { id, status: "needs_response" });
    await handleDisputeEvent(withdrawn);
    await handleDisputeEvent(withdrawn);
    const twice = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    eq("a redelivered funds_withdrawn is still one withdrawal", twice.status, ORDER_STATUS.DISPUTED);

    // A later event finds the order by the CLAIM id, with no payment intent.
    const closed = disputeEvent("charge.dispute.closed", { id, status: "lost" });
    await handleDisputeEvent(closed);
    const done = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    eq("an event carrying only the dispute id still finds the order", done.status, ORDER_STATUS.CHARGED_BACK);
  }

  console.log("\n--- 8. a dispute for a charge with no order here ---\n");
  {
    // Genuinely possible — a payment taken before Genesis existed, or a store
    // since deleted. It must not throw, because throwing fails the webhook and
    // Stripe redelivers the whole event for ever.
    const outcome = await handleDisputeEvent(disputeEvent("charge.dispute.created", {
      id: `dp_orphan_${stamp}`, paymentIntent: `pi_nothing_${stamp}`, status: "needs_response",
    }));
    eq("no order is found", outcome.orderId, null);
    eq("and it says why", outcome.skipped, "no matching order");
  }

  console.log("\n--- 9. the route hands dispute events to the handler ---\n");
  {
    // The wiring, so a handler that exists and is never called cannot pass.
    const route = readFileSync("lib/payments/stripeEvent.ts", "utf8");
    assert("the Stripe handler dispatches dispute events", route.includes("isDisputeEvent(event.type)"));
    assert("to the one handler", route.includes("handleDisputeEvent(event)"));
    // Never throws out of the webhook.
    assert("and never lets one fail the webhook",
      /handleDisputeEvent\(event\)\.catch\(/.test(route));
    // Still not in the queue, per the instruction.
    assert("and does not enqueue it", !/enqueue\(/.test(route));
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
