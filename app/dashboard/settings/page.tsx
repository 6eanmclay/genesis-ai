import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";

// Product Vision Phase 1 — business identity (name/tagline/description,
// brand story/mission/etc., and the update_brand_identity/
// update_store_identity approval experience) all moved to Brand
// (app/dashboard/brand/page.tsx), their real home — see
// lib/execution/genesisActions.ts's ACTION_SECTIONS. Settings genuinely has
// no other content yet: there's no account/employee-management UI in this
// codebase today. Left honest rather than padded — a real future
// account/app-configuration surface belongs here when one exists.
export default async function SettingsPage() {
  await requireStorePageAccess(PERMISSIONS.STORE_MANAGE);

  return (
    <div className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Settings</h1>
      <p className="mt-2 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
        Account and app-level settings will live here. Your business identity
        moved to Brand.
      </p>
    </div>
  );
}
