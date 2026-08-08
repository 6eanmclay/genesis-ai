import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { Store, StoreRole } from "@prisma/client";

// Canonical permission names — call sites always use PERMISSIONS.X, never a
// raw string, so the list can grow without scattered typo-prone literals.
export const PERMISSIONS = {
  STORE_MANAGE: "store:manage",
  PRODUCTS_MANAGE: "products:manage",
  ORDERS_VIEW: "orders:view",
  // Owner-experience milestone — processing an order (marking it fulfilled)
  // is an operational task, same tier as PRODUCTS_MANAGE, so it's granted to
  // EMPLOYEE below too, unlike PAYMENTS_MANAGE's owner-only financial scope.
  ORDERS_MANAGE: "orders:manage",
  REVENUE_VIEW: "revenue:view",
  // Reserved for future use — nothing reads these yet, but the vocabulary
  // exists so later phases only need to wire a permission into a new
  // action, not invent one.
  ANALYTICS_VIEW: "analytics:view",
  PAYMENTS_MANAGE: "payments:manage",
  EMPLOYEES_MANAGE: "employees:manage",
  GENESIS_CHAT: "genesis:chat",
  // Phase 6 — governs granting/revoking DelegatedAuthority (letting Genesis
  // act on a class of action without asking first). Deliberately separate
  // from STORE_MANAGE: "can edit store content" and "can change what
  // Genesis may do unsupervised" are different-stakes decisions. OWNER-only,
  // same as EMPLOYEES_MANAGE — never granted to EMPLOYEE.
  AUTHORITY_MANAGE: "authority:manage",
  // Phase 3 Milestone 2 — connecting/managing third-party business software
  // (Google Calendar, QuickBooks, Mailchimp, ...). OWNER-only by omission
  // from ROLE_PERMISSIONS.EMPLOYEE below, matching PAYMENTS_MANAGE's own
  // precedent — one flat flag for now, not per-provider granularity (a
  // calendar connection and a bank-adjacent one differ in real stakes, but
  // this codebase's permission model is deliberately coarse everywhere
  // else too; revisit only if a real need for finer grain shows up).
  CONNECTIONS_MANAGE: "connections:manage",
  // Chapter 5 (Payments) — the owner's own real money moving TO Genesis
  // (Growth Point purchases, plan subscriptions, billing/account
  // management), distinct from PAYMENTS_MANAGE (the store's own outbound
  // payment-provider connections, money flowing FROM the store's
  // customers). OWNER-only by omission from ROLE_PERMISSIONS.EMPLOYEE
  // below, same precedent as PAYMENTS_MANAGE/CONNECTIONS_MANAGE.
  BILLING_MANAGE: "billing:manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ROLE_PERMISSIONS: Record<StoreRole, Permission[]> = {
  OWNER: Object.values(PERMISSIONS),
  EMPLOYEE: [
    PERMISSIONS.PRODUCTS_MANAGE,
    PERMISSIONS.ORDERS_VIEW,
    PERMISSIONS.ORDERS_MANAGE,
    PERMISSIONS.GENESIS_CHAT,
  ],
};

export function hasPermission(role: StoreRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

// Pure resolution, never throws — OWNER is derived from Store.userId (the
// owner is never given a literal StoreMember row), EMPLOYEE (and any future
// non-owner role) comes from StoreMember. Returns null for anyone with
// neither, which is exactly what a customer/rando is today.
export async function getStoreRole(
  userId: string,
  storeId: string
): Promise<StoreRole | null> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { userId: true },
  });
  if (!store) return null;
  if (store.userId === userId) return "OWNER";

  const membership = await prisma.storeMember.findUnique({
    where: { storeId_userId: { storeId, userId } },
    select: { role: true },
  });
  return membership?.role ?? null;
}

// Finds "the" store for a user (owner-first, then employee membership) —
// mirrors the app's existing one-store-per-user assumption, just now also
// recognizing employees who don't own a store themselves. Never throws;
// returns null when the user has no store yet, which is a normal state
// (a brand new signup), not an error — callers that need to require access
// should use requireStorePermission instead.
//
// 2026-08-08 — real header-identity staleness investigation: Store.userId
// carries no unique constraint, and confirmStoreDraftCore (onboarding's
// real store-creation path, reachable from three separate flows) never
// checks for an existing store before creating one — so the "one store
// per user" comment above is this app's real intent, not a DB-enforced
// guarantee. The unordered findFirst this replaced picked whichever row
// Postgres happened to return first, which is only ever safe if that
// intent perfectly held. orderBy makes this deterministic regardless —
// the most recently updated store is "the" one every caller (both the J4
// Portal header and the main dashboard's own DashboardShell, which share
// this exact function) resolves and displays, rather than an arbitrary,
// possibly stale row. A no-op when the invariant does hold.
export async function resolveUserStore(
  userId: string
): Promise<{ store: Store; role: StoreRole } | null> {
  const owned = await prisma.store.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } });
  if (owned) return { store: owned, role: "OWNER" };

  const membership = await prisma.storeMember.findFirst({
    where: { userId },
    include: { store: true },
  });
  if (membership) return { store: membership.store, role: membership.role };

  return null;
}

// The single chokepoint every protected route, server action, and (per the
// user's explicit design requirement) Genesis-driven action should call
// instead of hand-rolling a `findFirst({ where: { userId } })` ownership
// check. Pass `storeId` when the caller already has a specific store in
// hand (e.g. resolved from a productId); omit it to resolve "the" store
// for the current user, same as resolveUserStore.
export async function requireStorePermission(
  permission: Permission,
  storeId?: string
): Promise<{ userId: string; storeId: string; store: Store; role: StoreRole }> {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  const userId = session.user.id;

  let store: Store | null;
  let role: StoreRole | null;

  if (storeId) {
    store = await prisma.store.findUnique({ where: { id: storeId } });
    role = store ? await getStoreRole(userId, storeId) : null;
  } else {
    const resolved = await resolveUserStore(userId);
    store = resolved?.store ?? null;
    role = resolved?.role ?? null;
  }

  if (!store || !role) {
    throw new Error("Store not found");
  }
  if (!hasPermission(role, permission)) {
    throw new Error("You don't have permission to do this.");
  }

  return { userId, storeId: store.id, store, role };
}

// The page-rendering counterpart to requireStorePermission: every dashboard
// section route (Orders, Products, Settings, etc.) calls this once at the
// top instead of hand-rolling the same auth -> resolve -> permission-check
// sequence. Unlike requireStorePermission, this never throws — a page with
// no store yet or a role lacking the section's permission is redirected
// back to /dashboard (the onboarding/Home entry point) rather than shown an
// error boundary, since "you can't be here" is a routing fact for a page
// view, not an exceptional failure the way a rejected action is.
export async function requireStorePageAccess(
  permission: Permission | null
): Promise<{ userId: string; store: Store; role: StoreRole }> {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const resolved = await resolveUserStore(session.user.id);
  if (!resolved) {
    redirect("/dashboard");
  }
  if (permission && !hasPermission(resolved.role, permission)) {
    redirect("/dashboard");
  }

  return { userId: session.user.id, store: resolved.store, role: resolved.role };
}
