import type { ObservationNeed } from "@/lib/j4/observationNeeds";
import type { CommerceConditionKey } from "./conditionKeys";

// WHAT EACH COMMERCE CONDITION ACTUALLY NEEDS FROM THE OWNER.
//
// ============ WHY THIS IS COMMERCE'S FILE, NOT THE OFFICE'S ============
//
// The Office must not know that "commerce:receipts_unsent" is a thing. It asks
// one generic question — what does this observation need? — and each producer
// answers for its own keys. A second producer adds its own map beside this one
// and the Office is untouched.
//
// ZERO VALUE IMPORTS, both of them types. lib/j4/officeBriefing.ts is
// value-imported by a client component, so anything the Office's action
// mapping reaches must stay out of the browser bundle — the same rule
// lib/j4/boundaries.ts was split out to keep.
//
// ============ MEASURED, NOT ASSIGNED BY TASTE (2026-09-14) =============
//
// The natural cron produced five real observations on 2026-09-14 and every one
// of them rendered under "I have seen these and cannot act on them yet." Three
// of the four families appeared; each mapping below is written against a real
// row, and the family that did not appear is deliberately left unmapped.

export const COMMERCE_OBSERVATION_NEEDS: Partial<Record<CommerceConditionKey, ObservationNeed>> = {
  // "11 buyers have not been sent an order confirmation — the earliest ordered
  // 56 days ago. I cannot send them: no email provider is connected yet."
  //
  // The sentence already names the blocker. Connecting an email provider is an
  // account only the owner can authorise, which is the existing boundary
  // word-for-word: "I cannot authorise myself against an account you own."
  receipts_unsent: {
    what: "Connect an email provider so I can send order confirmations",
    boundary: "grant_access_on_owners_behalf",
  },

  // "Your Stripe connection is not working, so this store cannot reliably take
  // payments." Reconnecting is the same boundary: J4 knows exactly what to do
  // and is not allowed to do it against the owner's Stripe account.
  payment_connection_broken: {
    what: "Reconnect Stripe so this store can take payments again",
    boundary: "grant_access_on_owners_behalf",
  },

  // "1 order is marked shipped with no tracking number, so the buyer has no way
  // to follow it."
  //
  // DETERMINED FROM THE REAL ORDERS, not from the sentence. Both production
  // orders behind this condition have carrier NULL, labelClaimedAt NULL and
  // shippingCostInCents NULL — no label was ever bought through Genesis, so the
  // number is not recoverable from anything Genesis holds. attachTracking
  // exists and TAKES the number as input: J4 can apply one, never find one.
  //
  // DELIBERATELY DECLARES NO TOOL. The need is the NUMBER, and that is a
  // boundary; attaching it afterwards is a tool acting on something the owner
  // has already supplied. Declaring both would be the contradiction
  // contradictedBoundaries() exists to reject, and it would be a real one.
  orders_shipped_untracked: {
    what: "Give me the tracking number and I will put it on the order",
    boundary: "know_information_only_the_owner_holds",
  },

  // orders_unfulfilled_stale is DELIBERATELY ABSENT.
  //
  // It produced no rows in the natural run, so there is no real instance to
  // reason from. A boundary is "a claim about the world, not about the
  // backlog", and declaring one for a condition nobody has seen fire would be
  // exactly the guess this model exists to prevent. Unmapped falls through to
  // the behaviour it has today, which is the safe direction: a producer opts
  // in, and until it does nothing about it changes.
};
