import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { LEGACY_BUSINESS_BASE, sectionHref } from "@/lib/dashboard/navConfig";

/**
 * WHAT THE OWNER CAN ACTUALLY DO ABOUT A THING J4 SURFACED.
 *
 * ============ THE PROBLEM THIS EXISTS TO END (2026-09-09) ==============
 *
 * Sean: "Right now Ideas, Decisions, Information, etc. mostly display text
 * that I can read - but then nothing happens when I interact with it. That's
 * not useful." And: "Do not make fake buttons just to make the UI look
 * interactive. If an item genuinely cannot be acted upon yet, make that state
 * explicit rather than pretending it is interactive."
 *
 * Measured in production before writing a line of this (ACTIVE rows, which is
 * all the Office reads):
 *
 *     Ideas          53 rows,  39 lead somewhere,  14 dead
 *     Information    34 rows,   8 lead somewhere,  26 dead
 *     Explanations  158 rows,   0 lead somewhere, 158 dead
 *
 * 198 rows rendered with a hover highlight and no destination. CategoryRow
 * kept `hover:bg-white/[.04]` whether or not it had an href, so every one of
 * them lit up under a finger and did nothing. That is a fake button by
 * accident, which is worse than one on purpose: nobody decided it.
 *
 * ============ WHERE THE DEAD ROWS CAME FROM ============================
 *
 * 25 of the 26 dead Information rows traced to a single producer path:
 * getRecentNegativeOutcomes/getStaleExecutions in needsAttention.ts map an
 * ExecutionLog row straight to the owner - `message: row.message` - with no
 * actionHref at all. By execution action:
 *
 *     10  store.refine_storefront           an internal validation message
 *      6  genesis.recommendations.generate  J4's own review claim rows
 *      8  integration.{google_calendar,quickbooks}.sync   REAL, and fixable
 *      1  checkout.paypal.capture           REAL, about a specific order
 *
 * So "dead rows" was never one problem. Sixteen of those rows should never
 * have reached the owner at all - an internal exception string is a bug
 * report, not business intelligence, and putting a button on
 * `Provider error (billing): 400 {"type":"error"...}` would have been the
 * fake interactivity Sean ruled out. Nine are real and simply lacked a
 * destination that already exists.
 *
 * needsAttention.ts already carries the scar of the same shape one function
 * over: on 2026-08-19, 47 of one store's 52 urgent observations were J4's own
 * chat replies quoted back as failures. This is that defect's sibling.
 *
 * ============ THE RULE, AND WHY IT IS SELF-ENFORCING ===================
 *
 * An execution failure is owner-facing WHEN, AND ONLY WHEN, there is somewhere
 * the owner can go about it. The map below is the whole definition: an action
 * in it is intelligence, an action absent from it is a bug report. There is no
 * second list to keep in step, so a new action cannot become owner-facing
 * noise by default - it has to be given a destination on purpose.
 *
 * The types make the fake button unrepresentable. A row cannot be rendered as
 * interactive without an `open` or `execute`, and `none`/`internal` both carry
 * a REASON, because "nothing to do here" is information the owner is owed.
 */

/**
 * WHAT IS MISSING, WHEN THE MISSING THING IS THE OWNER.
 *
 * Sean, 2026-09-10: "Preserve the distinction between: J4 needs information
 * from the owner / J4 needs a decision from the owner / J4 needs
 * permission-authorization / J4 lacks a capability entirely. Those may
 * eventually deserve different metadata even if they initially share the
 * needs_owner action kind."
 *
 * So the distinction is carried from the start rather than retrofitted. These
 * four are not degrees of the same thing — they fail differently and they are
 * resolved differently:
 *
 *   information  J4 would act if it knew something only the owner knows.
 *   decision     J4 has options and no authority to choose between them.
 *   permission   J4 knows what to do and is not allowed to do it yet.
 *   capability   J4 cannot do this at all, by anyone's permission.
 *
 * "capability" is the one that carries the product's whole argument: J4 cannot
 * manufacture the owner's authenticity, expertise, or raw material, and an
 * Office that hides that is claiming to be the source rather than the
 * multiplier.
 */
export type OwnerRequirement = "information" | "decision" | "permission" | "capability";

/** What the owner can do about one surfaced item. */
export type OfficeAction =
  /** A real destination that exists. */
  | { kind: "open"; label: string; href: string }
  /**
   * A real execution, run through the engine that already exists.
   *
   * `offer` is what separates READY TO GO from DECIDE, and it is carried on
   * the action because Sean's rule for the Office is that "the action's own
   * kind must determine where it appears". Deriving the section from where a
   * row came from instead would put that knowledge back in the producer, and
   * two producers would eventually disagree about which pile a thing is in.
   *
   *   "act"     J4 recommends one thing and can do it. Approving runs it.
   *   "decide"  A real choice with real alternatives, which is why the pair
   *             from officeActionForDecision() carries approve AND reject.
   *
   * Both still require the owner to say yes. The difference is whether there
   * is a decision to make or simply work to release.
   */
  | {
      kind: "execute";
      label: string;
      intent: "approve" | "reject";
      offer: "act" | "decide";
      /**
       * THE OTHER REAL ANSWERS TO THIS SAME QUESTION (2026-09-11).
       *
       * Sean: "The owner must see the actual available options... Do not
       * invent options. Do not collapse multiple real options into a single
       * generic button."
       *
       * A decision arrived carrying only Approve, so the owner could say yes
       * and had nowhere to say no — on a surface whose own copy reads "Your
       * call". officeActionForDecision had returned the pair since it was
       * written; nothing ever called it, and BriefingItem.action could hold
       * only one action anyway.
       *
       * Carried ON the action rather than beside it, so an option cannot be
       * dropped on the way to the screen without dropping the action itself.
       * Optional and never padded: `offer: "act"` has no alternatives because
       * there is no second answer to invent, and a decision with one real
       * option would correctly render one.
       */
      alternatives?: readonly { label: string; intent: "approve" | "reject" }[];
    }
  /**
   * J4 knows what needs to happen and the owner is the missing source.
   *
   * NOT a fallback for anything J4 cannot execute. Sean: "Do not turn every
   * limitation, failure, or uncertainty into needs_owner." The bar is that J4
   * has identified a REAL business need AND can name what it needs from the
   * owner. Something J4 merely failed at is a failure; something J4 has not
   * understood is `none`; something with a page to visit is `open`.
   *
   * The fields enforce the bar as far as types can. `what` and `because` are
   * required, so a needs_owner that cannot say what it needs or why J4 cannot
   * supply it is unrepresentable — which is exactly the shape a lazy fallback
   * would take.
   */
  | {
      kind: "needs_owner";
      /** Which of the four kinds of missing thing this is. */
      missing: OwnerRequirement;
      /** What J4 needs from the owner, named specifically. */
      what: string;
      /** Why J4 cannot supply it itself. */
      because: string;
      /**
       * Where the owner can supply it — ONLY when such a place really exists.
       *
       * Sean: "Do not turn needs_owner into another button just for the sake
       * of having an action. It is a first-class state because the owner is
       * the missing capability." Optional is the mechanism: there is no
       * destination unless a real one was given, so the common case (bring me
       * photographs of your product) renders as a statement and nothing else.
       */
      provideAt?: { label: string; href: string };
    }
  /** Genuinely nothing to do YET, said out loud rather than implied. */
  | { kind: "none"; because: string }
  /** Never owner-facing: an internal record that must not reach the Office. */
  | { kind: "internal"; because: string };

/**
 * Whether this action may be rendered as something to press.
 *
 * needs_owner is deliberately NOT interactive by default. The 198 fake-hover
 * rows were one shared class on both branches of CategoryRow, and a new state
 * that returned a blanket `true` here would rebuild that defect in a costume
 * nobody would recognise: a row saying "I need photographs from you" is a
 * sentence, not a button, and lighting it up under a finger promises a
 * destination that does not exist.
 *
 * So it is pressable when, and only when, somebody gave it somewhere to go —
 * the same rule `open` has always followed, applied to a different shape.
 */
export function isInteractive(action: OfficeAction): boolean {
  if (action.kind === "needs_owner") return action.provideAt !== undefined;
  return action.kind === "open" || action.kind === "execute";
}

/**
 * Owner-facing execution actions, and where the owner goes about each.
 *
 * Every href here is a real route (app/b/[slug]/…): connections, payments,
 * orders, finances, products, website, catalog, studio, marketing. Nothing in
 * this map may name a page that does not exist - inventing a destination is
 * the same lie as inventing a button, and needsAttention.ts already has a
 * comment saying so about PRINTFUL/EASYPOST.
 *
 * The verb matters as much as the route. "Reconnect Google Calendar" tells the
 * owner what they are about to do; "View" tells them nothing.
 */
const OWNER_FACING: ReadonlyMap<string, { section: string; label: string }> = new Map([
  // Connections the owner can genuinely repair.
  [EXECUTION_ACTIONS.INTEGRATION_GOOGLE_CALENDAR_SYNC, { section: "/dashboard/connections", label: "Reconnect Google Calendar" }],
  [EXECUTION_ACTIONS.INTEGRATION_GOOGLE_CALENDAR_VERIFY, { section: "/dashboard/connections", label: "Check this connection" }],
  [EXECUTION_ACTIONS.INTEGRATION_GOOGLE_CALENDAR_CONNECT, { section: "/dashboard/connections", label: "Finish connecting Google Calendar" }],
  [EXECUTION_ACTIONS.INTEGRATION_QUICKBOOKS_SYNC, { section: "/dashboard/connections", label: "Reconnect QuickBooks" }],
  [EXECUTION_ACTIONS.INTEGRATION_QUICKBOOKS_VERIFY, { section: "/dashboard/connections", label: "Check this connection" }],
  [EXECUTION_ACTIONS.INTEGRATION_QUICKBOOKS_CONNECT, { section: "/dashboard/connections", label: "Finish connecting QuickBooks" }],
  [EXECUTION_ACTIONS.INTEGRATION_MAILCHIMP_SYNC, { section: "/dashboard/connections", label: "Reconnect Mailchimp" }],
  [EXECUTION_ACTIONS.INTEGRATION_MAILCHIMP_VERIFY, { section: "/dashboard/connections", label: "Check this connection" }],
  [EXECUTION_ACTIONS.INTEGRATION_MAILCHIMP_CONNECT, { section: "/dashboard/connections", label: "Finish connecting Mailchimp" }],

  // The payment rails have their own screen - see whereToFix() for why these
  // two are deliberately not Connections.
  [EXECUTION_ACTIONS.INTEGRATION_STRIPE_CONNECT, { section: "/dashboard/payments", label: "Fix your Stripe connection" }],
  [EXECUTION_ACTIONS.INTEGRATION_STRIPE_VERIFY, { section: "/dashboard/payments", label: "Check your Stripe connection" }],
  [EXECUTION_ACTIONS.INTEGRATION_PAYPAL_CONNECT, { section: "/dashboard/payments", label: "Fix your PayPal connection" }],
  [EXECUTION_ACTIONS.INTEGRATION_PAYPAL_VERIFY, { section: "/dashboard/payments", label: "Check your PayPal connection" }],

  // Money that moved with nothing to show for it. These are the highest-stakes
  // rows in the system and every one of them is about a real order.
  [EXECUTION_ACTIONS.CHECKOUT_PAYPAL_CAPTURE, { section: "/dashboard/orders", label: "Open orders" }],
  [EXECUTION_ACTIONS.CHECKOUT_STRIPE_UNRECORDED, { section: "/dashboard/orders", label: "Open orders" }],
  [EXECUTION_ACTIONS.CHECKOUT_PAYPAL_REFUND_UNAPPLIED, { section: "/dashboard/orders", label: "Open orders" }],
  [EXECUTION_ACTIONS.BILLING_STRIPE_UNAPPLIED, { section: "/dashboard/billing", label: "Open billing" }],

  // Fulfilment.
  [EXECUTION_ACTIONS.ORDER_PURCHASE_SHIPPING_LABEL, { section: "/dashboard/orders", label: "Open orders" }],
  [EXECUTION_ACTIONS.ORDER_ATTACH_TRACKING, { section: "/dashboard/orders", label: "Open orders" }],
  [EXECUTION_ACTIONS.ORDER_CORRECT_TRACKING, { section: "/dashboard/orders", label: "Open orders" }],
  [EXECUTION_ACTIONS.ORDER_TOGGLE_FULFILLED, { section: "/dashboard/orders", label: "Open orders" }],

  // The catalog.
  [EXECUTION_ACTIONS.PRODUCT_CREATE, { section: "/dashboard/products", label: "Open products" }],
  [EXECUTION_ACTIONS.PRODUCT_EDIT, { section: "/dashboard/products", label: "Open products" }],
  [EXECUTION_ACTIONS.PRODUCT_UPDATE_IMAGE, { section: "/dashboard/products", label: "Open products" }],
  [EXECUTION_ACTIONS.PRODUCT_ADD_IMAGES, { section: "/dashboard/products", label: "Open products" }],
  [EXECUTION_ACTIONS.PROMOTION_CREATE, { section: "/dashboard/promotions", label: "Open promotions" }],
  [EXECUTION_ACTIONS.PROMOTION_UPDATE, { section: "/dashboard/promotions", label: "Open promotions" }],

  // The storefront.
  [EXECUTION_ACTIONS.STORE_PUBLISH, { section: "/dashboard/website", label: "Open your storefront" }],
  [EXECUTION_ACTIONS.STORE_UPDATE_BRAND_LOGO, { section: "/dashboard/brand", label: "Open brand" }],
  [EXECUTION_ACTIONS.STORE_UPDATE_BRAND_IDENTITY, { section: "/dashboard/brand", label: "Open brand" }],
]);

/**
 * Why a given execution failure is not owner-facing.
 *
 * Named individually rather than as one blanket sentence, because "J4's own
 * internal review" and "a storefront refinement rejected its own input" are
 * different facts, and the honest version of hiding something is being able
 * to say exactly what was hidden and why.
 */
const INTERNAL_BECAUSE: ReadonlyMap<string, string> = new Map([
  [EXECUTION_ACTIONS.STORE_REFINE_STOREFRONT, "a storefront refinement rejected its own generated input - a bug report, not something the owner can act on"],
  [EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE, "J4's own internal review bookkeeping"],
  [EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE, "a chat turn, which is a conversation and not a fault"],
  [EXECUTION_ACTIONS.GENESIS_DRAFT_MESSAGE, "a draft-mode chat turn"],
]);

/**
 * What an owner can do about one failed or stalled execution.
 *
 * `basePath` scopes the destination to the business being looked at. The
 * legacy "/dashboard/..." spelling resolves the ACCOUNT'S ACTIVE business, so
 * a row followed without rebasing can move the owner to a DIFFERENT business
 * than the one whose Office they are standing in - a hazard J4Surface already
 * documents for Decisions. sectionHref is the one rebasing rule; this does not
 * add a second.
 */
export function officeActionForExecution(
  row: { action: string; message: string },
  basePath: string,
): OfficeAction {
  const internal = INTERNAL_BECAUSE.get(row.action);
  if (internal) return { kind: "internal", because: internal };

  const destination = OWNER_FACING.get(row.action);
  if (destination) {
    return { kind: "open", label: destination.label, href: sectionHref(destination.section, basePath) };
  }

  // The default is INTERNAL, not "show it anyway".
  //
  // This is the whole point of the inversion. An execution action nobody has
  // given a destination is, by definition, something the owner has nowhere to
  // go about - so surfacing it produces exactly the dead row this module
  // exists to remove. A new action becomes owner-facing by being added to
  // OWNER_FACING deliberately, never by existing.
  return {
    kind: "internal",
    because: `no owner destination is defined for "${row.action}", so it is a bug report rather than business intelligence`,
  };
}

/**
 * A decision the owner can genuinely settle from where they are standing.
 *
 * Approve runs the real thing: approveGenesisAction, the same server action
 * the conversation already uses. This is the one place in the Office where
 * the answer to "what can I do" is not "go to a page" but "decide it here",
 * which is what Sean means by a decision having a path to action rather than
 * a link to a screen where the decision is repeated.
 */
export function officeActionForDecision(): OfficeAction {
  return {
    kind: "execute",
    label: "Approve",
    intent: "approve",
    offer: "decide",
    // ONE ACTION CARRYING BOTH ANSWERS, not two actions a caller has to
    // remember to keep together. It returned an ARRAY until 2026-09-11 and
    // nothing called it — buildBriefing built its own single action inline —
    // so the pair existed in this file and never reached a screen.
    //
    // "Reject", not "Not now". performRejectGenesisAction sets the row to
    // REJECTED and DELETES the recommendation behind it, specifically so it
    // stops nagging. "Not now" promises it will come back; it will not, and a
    // label that understates what a control does is the same class of problem
    // as a button that does nothing.
    alternatives: [{ label: "Reject", intent: "reject" }],
  };
}

/**
 * What an owner can do about something J4 merely explained.
 *
 * Explanations enter the Office with `href: null` hardcoded in J4Surface, and
 * all 158 of them render as dead rows. They are not a queue and never were -
 * an explanation is J4 telling the owner why something is the way it is. So
 * the honest action is none, WITH a reason, and the row stops pretending.
 *
 * When an explanation does carry a destination, it is used - the reason is the
 * fallback, not a blanket answer.
 */
export function officeActionForExplanation(
  explanation: { actionHref?: string | null },
  basePath: string,
): OfficeAction {
  if (explanation.actionHref) {
    return { kind: "open", label: "Open", href: sectionHref(explanation.actionHref, basePath) };
  }
  return { kind: "none", because: "J4 is explaining something it noticed. There is nothing to action here." };
}

/**
 * What an owner can do about an observation that already carries an href.
 *
 * Producers that set actionHref (getIntegrationIssues, operationalIssues) are
 * already right and this does not second-guess them - it rebases the legacy
 * spelling onto the business being viewed and nothing else.
 */
export function officeActionForObservation(
  observation: { actionHref?: string | null; summary: string },
  basePath: string,
): OfficeAction {
  if (observation.actionHref) {
    return { kind: "open", label: "Open", href: sectionHref(observation.actionHref, basePath) };
  }
  return {
    kind: "none",
    because: "J4 noticed this but has not found anywhere for you to act on it yet.",
  };
}

/**
 * What an owner can do about one open task.
 *
 * ============ THE ROW TYPE THIS MODULE NEVER GOVERNED (2026-09-11) =====
 *
 * Every other Office row has been through here since the 198 fake buttons
 * were removed. Tasks were not. They were mapped straight from the database
 * row - `href: t.actionHref` - and the Tasks view renders `because={t.because}`
 * against a field nothing has ever set, so that prop has always been
 * undefined.
 *
 * That gap is why an open task had no OfficeAction, which is why it could not
 * be placed in one of the five arrival sections, which is why the strip could
 * count three tasks the arrival surface never showed.
 *
 * NOT AN EXECUTE, DELIBERATELY. A Task carries `actionType` and `trustLevel`,
 * so it looks like something that could be run from here. Nothing in the
 * Office runs one today - the Tasks view offers navigation and nothing else -
 * and giving it a button because the column exists would be inventing the
 * lever Sean ruled out. When a task genuinely becomes executable it changes
 * here, once, and moves itself into READY TO GO.
 */
export function officeActionForTask(
  task: { actionHref?: string | null },
  basePath: string,
): OfficeAction {
  if (task.actionHref) {
    return { kind: "open", label: "Open", href: sectionHref(task.actionHref, basePath) };
  }
  return {
    kind: "none",
    because: "I am holding this for you. There is no screen I can send you to for it yet.",
  };
}

/**
 * The interaction affordance a row is allowed to wear.
 *
 * THIS LIVES HERE, NOT IN THE COMPONENT, ON PURPOSE. The 198 fake buttons were
 * a single shared class name inside CategoryRow: `hover:bg-white/[.04]` sat on
 * both branches, so an inert row lit up under a finger. No test could reach
 * that decision without a browser, which is how it survived.
 *
 * As a function of the action, it is three lines to test — and the hover can
 * only ever be attached to something that can actually be followed, because
 * the affordance is derived from the action rather than chosen beside it.
 */
export function rowInteractionClass(action: OfficeAction): string {
  return isInteractive(action) ? "transition hover:bg-white/[.04]" : "cursor-default";
}

/** Whether a class string offers a hover affordance. Exported so the suite can assert absence. */
export function offersHover(className: string): boolean {
  return /hover:/.test(className);
}

/** Exported for the suite: the destinations, so a test can prove each route exists. */
export function ownerFacingDestinations(): { action: string; section: string; label: string }[] {
  return [...OWNER_FACING].map(([action, d]) => ({ action, section: d.section, label: d.label }));
}

/** Exported for the suite: every action deliberately kept away from the owner. */
export function internalActions(): string[] {
  return [...INTERNAL_BECAUSE.keys()];
}

export { LEGACY_BUSINESS_BASE };
