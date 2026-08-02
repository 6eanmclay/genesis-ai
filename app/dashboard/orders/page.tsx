import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, requireStorePageAccess } from "@/lib/permissions";
import { getOrderSummary } from "@/lib/dashboard/whatHappened";
import { OrderSummaryCard } from "../OrderSummaryCard";
import { OrdersList, type OrderRow } from "../OrdersList";
import { DEFAULT_THEME, themeCssVars, type Theme } from "@/lib/theme";
import type { OrderShippingAddress } from "@/lib/orders/shippingAddress";

// Owner-experience milestone — real shipping address + a manual fulfillment
// workflow, both now real (see lib/execution/executables/orders.ts). Amount
// is only selected from the DB at all when the viewer has REVENUE_VIEW,
// matching how getOrderSummary/getCustomerSummaries already gate revenue —
// not just hidden in the UI.
export default async function OrdersPage() {
  const { store, role } = await requireStorePageAccess(PERMISSIONS.ORDERS_VIEW);
  const canViewRevenue = hasPermission(role, PERMISSIONS.REVENUE_VIEW);
  const canManage = hasPermission(role, PERMISSIONS.ORDERS_MANAGE);

  const [summary, rawOrders] = await Promise.all([
    getOrderSummary(store.id, { includeRevenue: canViewRevenue }),
    prisma.order.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        productName: true,
        buyerEmail: true,
        status: true,
        paymentProvider: true,
        createdAt: true,
        amountInCents: canViewRevenue,
        fulfillmentStatus: true,
        shippingAddress: true,
      },
    }),
  ]);
  const orders: OrderRow[] = rawOrders.map((order) => ({
    id: order.id,
    productName: order.productName,
    buyerEmail: order.buyerEmail,
    amountInCents: canViewRevenue ? ((order.amountInCents as number | null) ?? 0) : null,
    status: order.status,
    paymentProvider: order.paymentProvider,
    createdAt: order.createdAt,
    fulfillmentStatus: order.fulfillmentStatus,
    shippingAddress: order.shippingAddress as OrderShippingAddress | null,
  }));
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Orders</h1>

      <div className="mt-6 max-w-md">
        <OrderSummaryCard summary={summary} />
      </div>

      <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
        All orders
      </h2>
      <OrdersList orders={orders} canViewRevenue={canViewRevenue} canManage={canManage} />
    </div>
  );
}
