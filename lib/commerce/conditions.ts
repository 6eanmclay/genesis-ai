import { prisma } from "@/lib/prisma";
import { upsertObservation, resolveMissingObservations, type ObservationState } from "@/lib/dashboard/genesisObservations";
import { isBrokenConnection } from "@/lib/integrations/paymentBadge";
import { isEmailConfigured } from "@/lib/email/sendEmail";

/**
 * WHAT IS ACTUALLY WRONG IN COMMERCE, SAID ONCE PER CONDITION.
 *
 * ============ WHY THIS EXISTS (2026-09-13) ============================
 *
 * Read against production before writing a line of it: 14 orders across 5
 * stores, and J4 had never raised a single Commerce item. Of 51 pending
 * approvals, every one was storefront, brand, product or marketing. Meanwhile
 * two orders had been paid and unfulfilled for 41 and 40 days, three were
 * marked shipped with no tracking 17 to 41 days ago, and not one buyer in the
 * product's history had been sent a confirmation.
 *
 * The capability was never the gap — J4 has had `toggle_order_fulfilled` and
 * `attach_tracking` for weeks. Nothing ever looked at orders and formed an
 * opinion.
 *
 * ============ WHAT THIS IS NOT ======================================
 *
 * Not a Commerce attention model. Sean: "Do not create a Commerce-specific
 * attention model... Every candidate needs-doing item must be classified."
 * These are GenesisObservations, written through the same upsert/resolve pair
 * every other sweep uses, and they reach the owner through the shared
 * attention layer that Business and Office already consume. There is no new
 * source, no new taxonomy, and no schema change.
 *
 * Not a presentation either. Nothing here decides how Commerce looks; the
 * Commerce lead region is a later slice, deliberately designed after real
 * observations have been seen.
 *
 * ============ ONE CONDITION, ONE ROW ================================
 *
 * The rule that shapes every dedupeKey below: a condition is a fact about the
 * BUSINESS, not about a row. Fourteen receiptless orders are one problem —
 * "your buyers are not getting confirmations" — and rendering fourteen
 * separate items would bury the other three conditions under a single
 * repeated sentence.
 *
 * So each key is `commerce:<condition>`, carries no order id, and the orders
 * that contribute are named as EVIDENCE in the sentence (how many, and how
 * old the worst one is). `upsertObservation` is keyed on (storeId, dedupeKey),
 * so a store gets exactly one row per condition however many orders are
 * involved, and it updates in place as the count changes.
 */

/** The namespace these conditions own, so a sweep only resolves its own rows. */
export const COMMERCE_CONDITION_PREFIX = "commerce:";

export type CommerceConditionKey =
  | "orders_unfulfilled_stale"
  | "orders_shipped_untracked"
  | "receipts_unsent"
  | "payment_connection_broken";

export interface CommerceCondition {
  key: CommerceConditionKey;
  /** `commerce:<key>`. Never an order id — see the note above. */
  dedupeKey: string;
  genesisState: ObservationState;
  /** J4's own sentence, carrying the evidence that makes it true. */
  summary: string;
  actionHref: string | null;
  /**
   * WHICH ORDERS MAKE THIS TRUE.
   *
   * Returned so a caller — and the suite — can check the sentence against the
   * rows it describes, and so a later Commerce surface can show the work
   * without re-deriving the condition. Deliberately NOT written into the
   * dedupeKey: identity is the condition, evidence is what it currently
   * covers, and conflating them would spawn a new row every time an order
   * shipped.
   */
  orderIds: string[];
}

/**
 * HOW LONG IS TOO LONG FOR A PAID ORDER TO SIT.
 *
 * Fourteen days, and it is a judgment rather than a measurement — so it is
 * named once, here, instead of being spelled inline where it would quietly
 * become two different numbers. Production is unambiguous at this threshold:
 * two orders sit at 41 and 40 days in two different stores, while the only
 * other unfulfilled work is six orders 0 to 8 days old in a store that is
 * actively trading. Anything under a fortnight is a queue; past it, somebody
 * has paid and been forgotten.
 */
export const STALE_FULFILMENT_DAYS = 14;

/** Whole days between then and now, floored — never a fraction of a day. */
function daysSince(when: Date, now: Date): number {
  return Math.floor((now.getTime() - when.getTime()) / 86_400_000);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The conditions that are TRUE for this store right now.
 *
 * A pure read: it writes nothing, so it can be called to inspect a store
 * without changing what J4 is saying about it.
 */
export async function getCommerceConditions(
  storeId: string,
  now: Date = new Date(),
): Promise<CommerceCondition[]> {
  const conditions: CommerceCondition[] = [];

  const orders = await prisma.order.findMany({
    where: { storeId },
    select: {
      id: true, status: true, fulfillmentStatus: true, trackingNumber: true,
      confirmationSentAt: true, createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // ---- 1. PAID, AND NOBODY HAS SENT IT ------------------------------
  const stale = orders.filter(
    (o) =>
      o.status === "paid" &&
      o.fulfillmentStatus === "unfulfilled" &&
      daysSince(o.createdAt, now) >= STALE_FULFILMENT_DAYS,
  );
  if (stale.length > 0) {
    const oldest = daysSince(stale[0].createdAt, now);
    conditions.push({
      key: "orders_unfulfilled_stale",
      dedupeKey: `${COMMERCE_CONDITION_PREFIX}orders_unfulfilled_stale`,
      genesisState: "urgent",
      summary:
        `${plural(stale.length, "order has", "orders have")} been paid for and not fulfilled` +
        ` — the oldest ${plural(oldest, "day", "days")} ago.`,
      actionHref: "/dashboard/orders",
      orderIds: stale.map((o) => o.id),
    });
  }

  // ---- 2. MARKED SHIPPED, WITH NOTHING TO FOLLOW --------------------
  //
  // NO GRACE PERIOD, on purpose. The sweep runs daily, so an order fulfilled
  // and tracked in the same working day is never seen in this state at all —
  // an invented threshold would only add a number nobody could justify.
  const untracked = orders.filter(
    (o) => o.fulfillmentStatus === "fulfilled" && o.trackingNumber === null,
  );
  if (untracked.length > 0) {
    conditions.push({
      key: "orders_shipped_untracked",
      dedupeKey: `${COMMERCE_CONDITION_PREFIX}orders_shipped_untracked`,
      genesisState: "urgent",
      summary:
        `${plural(untracked.length, "order is", "orders are")} marked shipped with no tracking number,` +
        ` so the buyer has no way to follow it.`,
      actionHref: "/dashboard/orders",
      orderIds: untracked.map((o) => o.id),
    });
  }

  // ---- 3. THE BUYERS WHO WERE NEVER TOLD ----------------------------
  //
  // ============ A FACT, AND SEPARATELY A REASON ====================
  //
  // Sean: "'No confirmation has been sent' is not 'sending failed'. Do not
  // claim an email was attempted or failed unless the actual system has
  // evidence of that."
  //
  // The column records only whether a confirmation WAS sent. It records no
  // attempt, so this says no more than the column knows. The second sentence
  // is added only when the capability is genuinely absent — `isEmailConfigured`
  // is a real check on real configuration, which is evidence about the system
  // rather than a guess about what happened to any particular order.
  const unsent = orders.filter((o) => o.confirmationSentAt === null);
  if (unsent.length > 0) {
    const oldest = daysSince(unsent[0].createdAt, now);
    const blocked = !isEmailConfigured();
    conditions.push({
      key: "receipts_unsent",
      dedupeKey: `${COMMERCE_CONDITION_PREFIX}receipts_unsent`,
      genesisState: "urgent",
      summary:
        `${plural(unsent.length, "buyer has", "buyers have")} not been sent an order confirmation` +
        ` — the earliest ordered ${plural(oldest, "day", "days")} ago.` +
        (blocked ? " I cannot send them: no email provider is connected yet." : ""),
      actionHref: blocked ? "/dashboard/connections" : "/dashboard/orders",
      orderIds: unsent.map((o) => o.id),
    });
  }

  // ---- 4. A CONNECTION THAT CANNOT TAKE MONEY -----------------------
  //
  // STRIPE and PAYPAL because those are the two the Payments screen itself
  // treats as payment providers — not a list invented here.
  //
  // `isBrokenConnection` is the product's own extracted rule (it has its own
  // suite, verify-payment-badge): a connection that EXISTS and is not working.
  // DISCONNECTED and absent are deliberately not broken — Sean: "Do not infer
  // failure from absence of data."
  const payments = await prisma.storeIntegration.findMany({
    where: { storeId, provider: { in: ["STRIPE", "PAYPAL"] } },
    select: { provider: true, status: true },
  });
  const broken = payments.filter((p) => isBrokenConnection(p.status));
  if (broken.length > 0) {
    const names = broken.map((p) => (p.provider === "STRIPE" ? "Stripe" : "PayPal"));
    conditions.push({
      key: "payment_connection_broken",
      dedupeKey: `${COMMERCE_CONDITION_PREFIX}payment_connection_broken`,
      genesisState: "urgent",
      summary:
        `Your ${names.join(" and ")} connection is not working,` +
        ` so this store cannot reliably take payments.`,
      actionHref: "/dashboard/payments",
      // Not about orders at all. Empty rather than absent, so every condition
      // answers the same question about its evidence.
      orderIds: [],
    });
  }

  return conditions;
}

/**
 * Raise what is true, clear what stopped being true.
 *
 * The same lifecycle every other sweep uses, and deliberately no more: upsert
 * on (storeId, dedupeKey) so a second run updates one row rather than adding
 * one, and resolve anything in this namespace that is no longer among them.
 *
 * Resolution is called per state rather than once, because
 * resolveMissingObservations is scoped by genesisState — every condition here
 * is currently "urgent", and a future "opportunity" one would silently never
 * resolve if this assumed otherwise.
 */
export async function proposeCommerceConditions(storeId: string, now: Date = new Date()): Promise<void> {
  const conditions = await getCommerceConditions(storeId, now);

  for (const condition of conditions) {
    await upsertObservation(storeId, {
      dedupeKey: condition.dedupeKey,
      genesisState: condition.genesisState,
      summary: condition.summary,
      actionHref: condition.actionHref,
    });
  }

  for (const state of ["urgent", "opportunity"] as const) {
    await resolveMissingObservations(
      storeId,
      conditions.filter((c) => c.genesisState === state).map((c) => c.dedupeKey),
      state,
      COMMERCE_CONDITION_PREFIX,
    );
  }
}
