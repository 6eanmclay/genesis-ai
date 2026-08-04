import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";

// AI Cost & Usage Infrastructure, Milestone 6 — the platform-operator
// role this codebase has never needed before now (lib/permissions.ts is
// entirely per-store: StoreRole is OWNER | EMPLOYEE, structurally derived
// from Store.userId/StoreMember, with no third, cross-store role). An env
// var allowlist, not a new User column — the real requirement today is
// "Sean only," which needs no migration and no chicken-and-egg "who
// flips the first admin's flag" problem a database-backed flag would
// have. Swappable later for a real column or table behind this one
// function — see the AI Cost & Usage Infrastructure plan's own open
// decision #2 — without touching any caller.
function platformAdminEmails(): Set<string> {
  const raw = process.env.PLATFORM_ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

export async function isPlatformAdmin(): Promise<boolean> {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email) return false;
  return platformAdminEmails().has(email);
}

// Same "redirect, don't return a boolean" shape requireStorePermission/
// requireStorePageAccess already use (lib/permissions.ts) — a page that
// calls this either continues with a real admin session or never renders
// at all, same discipline every other gated page in this codebase
// already follows.
export async function requirePlatformAdmin(): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  if (!(await isPlatformAdmin())) {
    redirect("/dashboard");
  }
}
