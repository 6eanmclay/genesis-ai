// Type-only import — erased by the compiler, so this file has zero runtime
// dependency on lib/permissions.ts (which imports prisma). That matters
// because DashboardShell.tsx, a client component, imports NAV_SECTIONS/
// MOBILE_TAB_COUNT from here directly: a real (non-type) import of
// anything from lib/permissions.ts — including just its PERMISSIONS
// object, since it lives in the same module as the prisma import — would
// drag prisma/pg into the browser bundle and crash on Node-only modules
// like `dns`. Permission values below are therefore the literal wire
// strings (kept in sync with lib/permissions.ts's PERMISSIONS object by
// the Permission type). The actual role-filtering (which does need the
// real hasPermission value) lives in app/dashboard/layout.tsx instead — a
// server component, where that's safe.
import type { Permission } from "@/lib/permissions";

// The single ordered list the app shell renders its nav from — adding a
// future section (e.g. Automation/Workflows) is one new entry here, not a
// change to the shell, the layout, or the routing pattern. `permission:
// null` means every role that can reach the dashboard at all sees it
// (currently just Home).
export interface NavSection {
  key: string;
  label: string;
  href: string;
  permission: Permission | null;
}

// Orders deliberately isn't a primary nav destination right now — it
// surfaces contextually on Home instead (recent orders, positively framed)
// since the page itself is just a list with no dedicated workflow yet. The
// route (`app/dashboard/orders/page.tsx`) and its data are untouched and
// still reachable directly; removing it here only affects the nav list.
export const NAV_SECTIONS: NavSection[] = [
  { key: "home", label: "Home", href: "/dashboard", permission: null },
  { key: "website", label: "Website", href: "/dashboard/website", permission: "store:manage" },
  { key: "products", label: "Products", href: "/dashboard/products", permission: "products:manage" },
  { key: "customers", label: "Customers", href: "/dashboard/customers", permission: "orders:view" },
  { key: "marketing", label: "Marketing", href: "/dashboard/marketing", permission: "store:manage" },
  { key: "payments", label: "Payments", href: "/dashboard/payments", permission: "payments:manage" },
  { key: "analytics", label: "Analytics", href: "/dashboard/analytics", permission: "analytics:view" },
  { key: "settings", label: "Settings", href: "/dashboard/settings", permission: "store:manage" },
];

// The top N sections shown directly in the mobile bottom tab bar; the rest
// live behind "More". Kept as a slice of NAV_SECTIONS (not a separate list)
// so a new section inserted above still flows correctly without a second
// edit.
export const MOBILE_TAB_COUNT = 4;
