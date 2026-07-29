import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import { DEFAULT_THEME, themeCssVars, type Theme } from "@/lib/theme";

// Product Vision Phase 1 — business identity (name/tagline/description,
// brand story/mission/etc., and the update_brand_identity/
// update_store_identity approval experience) all moved to Brand
// (app/dashboard/brand/page.tsx), their real home — see
// lib/execution/genesisActions.ts's ACTION_SECTIONS. Settings genuinely has
// no other content yet: there's no account/employee-management UI in this
// codebase today. Beta polish pass (v22): reworded so this reads as a
// deliberate "nothing to configure yet" state (matching the calm, honest
// empty-state voice used elsewhere — Orders' "No orders yet," Customers'
// "No customers yet") rather than an unfinished stub — still no new
// functionality, just copy.
export default async function SettingsPage() {
  const { store } = await requireStorePageAccess(PERMISSIONS.STORE_MANAGE);
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Settings</h1>
      <p className="mt-2 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
        Nothing to configure here yet — your business identity (name, tagline,
        brand story) lives on the Identity page. Account and workspace
        settings will appear here as they become available.
      </p>
    </div>
  );
}
