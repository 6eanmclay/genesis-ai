import { PERMISSIONS, hasPermission, requireStorePageAccess } from "@/lib/permissions";
import { getCustomerSummaries } from "@/lib/dashboard/customers";
import { CustomersList } from "../CustomersList";

export default async function CustomersPage() {
  const { store, role } = await requireStorePageAccess(PERMISSIONS.ORDERS_VIEW);
  const canViewRevenue = hasPermission(role, PERMISSIONS.REVENUE_VIEW);

  const customers = await getCustomerSummaries(store.id, { includeRevenue: canViewRevenue, limit: 100 });

  return (
    <div className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Customers</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Derived from your order history — {customers.length} customer
        {customers.length === 1 ? "" : "s"} so far.
      </p>
      <div className="mt-4 max-w-md">
        <CustomersList customers={customers} />
      </div>
    </div>
  );
}
