import { PERMISSIONS, requireBusinessPage } from "@/lib/permissions";
import { businessBasePath } from "@/lib/dashboard/navConfig";
import { OrderDetail } from "@/app/dashboard/orders/OrderDetail";

// One order, in the business named in the URL.
//
// requireBusinessPage re-checks access here rather than trusting the layout,
// and OrderDetail reads the order store-scoped — so an order id belonging to
// another business cannot be opened by pasting it into this route.

export default async function BusinessOrderDetailPage({
  params,
}: {
  params: Promise<{ slug: string; orderId: string }>;
}) {
  const { slug, orderId } = await params;
  const { store, role } = await requireBusinessPage(PERMISSIONS.ORDERS_VIEW, slug);

  return (
    <OrderDetail
      orderId={orderId}
      storeId={store.id}
      role={role}
      basePath={businessBasePath(slug)}
    />
  );
}
