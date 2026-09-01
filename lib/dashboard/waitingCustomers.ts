import type { AttentionItem } from "./types";
import { getObligations } from "@/lib/businessModel/obligations";

// SOMEBODY HAS PAID AND IS WAITING FOR THEIR PARCEL.
//
// ============ WHAT THE DASHBOARD NEVER SAID (2026-09-01) ===============
//
// getStateIssues raises three things, and every one is a reason the shop
// cannot sell: it is not published, it has no active products, no payment
// method is connected. Nothing was raised for the opposite situation — the
// shop sold something, the money arrived, and a real person is now waiting for
// a parcel.
//
// A real order sat unfulfilled on a live store and the owner found it by
// looking. J4 could answer if asked, because lib/businessModel/obligations.ts
// has computed exactly this since M6. The dashboard never volunteered it.
//
// ============ SO IT REUSES THAT, RATHER THAN COUNTING AGAIN ============
//
// getObligations already separates the four facts that look alike — money
// arrived, money went back, the owner's own acknowledgment, and a label having
// been bought — and already excludes refunded orders from what is owed. A
// second count here would be a second chance to conflate them.
//
// ============ AND IT KEEPS THAT FILE'S TWO RULES ======================
//
// NO THRESHOLD. Nothing here calls an order late or overdue. The wait is
// reported in whole days and the owner judges it, because shipping norms
// differ by business and a threshold is a detector wearing a different hat.
//
// NEVER "YOU HAVE NOT SHIPPED THIS". fulfillmentStatus is the owner's own
// recorded acknowledgment, not evidence about a parcel. They may well have
// posted it on Tuesday and not told Genesis, and a card that accused them of
// neglecting a customer would be wrong in the one direction that matters.

/**
 * The customers this business currently owes something to.
 *
 * One item, not one per order. The attention zone is capped and an owner with
 * nine outstanding orders wants to know that, not to lose eight other cards to
 * it — the count is the finding, and the orders screen is where the detail
 * already lives.
 *
 * A WARNING rather than a failure, whatever the age. Nothing has broken: a shop
 * sold something. Marking it urgent on day twenty would be the threshold this
 * deliberately does not have.
 */
export async function getWaitingCustomerIssues(storeId: string): Promise<AttentionItem[]> {
  const obligations = await getObligations(storeId);
  if (obligations.outstandingCount === 0) return [];

  const oldest = obligations.oldestWaitingDays;
  const count = obligations.outstandingCount;

  // The oldest order is the one worth naming, because it is the one a person
  // has been waiting longest for. Named by product, never by customer: an
  // attention card is rendered on a dashboard somebody may be screen-sharing,
  // and the buyer's identity is one click away on the order itself.
  const who =
    count === 1
      ? `${obligations.outstanding[0].productName} is waiting to go out`
      : `${count} orders are waiting to go out`;

  const age =
    oldest === null
      ? ""
      : oldest === 0
        ? " The oldest came in today."
        : ` The oldest has been waiting ${oldest} ${oldest === 1 ? "day" : "days"}.`;

  // A label already bought is the case most worth telling apart: the owner has
  // spent real money on postage and simply not marked the order, so the useful
  // sentence is about the record rather than about the parcel.
  const labelled = obligations.outstanding.filter((o) => o.labelPurchased).length;
  const labelNote =
    labelled > 0
      ? ` ${labelled === count ? "Postage is already bought" : `${labelled} already ${labelled === 1 ? "has" : "have"} postage bought`} — if ${labelled === 1 ? "it has" : "they have"} gone out, marking ${labelled === 1 ? "it" : "them"} fulfilled will clear this.`
      : "";

  return [
    {
      // Stable, so dismissing it dismisses THIS finding rather than the idea of
      // it — and so the count changing produces a new card, because "three
      // people waiting" and "four people waiting" are different facts.
      id: `waiting:${count}:${oldest ?? "none"}`,
      kind: "waiting-customer",
      severity: "WARNING",
      message: `${who}.${age}${labelNote}`,
      // No single occurrence time: this is a standing state, like the other
      // state issues, and a timestamp would suggest a moment it happened.
      occurredAt: null,
      actionHref: "/dashboard/orders",
    },
  ];
}
