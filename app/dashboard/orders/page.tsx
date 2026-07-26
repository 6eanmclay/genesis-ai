import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, requireStorePageAccess } from "@/lib/permissions";
import { getOrderSummary } from "@/lib/dashboard/whatHappened";
import { OrderSummaryCard } from "../OrderSummaryCard";

const STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  refunded: "Refunded",
};

// List view only for beta — per-order detail/refund actions are a later
// pass (see the nav plan's explicit out-of-scope note). Amount is only
// selected from the DB at all when the viewer has REVENUE_VIEW, matching
// how getOrderSummary/getCustomerSummaries already gate revenue — not just
// hidden in the UI.
export default async function OrdersPage() {
  const { store, role } = await requireStorePageAccess(PERMISSIONS.ORDERS_VIEW);
  const canViewRevenue = hasPermission(role, PERMISSIONS.REVENUE_VIEW);

  const [summary, orders] = await Promise.all([
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
      },
    }),
  ]);

  return (
    <div className="min-h-screen p-8">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Orders</h1>

      <div className="mt-6 max-w-md">
        <OrderSummaryCard summary={summary} />
      </div>

      <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
        All orders
      </h2>
      {orders.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          No orders yet.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full max-w-3xl border-collapse text-sm">
            <thead>
              <tr className="border-b border-black/[.08] text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-white/[.145]">
                <th className="py-2 pr-4">Product</th>
                <th className="py-2 pr-4">Buyer</th>
                {canViewRevenue && <th className="py-2 pr-4">Amount</th>}
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Provider</th>
                <th className="py-2 pr-4">Date</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr
                  key={order.id}
                  className="border-b border-black/[.05] dark:border-white/[.08]"
                >
                  <td className="py-2 pr-4 text-black dark:text-zinc-50">{order.productName}</td>
                  <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{order.buyerEmail}</td>
                  {canViewRevenue && (
                    <td className="py-2 pr-4 text-black dark:text-zinc-50">
                      ${((order.amountInCents ?? 0) / 100).toFixed(2)}
                    </td>
                  )}
                  <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                    {STATUS_LABEL[order.status] ?? order.status}
                  </td>
                  <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                    {order.paymentProvider}
                  </td>
                  <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                    {order.createdAt.toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
