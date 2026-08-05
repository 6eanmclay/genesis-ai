import { getBusinessProfile } from "@/lib/businessModel/profile";
import { getUpcomingAppointments } from "@/lib/businessModel/reasoning";
import { CONNECTOR_CATALOG, type ConnectionCategory } from "./catalog";

// Integrations (Chapter 4) — real, business-state-grounded connection
// recommendations, replacing the static recommendedFor-only filter that
// previously drove /dashboard/connections' "Recommended for your
// business" section. Pure Understand-layer function: deterministic, zero
// AI call, same shape as every other real Understand function in this
// codebase — a connection gap is a computed fact, not something that
// needs the model's own judgment to notice.
//
// Deliberately requires real evidence (real revenue, real customers, a
// real appointment-based category with zero synced appointments) for
// every entry — a business-category match alone is never sufficient on
// its own; that was the old static list's entire (weak) signal, now used
// only as supporting context alongside genuine evidence.
export interface ConnectionGap {
  provider: string;
  catalogId: string;
  name: string;
  category: ConnectionCategory;
  reason: string;
}

export async function getConnectionGaps(storeId: string): Promise<ConnectionGap[]> {
  const profile = await getBusinessProfile(storeId);
  const connectedProviders = new Set(
    profile.connectedSystems.filter((s) => s.status === "CONNECTED").map((s) => s.provider)
  );
  const categorySlugs = new Set(profile.classification.businessCategories.map((c) => c.slug));

  const gaps: ConnectionGap[] = [];

  for (const entry of CONNECTOR_CATALOG) {
    // Only real, working connectors — never a "coming soon" stub, and
    // never one that's already connected.
    if (!entry.provider || !entry.connector) continue;
    if (connectedProviders.has(entry.provider)) continue;

    const categoryMatch = entry.recommendedFor.some((slug) => categorySlugs.has(slug));
    let reason: string | null = null;

    if (entry.provider === "QUICKBOOKS") {
      if (profile.revenue.allTimeInCents > 0) {
        const amount = (profile.revenue.allTimeInCents / 100).toLocaleString(undefined, {
          style: "currency",
          currency: "USD",
        });
        reason = `${amount} in real revenue on record with no accounting system connected yet — connecting QuickBooks would let me help you understand your real numbers.`;
      }
    } else if (entry.provider === "MAILCHIMP") {
      const count = profile.customers.totalContactCount;
      if (count > 0) {
        reason = `${count} real customer${count === 1 ? "" : "s"} on record with no email marketing platform connected yet — connecting Mailchimp would let me help you stay in touch with them.`;
      }
    } else if (entry.provider === "GOOGLE_CALENDAR") {
      if (categoryMatch) {
        const appointments = await getUpcomingAppointments(storeId);
        if (appointments.length === 0) {
          reason =
            "businesses like yours usually run on real appointments, and I don't see a calendar connected yet — connecting Google Calendar would let me help you see and talk about your real schedule.";
        }
      }
    }

    if (!reason) continue;

    gaps.push({ provider: entry.provider, catalogId: entry.id, name: entry.name, category: entry.category, reason });
  }

  return gaps;
}
