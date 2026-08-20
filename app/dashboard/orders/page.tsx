import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { OrdersWorkspace } from "./OrdersWorkspace";

// The legacy route. Resolves the account's ACTIVE business and renders the same
// screen /b/[slug]/orders renders. Preserved rather than redirected: existing
// links, bookmarks and emails point here, and it keeps working until every
// screen has moved.

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ integration_error?: string; integration_connected?: string }>;
}) {
  const { integration_error: integrationError, integration_connected: integrationConnected } =
    await searchParams;
  const { store, role } = await requireStorePageAccess(PERMISSIONS.ORDERS_VIEW);

  return (
    <OrdersWorkspace
      store={store}
      role={role}
      basePath={LEGACY_BUSINESS_BASE}
      integrationError={integrationError}
      integrationConnected={integrationConnected}
    />
  );
}
