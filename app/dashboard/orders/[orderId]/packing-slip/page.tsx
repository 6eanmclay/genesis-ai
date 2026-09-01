import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import { PackingSlip } from "../../PackingSlip";

// The legacy route, resolving the account's ACTIVE business — the same shape
// /dashboard/orders/[orderId] uses, and for the same reason.
export default async function PackingSlipPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const { store } = await requireStorePageAccess(PERMISSIONS.ORDERS_MANAGE);
  return <PackingSlip orderId={orderId} storeId={store.id} />;
}
