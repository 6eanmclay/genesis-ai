import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import { Finances } from "./Finances";

// The legacy route, resolving the account's ACTIVE business.
//
// REVENUE_VIEW, matching every other surface that shows what a business earns.
// A role that may not see revenue must not learn it from a payout instead —
// which is exactly the shape of leak that gating one screen and forgetting its
// sibling produces.
export default async function FinancesPage() {
  const { store } = await requireStorePageAccess(PERMISSIONS.REVENUE_VIEW);
  return <Finances store={store} />;
}
