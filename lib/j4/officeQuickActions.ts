// WHAT THE OWNER CAN START RIGHT NOW, AND ONLY WHAT THEY CAN.
//
// ============ WHY THIS IS NOT THE FACT STRIP AGAIN ===================
//
// The Office already shows what J4 is HOLDING — five sourced counts, each
// leading somewhere (officeFacts.ts). That answers "what is waiting on me".
// It does not answer "what can I begin", which is what the reference's action
// row is for, and the distinction is the whole reason this module is allowed
// to exist:
//
//   the strip          nouns. counts J4 is keeping for you, with evidence
//   these actions      verbs. capabilities you can start, with a reason
//
// If one ever restates the other, delete this file rather than reconciling
// them. A second parallel representation of the same facts is the exact shape
// the Office is currently migrating away from.
//
// ============ NOTHING HERE IS OFFERED THAT CANNOT BE DONE ============
//
// Every action carries a real permission gate and a real state gate, and both
// come from data the Office already has — no query is added to a measured
// path. "Review orders" on a store with no orders is a link to an empty
// ledger; "Plan my marketing" for a store with nothing to sell is marketing
// nothing. Those are not disabled buttons, they are absent ones.
//
// The one case that IS shown with a caveat is marketing without an email
// platform: the capability genuinely exists (there is a marketing room, and
// real work in it), it simply cannot send or measure a campaign yet. Sean's
// rule for exactly this: communicate the real limitation rather than
// pretending it can.
//
// ============ AND NONE OF THEM EXECUTES ANYTHING =====================
//
// A quick action navigates or changes which view the Office is showing. It
// never calls an executable. Running a mutation from a shortcut would step
// around the decision layer — the authority model, the approval record, the
// warrant — that four slices of work exist to keep honest.

/**
 * Where a quick action goes.
 *
 * The same discriminated shape OfficeFact uses, and for the same reason: a
 * route is a navigation and a view is a change of what this surface shows.
 * They are different acts and the browser should treat them differently.
 */
export type QuickActionTarget =
  | { kind: "route"; href: string }
  | { kind: "view"; view: string };

export interface QuickAction {
  key: string;
  /** The verb the owner reads. */
  label: string;
  target: QuickActionTarget;
  /**
   * Why this is being offered, from real state. Required, like OfficeFact's
   * `source` — an action with no reason to be here is decoration, and the
   * type refuses to let one be built.
   */
  because: string;
  /**
   * A real limitation, when the capability exists but cannot fully deliver.
   * Shown to the owner verbatim. Never a hedge, never a disabled state.
   */
  limitation?: string;
}

export interface QuickActionInput {
  basePath: string;
  /** PERMISSIONS.STORE_MANAGE for this owner. */
  canManageStore: boolean;
  /** PERMISSIONS.ORDERS_VIEW for this owner. */
  canViewOrders: boolean;
  /** Real catalogue size. */
  activeProducts: number;
  /** Every order this business has ever taken, not a window. */
  allTimeOrderCount: number;
  /**
   * Whether anything can currently produce campaign performance.
   *
   * From the understanding's own connectedSummaries, which the Office already
   * loads — null there means no connected source, which is precisely the
   * limitation the marketing action has to state.
   */
  hasCampaignSource: boolean;
}

export function officeQuickActions(input: QuickActionInput): QuickAction[] {
  const { basePath } = input;
  const out: { action: QuickAction; rank: number }[] = [];

  // CREATE A PRODUCT — the primary creative capability, and the verified one:
  // Product Creation is the Studio's reference implementation, proven end to
  // end from upload through Printful to Stripe. Offered whenever the owner can
  // manage the store, because "make something to sell" is never irrelevant to
  // a shop; it simply matters most when there is nothing to sell yet.
  if (input.canManageStore) {
    out.push({
      rank: input.activeProducts === 0 ? 100 : 40,
      action: {
        key: "create-product",
        label: "Create a product",
        target: { kind: "route", href: `${basePath}/studio/create` },
        because:
          input.activeProducts === 0
            ? "there is nothing in your catalogue yet"
            : "add something new to your catalogue",
      },
    });
  }

  // REVIEW ORDERS — only when orders exist. A shortcut to an empty ledger
  // teaches an owner that shortcuts lie.
  if (input.canViewOrders && input.allTimeOrderCount > 0) {
    out.push({
      rank: 80,
      action: {
        key: "review-orders",
        label: "Review orders",
        target: { kind: "route", href: `${basePath}/orders` },
        because: `${input.allTimeOrderCount} ${input.allTimeOrderCount === 1 ? "order has" : "orders have"} come in`,
      },
    });
  }

  // PLAN MY MARKETING — only once there is something to market, and honest
  // about what it cannot do yet when no email platform is connected. The room
  // is real either way: SEO, social bios and the newsletter list all live
  // there and all work.
  if (input.canManageStore && input.activeProducts > 0) {
    out.push({
      rank: 60,
      action: {
        key: "plan-marketing",
        label: "Plan my marketing",
        target: { kind: "route", href: `${basePath}/marketing` },
        because: "you have something to sell",
        ...(input.hasCampaignSource
          ? {}
          : {
              limitation:
                "I cannot send or measure a campaign until an email platform is connected.",
            }),
      },
    });
  }

  // WHAT I KNOW — always available inside the Office, because it is J4's own
  // account of the business and it states its own emptiness honestly. A view,
  // never a route: the owner does not leave the room to hear what J4 knows.
  out.push({
    rank: 20,
    action: {
      key: "analyze-business",
      label: "What I know about your business",
      target: { kind: "view", view: "understanding" },
      because: "every fact I hold, and where each one came from",
    },
  });

  // ORDERED BY WHAT THE STATE MAKES MOST CONSEQUENTIAL, not by a fixed list.
  // Deliberately NOT getNextBestAction: that returns an approvalRequestId —
  // which pending decision to lead with — and the Office already surfaces
  // those as DECISIONS, in the strip and in its own view. Using an answer
  // about approvals to sort navigation shortcuts would be borrowing a number
  // to mean something it does not mean.
  return out.sort((a, b) => b.rank - a.rank).map((o) => o.action);
}

/** Every action states why it is here. Exported so a suite asserts it. */
export function everyActionIsReasoned(actions: QuickAction[]): boolean {
  return actions.every((a) => a.because.trim().length > 0 && a.label.trim().length > 0);
}
