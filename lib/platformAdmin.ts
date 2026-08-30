import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAllowedPlatformAdmin } from "@/lib/platformAdminPolicy";

// The decision lives in lib/platformAdminPolicy so the verification harness can
// reach it — this module cannot be imported under tsx because of `server-only`,
// and an untestable authorization rule is the one worth testing. Re-exported so
// there is one implementation and callers need not know where it sits.
export { isAllowedPlatformAdmin };

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
export async function isPlatformAdmin(): Promise<boolean> {
  const session = await auth();
  return isAllowedPlatformAdmin(session?.user?.email, process.env.PLATFORM_ADMIN_EMAILS ?? "");
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

/**
 * The same gate, for a SERVER ACTION rather than a page.
 *
 * ============ A LAYOUT DOES NOT PROTECT AN ACTION (2026-08-30) ========
 *
 * app/admin/layout.tsx gates every page beneath it, and that is genuinely all
 * it gates. A server action is a POST endpoint with a generated id: anybody who
 * has that id can invoke it directly, with no page render and no layout in the
 * path. The UI is not the security boundary.
 *
 * This codebase already knows that — app/dashboard/actions.ts calls
 * requireStorePermission inside every action despite app/dashboard/layout.tsx
 * having its own gate — and platform-level actions need the same discipline.
 *
 * THROWS rather than redirects, unlike its page-facing sibling. A redirect is a
 * control-flow throw that reads as navigation; in an action, where the caller
 * may be a script rather than a browser, an explicit refusal is the honest
 * answer. The refusal is also recorded: somebody invoking a platform action
 * they have no claim to is not an accident.
 */
export async function assertPlatformAdmin(action: string): Promise<string> {
  const session = await auth();
  const userId = session?.user?.id ?? null;

  if (!(await isPlatformAdmin())) {
    const { recordSignal, SIGNAL_KINDS } = await import("@/lib/security/signals");
    await recordSignal({
      kind: SIGNAL_KINDS.authzDenied,
      severity: "critical",
      actorKind: userId ? "user" : "anonymous",
      actorId: userId,
      surface: `platformAction:${action}`,
      detail: { action, reason: "not a platform administrator" },
    });
    throw new Error("You don't have permission to do this.");
  }

  // Returned so the caller can attribute the act without asking again.
  return userId ?? "unknown";
}
