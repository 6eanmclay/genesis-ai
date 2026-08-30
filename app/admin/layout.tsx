import { requirePlatformAdmin } from "@/lib/platformAdmin";

// AI Cost & Usage Infrastructure, Milestone 6 — the internal, Genesis-team-
// only surface, structurally separate from app/dashboard/ (every store
// owner's own space) since this is platform-operator tooling, not
// something any store owner should ever reach. Every PAGE under here
// inherits this one gate, same "gate once at the layout" shape
// app/dashboard/layout.tsx relies on for its own permission model.
//
// ============ AND ONLY PAGES (corrected 2026-08-30) ==================
//
// This comment used to say a route added later needed no check of its own.
// That is true of pages and false of SERVER ACTIONS, which is a dangerous
// place to be wrong: an action is a POST endpoint with a generated id, and
// anybody holding that id can invoke it with no page render and no layout
// anywhere in the path. A platform action must call assertPlatformAdmin
// itself — see app/admin/operations/actions.ts — exactly as
// app/dashboard/actions.ts re-checks permission under its own gated layout.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformAdmin();
  return <div className="min-h-screen bg-zinc-50 dark:bg-black">{children}</div>;
}
