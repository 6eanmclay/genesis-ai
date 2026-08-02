import { PERMISSIONS, hasPermission, requireStorePageAccess } from "@/lib/permissions";
import { getCustomerSummaries, getOrdersByEmail } from "@/lib/dashboard/customers";
import {
  getCustomerSegments,
  getCustomerSegmentTrend,
  type CustomerSegments,
  type CustomerSegmentTrends,
} from "@/lib/businessModel/reasoning";
import { CustomersList } from "../CustomersList";
import { DEFAULT_THEME, themeCssVars, type Theme } from "@/lib/theme";

// Presentation-layer join, not a data-layer merge: getCustomerSummaries and
// getCustomerSegments are two independent, already-working stacks (a real,
// deferred cleanup, not this pass's job) — this just maps each summary's
// email to whichever segment lists it appears in.
function buildSegmentsByEmail(segments: CustomerSegments): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (contacts: CustomerSegments["repeatCustomers"], label: string) => {
    for (const { contact } of contacts) {
      const email = contact.data.email;
      if (!email) continue;
      const existing = map.get(email) ?? [];
      existing.push(label);
      map.set(email, existing);
    }
  };
  add(segments.repeatCustomers, "Repeat");
  add(segments.highValueCustomers, "High-value");
  add(segments.lapsedCustomers, "Lapsed");
  add(segments.newCustomers, "New");
  return map;
}

// One real, deterministic, Genesis-voiced sentence built entirely from real
// numbers already in scope — never AI-generated, matching the Insight
// Engine's own discipline. Picks the most notable real trend, honestly
// falling back to a calm statement of current composition when nothing
// trend-worthy exists.
function describeCustomerHealth(
  segments: CustomerSegments,
  trend: CustomerSegmentTrends,
  totalCount: number
): string {
  if (trend.repeatCustomers && trend.repeatCustomers.direction !== "flat") {
    const verb = trend.repeatCustomers.direction === "up" ? "grown" : "shrunk";
    return `Your repeat customer base has ${verb} from ${trend.repeatCustomers.previousValue} to ${trend.repeatCustomers.currentValue} this week.`;
  }
  if (trend.lapsedCustomers && trend.lapsedCustomers.direction === "up") {
    return `${trend.lapsedCustomers.currentValue} customers have gone quiet recently, up from ${trend.lapsedCustomers.previousValue} last week.`;
  }
  if (segments.repeatCustomers.length > 0) {
    return `${segments.repeatCustomers.length} of your ${totalCount} customer${totalCount === 1 ? "" : "s"} have ordered more than once.`;
  }
  return `${totalCount} customer${totalCount === 1 ? "" : "s"} so far — none have ordered a second time yet.`;
}

export default async function CustomersPage() {
  const { store, role } = await requireStorePageAccess(PERMISSIONS.ORDERS_VIEW);
  const canViewRevenue = hasPermission(role, PERMISSIONS.REVENUE_VIEW);

  const [customers, segments, segmentTrend, ordersByEmail] = await Promise.all([
    getCustomerSummaries(store.id, { includeRevenue: canViewRevenue, limit: 100 }),
    getCustomerSegments(store.id),
    getCustomerSegmentTrend(store.id),
    getOrdersByEmail(store.id, { includeRevenue: canViewRevenue }),
  ]);
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;
  const segmentsByEmail = buildSegmentsByEmail(segments);
  const healthSentence = describeCustomerHealth(segments, segmentTrend, customers.length);

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Customers</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{healthSentence}</p>
      <div className="mt-4 max-w-md">
        <CustomersList customers={customers} segmentsByEmail={segmentsByEmail} ordersByEmail={ordersByEmail} />
      </div>
    </div>
  );
}
