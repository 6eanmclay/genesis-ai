import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { OrderDetail } from "../OrderDetail";

// The legacy route, resolving the account's ACTIVE business — the same shape
// /dashboard/orders itself uses, and for the same reason: existing links point
// here and keep working until every screen has moved to /b/[slug].

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const { store, role } = await requireStorePageAccess(PERMISSIONS.ORDERS_VIEW);

  return (
    <OrderDetail
      orderId={orderId}
      storeId={store.id}
      role={role}
      basePath={LEGACY_BUSINESS_BASE}
    />
  );
}
