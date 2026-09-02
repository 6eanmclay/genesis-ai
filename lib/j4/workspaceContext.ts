import { legacyPathFor } from "@/lib/dashboard/navConfig";

// What the owner is currently looking at (2026-08-14).
//
// The second half of Sean's correction to J4's mental model. The first half
// was structural — J4 is a layer over the workspace, not a page you navigate
// to (see app/dashboard/J4Overlay.tsx). This is the half that makes that
// worth anything: "J4 should receive the current workspace context so
// statements like 'this,' 'that,' 'this mission statement,' 'this product,'
// or 'this image' can be resolved from what the owner is currently viewing."
//
// A partner standing next to you does not ask which mission statement you
// mean. Because J4 now opens over the workspace instead of replacing it, the
// owner can be looking at something while asking about it — so J4 has to be
// told what that something is, or the whole arrangement is theatre.
//
// A CLOSED REGISTRY, for the same reason lib/storefront/targets.ts is one.
// The path arrives from the browser, and whatever comes out of here is
// concatenated into a model prompt. An unrecognised path resolves to null and
// J4 is simply told nothing — the client's own string is never interpolated
// into a prompt, so a crafted path cannot become instructions.

export interface WorkspaceContext {
  /** The owner's own word for this place, matching the nav label exactly. */
  label: string;
  /** What is genuinely on this screen. Kept factual — J4 quotes from it. */
  showing: string;
}

// Keys are real routes. Kept deliberately in step with lib/dashboard/
// navConfig.ts's own hrefs; a route with nothing useful to say about what is
// on it is better left out than described vaguely.
const WORKSPACES = {
  "/dashboard": {
    label: "Your Business",
    showing: "the business home: what J4 has noticed, and any decisions waiting on the owner",
  },
  "/dashboard/brand": {
    label: "Identity",
    showing: "the business identity: the business name, its description, and its brand and creative direction",
  },
  "/dashboard/website": {
    // "Storefront", not "Website" (2026-08-22). The room bar has said Storefront
    // since 2026-08-15; J4 was still telling owners they were looking at a place
    // whose name is nowhere on their screen.
    label: "Storefront",
    showing: "the storefront canvas: the live storefront and the sections it is built from",
  },
  "/dashboard/studio": {
    // Added 2026-08-22. Studio joined the room bar on 2026-08-16 and was never
    // added here, so J4 was blind in it from the day it shipped.
    label: "Studio",
    showing: "the studio: the piece being made, and the alternatives beside it",
  },
  "/dashboard/products": {
    label: "Products",
    showing: "the product catalog: each product's name, description, price and images",
  },
  "/dashboard/catalog": {
    // Added 2026-08-22, same omission as Studio. Deliberately described as what
    // COULD be sold: reading it as inventory is the exact confusion its own
    // section comment exists to prevent.
    label: "What you could sell",
    showing: "products Genesis suggests the business could add, which are not in the catalog yet",
  },
  "/dashboard/finances": {
    // Added 2026-09-02, found the same way as Promotions below and by the
    // same suite. The nav has called this Money since the merchant
    // financials work; J4 knew no such place, so being sent here was being
    // sent somewhere it could not describe.
    label: "Money",
    showing: "what the business has earned and what has been paid out to it",
  },
  "/dashboard/access": {
    label: "Access",
    showing: "who can get into this business and what each of them is allowed to do",
  },
  "/dashboard/promotions": {
    // Added 2026-09-02, the same omission as Studio and Catalog before it, and
    // found the same way — by a suite that finally had a runner. J4 can create
    // and update a promotion, so it has to know what the owner is looking at
    // when it sends them here.
    label: "Promotions",
    showing: "the discounts and offers this business is running, and the codes customers enter",
  },
  "/dashboard/customers": {
    label: "Customers",
    showing: "the customer list and what each customer has bought",
  },
  "/dashboard/orders": {
    label: "Orders",
    showing: "the orders that have come in and where each one stands",
  },
  "/dashboard/marketing": {
    label: "Marketing",
    showing: "the marketing workspace: campaigns and the audience they reach",
  },
  "/dashboard/payments": {
    label: "Payments",
    showing: "how the business gets paid: its payment provider connections",
  },
  "/dashboard/analytics": {
    // "Revenue" is what the section is called inside Commerce; "Analytics" is
    // what the route is called. J4 says the owner's word.
    label: "Revenue",
    showing: "the business numbers: revenue, orders and how they are trending",
  },
  "/dashboard/connections": {
    label: "Connections",
    showing: "the third party software connected to the business",
  },
  "/dashboard/growth-points": {
    label: "Growth Points",
    showing: "the Growth Points balance, what has been spent, and on what",
  },
  "/dashboard/billing": {
    label: "Billing",
    showing: "the owner's own Genesis plan and billing",
  },
  "/dashboard/settings": {
    label: "Settings",
    showing: "the store settings",
  },
  "/dashboard/understanding": {
    label: "Understanding",
    showing: "what J4 currently understands about the business, in J4's own words",
  },
} as const satisfies Record<string, WorkspaceContext>;

export type WorkspacePath = keyof typeof WORKSPACES;

/**
 * Resolves a browser-supplied path to a known workspace, or null.
 *
 * Exact match only, and deliberately so. A path like /dashboard/products/abc
 * resolves to nothing rather than to Products, because saying "the owner is
 * viewing the product catalog" when they are actually on one product's own
 * page would be a confident, wrong answer to "what is this product?" Saying
 * nothing leaves J4 to ask, which is the behaviour that was already agreed
 * (J4 asks for what it is missing).
 */
export function resolveWorkspaceContext(path: unknown): WorkspaceContext | null {
  if (typeof path !== "string") return null;
  // Strip a query string or hash before matching. "?focus=..." is a real,
  // routine part of these URLs (see app/dashboard/layout.tsx's focusHref) and
  // should never cost the owner their context.
  const pathname = path.split(/[?#]/)[0];
  // THEN normalise the business out of it (2026-08-22).
  //
  // Business-in-the-URL shipped 2026-08-20 and moved every owner from
  // /dashboard/website to /b/<slug>/website. This registry is keyed by the
  // legacy paths and matched exactly, so from that day J4 resolved NOTHING on
  // any route an owner actually used: "make this bolder" stopped being a
  // complete sentence everywhere at once, silently, with no error anywhere.
  //
  // Normalise-then-match, NOT a looser matcher. Which business the owner is in
  // has no bearing on what kind of screen they are looking at, so the base is
  // dropped and the exact match below is left exactly as strict as it was.
  // Relaxing it to a prefix match would "fix" this too — and would make
  // /b/x/products/abc resolve to the product catalog, which is the confident
  // wrong answer this whole file exists to refuse.
  const normalized = legacyPathFor(pathname);
  if (!Object.prototype.hasOwnProperty.call(WORKSPACES, normalized)) return null;
  return WORKSPACES[normalized as WorkspacePath];
}

/**
 * The single line handed to the model, or null when the workspace is unknown.
 *
 * Two instructions, both load bearing. The first is the whole point: resolve
 * "this" against what is on screen. The second exists because presence is not
 * a topic — an owner who summons J4 while standing on Orders to ask about
 * something else entirely must not have their question quietly rewritten into
 * a question about orders.
 */
export function describeWorkspaceForJ4(path: unknown): string | null {
  const workspace = resolveWorkspaceContext(path);
  if (!workspace) return null;
  return `(The owner is looking at ${workspace.label} right now, which shows ${workspace.showing}. If they say "this," "that," or name something without saying which one, they most likely mean what is in front of them here. Being here is not itself the subject: do not steer the conversation toward this screen if they are asking about something else.)`;
}
