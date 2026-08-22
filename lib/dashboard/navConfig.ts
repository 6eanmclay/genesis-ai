// Type-only import — erased by the compiler, so this file has zero runtime
// dependency on lib/permissions.ts (which imports prisma). That matters
// because DashboardShell.tsx, a client component, imports NAV_SECTIONS/
// YOUR_BUSINESS_SECTIONS/PRIMARY_TAB_COUNT from here directly: a real
// (non-type) import of anything from lib/permissions.ts — including just
// its PERMISSIONS object, since it lives in the same module as the prisma
// import — would drag prisma/pg into the browser bundle and crash on
// Node-only modules like `dns`. Permission values below are therefore the
// literal wire strings (kept in sync with lib/permissions.ts's PERMISSIONS
// object by the Permission type). The actual role-filtering (which does
// need the real hasPermission value) lives in app/dashboard/layout.tsx
// instead — a server component, where that's safe.
import type { Permission } from "@/lib/permissions";

// Entries with no route of their own. The shell renders these as buttons
// rather than Links: Account opens the account sheet in place.
export const ACCOUNT_SENTINEL_HREF = "#account";
export function isSentinelHref(href: string): boolean {
  return href.startsWith("#");
}

export interface NavSection {
  key: string;
  label: string;
  href: string;
  permission: Permission | null;
}

// ROOMS, NOT TABS (2026-08-15). The primary navigation is the four business
// rooms, with J4 permanently in the centre. See GENESIS_SURFACES.md, which is
// the locked architecture and the reason this file looks the way it does.
//
//     Storefront | Studio | (J4 / Office) | Commerce | Account
//
// FIVE slots. The centre is the J4/Office room — the orb with its Office label
// beneath it, rendered by J4Summon rather than from this list, which is why
// there is no "office" entry here and must never be one. Studio sits beside
// Storefront because it is the workshop that feeds the storefront.
//
// J4 IS NOT IN THIS LIST AND MUST NEVER BE ADDED TO IT. J4 is the partner who
// comes with the owner, not a place they go. The orb is rendered by
// DashboardShell/J4Summon, not by the nav registry, and the Office is reached
// through the control beneath the orb — never through a tab. An "Office" entry
// here is the single most likely way to break the architecture, because it is
// the tab every owner would read as "the J4 tab."
//
// Arrival is not a room either. /dashboard stays the opening screen — the
// business overview and J4's briefing — and the owner lands there rather than
// navigating back to it. That is why "Your Business" is gone from this list
// while its route is very much alive.
//
// STUDIO JOINED 2026-08-16. It was held out of this list for exactly as long
// as it had no route, because a tab that opens nothing is the one thing ruled
// out here. It has real capability behind it now, verified end to end.
//
// Everything after PRIMARY_TAB_COUNT is the account area, not a business room:
// settings, billing, and the provider connections. These are configured, not
// visited. Customers and Analytics are here only until the Orders room absorbs
// them as sections inside it — per the architecture they belong to Orders, and
// their presence in the overflow is a staging post, not a decision.
//
// ---- history, kept because it explains the shape this replaced ----
// Product Vision navigation correction — two levels, not one flat list.
// Primary nav stays intentionally small and durable: it represents broad,
// permanent business concepts the owner actually thinks about (or, for
// More, "everything else, for now") — never one entry per feature or
// capability. Website/Products/Identity used to be separate primary
// destinations; they now live one level down, inside Your Business (see
// YOUR_BUSINESS_SECTIONS below) — same routes, same functionality, just no
// longer competing for a permanent top-level slot. A new capability should
// not automatically earn a new primary entry here — it's evaluated as a
// secondary workspace or a Genesis-contextual capability first (see
// ARCHITECTURE.md).
//
// Business Portal Phase 1 polish (2026-08-08) — Orders promoted to a real
// primary nav destination. Previously deliberately unlinked (reachable
// only by direct URL) on the reasoning that it was "just a list with no
// dedicated workflow yet" — reversed on Sean's own explicit call: order
// processing is core enough to a daily command-center experience that it
// shouldn't be hidden behind a URL a real owner would never guess. Nothing
// else here was reordered or promoted — see PRIMARY_TAB_COUNT's own
// comment for why Marketing/Analytics/etc. stay in More for now.
export const NAV_SECTIONS: NavSection[] = [
  // The rooms. The first PRIMARY_TAB_COUNT entries, and the only entries the
  // owner should ever think of as places in their business.
  //
  // Storefront is the live website AND brand identity: "Identity" was never a
  // destination an owner asked for, it is how the storefront looks. The route
  // stays /dashboard/website; /dashboard/brand becomes a section inside this
  // room rather than a peer of it.
  // Order matters and is Sean's (2026-08-15):
  //
  //     Storefront | Orders | (J4 / Office) | Products | Account
  //
  // The centre slot is not in this list and never will be — it is J4 himself,
  // rendered by J4Summon, with the Office door beneath him. Orders sits to his
  // left because it is the room with live, time-sensitive material in it, and
  // Products to his right.
  { key: "website", label: "Storefront", href: "/dashboard/website", permission: "store:manage" },
  // Commerce (2026-08-17) — Products and Orders consolidated into one room.
  // Sean: "the goal is navigation consolidation, not rebuilding those
  // systems", so every route underneath is unchanged and both become sections
  // (see COMMERCE_SECTIONS). Selling and fulfilling are one job to an owner;
  // they were two tabs because they are two tables.
  { key: "studio", label: "Studio", href: "/dashboard/studio", permission: "store:manage" },
  { key: "commerce", label: "Commerce", href: "/dashboard/orders", permission: "orders:view" },
  // Account is a real primary destination (Sean, 2026-08-17), not overflow. A
  // sentinel because it opens the account sheet in place rather than
  // navigating: everything inside it — settings, billing, connections,
  // payments, Growth Points — is configured, not visited.
  { key: "account", label: "Account", href: ACCOUNT_SENTINEL_HREF, permission: null },

  // ---- account area, below the fold. Not rooms. ----
  // Customers and Analytics used to sit here as staging posts. They are
  // sections inside the Orders room now (see ORDERS_SECTIONS), which is where
  // the architecture always put them: an owner meets a customer by way of an
  // order, and revenue is what orders mean.
  { key: "marketing", label: "Marketing", href: "/dashboard/marketing", permission: "store:manage" },
  { key: "payments", label: "Payments", href: "/dashboard/payments", permission: "payments:manage" },
  // Phase 3 Milestone 2 — connecting third-party business software.
  // Deliberately separate from Payments: Payments is "how you get paid,"
  // already shipped and stable; Connections covers everything else
  // (calendars, accounting, marketing, CRM, ...).
  { key: "connections", label: "Connections", href: "/dashboard/connections", permission: "connections:manage" },
  // Growth Points Economy (Chapter 2) — the owner's own balance/history/
  // usage/referral view. analytics:view, matching what kind of information
  // this is (read-mostly, financial-ish), same permission as Analytics.
  { key: "growth-points", label: "Growth Points", href: "/dashboard/growth-points", permission: "analytics:view" },
  // Understanding is gone from here (2026-08-16). It is a view inside the
  // Office now, which is where J4's accumulated knowledge of the business
  // belongs. /dashboard/understanding remains a real route — nothing links to
  // it, and the Office reads the same getBusinessUnderstanding() call, so
  // there is one answer to "what does J4 know" rather than two that can drift.
  // Chapter 5 (Payments) — the owner's OWN account/subscription with
  // Genesis, deliberately named "Billing" not "Payments": that name is
  // already taken by the merchant's own outbound payment-provider
  // connections above (how the store gets paid by ITS customers — money
  // flowing IN). This is the opposite direction — money flowing FROM the
  // owner TO Genesis — hence the separate BILLING_MANAGE permission.
  { key: "billing", label: "Billing", href: "/dashboard/billing", permission: "billing:manage" },
  { key: "settings", label: "Settings", href: "/dashboard/settings", permission: "store:manage" },
];

// The first N of NAV_SECTIONS shown inline as real primary destinations;
// the rest render under one permanent "More" — at every breakpoint, not
// just mobile (renamed from MOBILE_TAB_COUNT: this now governs desktop
// too, since the whole point of this correction is that primary nav stays
// exactly this small regardless of viewport width, not just on narrow
// screens — there is deliberately no wider-screen tier that shows
// everything inline again). Raised from 2 to 3 (2026-08-08) specifically
// to admit Orders — Marketing/Payments/Analytics/Connections/Growth
// Points/Billing/Settings all stay under More by deliberate choice, not
// yet revisited.
// The four LINK tabs, two either side of the J4/Office centre. A new
// capability earns a section inside a room, never another tab.
export const PRIMARY_TAB_COUNT = 4;

// Secondary navigation, shown only while inside Your Business — only the
// real, currently-shipped workspaces, nothing speculative (no "Socials"
// placeholder). "Identity" is the user-facing word; the key/route/data
// underneath (app/dashboard/brand) is unchanged, so badge counts and the
// nav icon (both keyed by "brand" — see ACTION_SECTIONS/NavIcon) need no
// further changes. "Overview" shares Your Business's own href — clicking
// either lands on the same page, matching "the primary tab always returns
// you to Overview."
// Sections INSIDE the Storefront room (2026-08-15, renamed from
// YOUR_BUSINESS_SECTIONS now that Your Business is not a destination).
//
// The Storefront room is the live website and the brand identity together,
// because identity is how the storefront looks — splitting them was an
// administrative distinction, never an owner's. These two are sections of one
// room, not peers in the navigation.
//
// What left this list and why:
//   Overview      → the arrival screen. Not a section, not a room.
//   Products      → its own room now.
//   Understanding → belongs to the Office; parked in the account overflow
//                   above until the Office can hold it.
//
// This is a room's contents, so keep it that way: a new *capability* inside
// the storefront may earn a section here. A new destination does not.
export const STOREFRONT_SECTIONS: NavSection[] = [
  { key: "website", label: "Storefront", href: "/dashboard/website", permission: "store:manage" },
  { key: "brand", label: "Identity", href: "/dashboard/brand", permission: "store:manage" },
];

// Sections INSIDE the Orders room — the business ledger (2026-08-15).
//
// Orders, the customers those orders came from, and what they add up to. These
// were three peers in a flat feature list, which is how software organises
// itself rather than how an owner thinks: nobody opens a customer table cold,
// they wonder who bought something. Revenue is likewise not a separate
// discipline, it is what orders mean once you total them.
//
// Fulfillment is deliberately absent. It is not a page — it is what you do TO
// an order, and it already lives on the order itself (buy a label, mark it
// shipped). Giving it a section would be inventing a destination to make the
// list look symmetrical.
export const COMMERCE_SECTIONS: NavSection[] = [
  { key: "orders", label: "Orders", href: "/dashboard/orders", permission: "orders:view" },
  { key: "products", label: "Products", href: "/dashboard/products", permission: "products:manage" },
  // What you COULD sell, next to what you do. Deliberately its own section
  // rather than a tab inside Products: one is the shelf as it stands and the
  // other is what Genesis thinks should be on it, and folding the second into
  // the first would make a recommendation look like inventory.
  { key: "catalog", label: "What you could sell", href: "/dashboard/catalog", permission: "products:manage" },
  { key: "customers", label: "Customers", href: "/dashboard/customers", permission: "orders:view" },
  { key: "analytics", label: "Revenue", href: "/dashboard/analytics", permission: "analytics:view" },
];

/** @deprecated superseded by COMMERCE_SECTIONS; kept until callers move. */
export const ORDERS_SECTIONS: NavSection[] = [
  { key: "orders", label: "Orders", href: "/dashboard/orders", permission: "orders:view" },
  { key: "customers", label: "Customers", href: "/dashboard/customers", permission: "orders:view" },
  { key: "analytics", label: "Revenue", href: "/dashboard/analytics", permission: "analytics:view" },
];

// Which sections belong to which room. The shell picks the list for whichever
// room the owner is standing in — a room shows its own sections and no others.
//
// A room with one section shows no section row at all, which is correct:
// Products is a catalogue and Studio is a workbench, and neither is improved
// by a row containing its own name.
export const ROOM_SECTIONS: NavSection[][] = [STOREFRONT_SECTIONS, COMMERCE_SECTIONS];

// --- Business-scoped paths (Phase A, 2026-08-20) ---------------------------
//
// The hrefs above are absolute `/dashboard/...` because for as long as an
// account held one business there was only one place a section could be. With
// the business in the route (BUSINESS_CONTEXT.md) the same section lives at
// `/b/<slug>/...`, and the shell has to render whichever one it is inside.
//
// Deliberately a transformation of the existing list rather than a second list.
// Two lists of sections would drift, and the one that drifted would be the one
// nobody was looking at.

/** Where the dashboard lived before the business was in the route. */
export const LEGACY_BUSINESS_BASE = "/dashboard";

/** The root of a business's own dashboard. */
export function businessBasePath(slug: string): string {
  return `/b/${slug}`;
}

/**
 * Move one href onto a given base — pure.
 *
 * Sentinels (`#account`) are returned untouched: they are not routes, and
 * prefixing one would turn a button that opens a sheet into a dead link.
 */
export function sectionHref(href: string, basePath: string): string {
  if (isSentinelHref(href)) return href;
  if (basePath === LEGACY_BUSINESS_BASE) return href;
  if (href === LEGACY_BUSINESS_BASE) return basePath;
  if (href.startsWith(`${LEGACY_BUSINESS_BASE}/`)) {
    return `${basePath}${href.slice(LEGACY_BUSINESS_BASE.length)}`;
  }
  // Anything that was never under /dashboard — the storefront, an external
  // link — is left alone. Rebasing those would break them.
  return href;
}

/** The same sections, addressed within one business. */
export function sectionsFor(sections: NavSection[], basePath: string): NavSection[] {
  return sections.map((section) => ({ ...section, href: sectionHref(section.href, basePath) }));
}

/**
 * The inverse of sectionHref: which section a business-scoped path IS.
 *
 * `/b/iron-gym/orders` → `/dashboard/orders`, `/b/iron-gym` → `/dashboard`.
 * A path that is already legacy, or was never a dashboard route at all, comes
 * back untouched.
 *
 * WHY THIS LIVES HERE rather than as a regex wherever it is needed. The shape
 * of a business path is stated exactly once, in businessBasePath, and this is
 * the only other place that has to know it. A second spelling somewhere else
 * would be the mirrored-registry problem in miniature — two rules about the
 * same URL shape, and the one that drifts is the one nobody is looking at.
 *
 * DELIBERATELY NOT a canonicaliser: it moves the base and nothing else. The
 * remainder is returned exactly as given, including any deeper segments, so a
 * caller matching against a closed registry still gets to refuse
 * `/dashboard/products/abc` on its own terms. Loosening that here would turn
 * every consumer into a prefix matcher without any of them asking for it.
 */
export function legacyPathFor(path: string): string {
  if (!path.startsWith("/b/")) return path;
  const rest = path.slice("/b/".length);
  const slash = rest.indexOf("/");
  // "/b/" alone, or "/b//orders" — no slug, so not a business path.
  const slug = slash === -1 ? rest : rest.slice(0, slash);
  if (slug.length === 0) return path;
  const remainder = slash === -1 ? "" : rest.slice(slash);
  // "/b/iron-gym" and "/b/iron-gym/" are both the business's own root.
  if (remainder === "" || remainder === "/") return LEGACY_BUSINESS_BASE;
  return `${LEGACY_BUSINESS_BASE}${remainder}`;
}
