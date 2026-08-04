import { requirePlatformAdmin } from "@/lib/platformAdmin";

// AI Cost & Usage Infrastructure, Milestone 6 — the internal, Genesis-team-
// only surface, structurally separate from app/dashboard/ (every store
// owner's own space) since this is platform-operator tooling, not
// something any store owner should ever reach. Every route under here
// inherits this one gate — a route added later needs no per-page check of
// its own, same "gate once at the layout" shape app/dashboard/layout.tsx
// itself already relies on for its own permission model.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformAdmin();
  return <div className="min-h-screen bg-zinc-50 dark:bg-black">{children}</div>;
}
