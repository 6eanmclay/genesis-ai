import { PERMISSIONS, requireBusinessPage } from "@/lib/permissions";
import { PackingSlip } from "@/app/dashboard/orders/PackingSlip";

// The packing slip for one order, in the business named in the URL.
//
// requireBusinessPage re-checks access here rather than trusting the layout,
// and PackingSlip reads the order store-scoped — so an order id belonging to
// another business cannot be printed by pasting it into this route.
//
// ORDERS_MANAGE rather than ORDERS_VIEW: this sheet exists to be acted on, and
// a role that may look at orders without handling them has no use for it.
export default async function PackingSlipPage({
  params,
}: {
  params: Promise<{ slug: string; orderId: string }>;
}) {
  const { slug, orderId } = await params;
  const { store } = await requireBusinessPage(PERMISSIONS.ORDERS_MANAGE, slug);
  return <PackingSlip orderId={orderId} storeId={store.id} />;
}
