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

export interface NavSection {
  key: string;
  label: string;
  href: string;
  permission: Permission | null;
}

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
// Orders deliberately isn't a primary nav destination — it surfaces
// contextually on Your Business instead (recent orders, positively framed)
// since the page itself is just a list with no dedicated workflow yet. The
// route (`app/dashboard/orders/page.tsx`) and its data are untouched and
// still reachable directly, just unlinked from nav.
export const NAV_SECTIONS: NavSection[] = [
  { key: "home", label: "Your Business", href: "/dashboard", permission: null },
  { key: "customers", label: "Customers", href: "/dashboard/customers", permission: "orders:view" },
  { key: "marketing", label: "Marketing", href: "/dashboard/marketing", permission: "store:manage" },
  { key: "payments", label: "Payments", href: "/dashboard/payments", permission: "payments:manage" },
  { key: "analytics", label: "Analytics", href: "/dashboard/analytics", permission: "analytics:view" },
  { key: "settings", label: "Settings", href: "/dashboard/settings", permission: "store:manage" },
];

// The first N of NAV_SECTIONS shown inline as real primary destinations;
// the rest render under one permanent "More" — at every breakpoint, not
// just mobile (renamed from MOBILE_TAB_COUNT: this now governs desktop
// too, since the whole point of this correction is that primary nav stays
// exactly this small regardless of viewport width, not just on narrow
// screens — there is deliberately no wider-screen tier that shows
// everything inline again).
export const PRIMARY_TAB_COUNT = 2;

// Secondary navigation, shown only while inside Your Business — only the
// real, currently-shipped workspaces, nothing speculative (no "Socials"
// placeholder). "Identity" is the user-facing word; the key/route/data
// underneath (app/dashboard/brand) is unchanged, so badge counts and the
// nav icon (both keyed by "brand" — see ACTION_SECTIONS/NavIcon) need no
// further changes. "Overview" shares Your Business's own href — clicking
// either lands on the same page, matching "the primary tab always returns
// you to Overview."
export const YOUR_BUSINESS_SECTIONS: NavSection[] = [
  { key: "overview", label: "Overview", href: "/dashboard", permission: null },
  { key: "brand", label: "Identity", href: "/dashboard/brand", permission: "store:manage" },
  { key: "website", label: "Website", href: "/dashboard/website", permission: "store:manage" },
  { key: "products", label: "Products", href: "/dashboard/products", permission: "products:manage" },
];
