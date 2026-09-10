import { formatMoney } from "@/lib/money";
import type { BusinessUnderstanding } from "@/lib/businessModel/understanding";
import type { UnderstandingGroup } from "@/app/j4/J4Workspace";

/**
 * WHAT J4 UNDERSTANDS, SHAPED FOR THE OFFICE.
 *
 * ============ MOVED OUT OF J4Surface (2026-09-09) ======================
 *
 * Not a refactor for tidiness. getBusinessUnderstanding is the single most
 * expensive read on the Office path - 921ms measured against production, where
 * the whole rest of the critical path is 167ms - and it sat inside the awaited
 * Promise.all that renders the shell. So every owner waited most of a second
 * for a picture most of them were not about to open, on EVERY dashboard page,
 * because the layer pays the same cost.
 *
 * Sean's tier for it is on-demand: "anything that only needs to load after I
 * open/interact with it". Living here lets the server action load it when the
 * Understanding view is actually opened, without the component that renders
 * the Office importing a 900ms dependency to do it.
 *
 * The mapping itself is unchanged. This is the same material as
 * /dashboard/understanding, from the same call - there is one answer to "what
 * does J4 know", and a second assembly of the same facts would be free to
 * drift from it.
 */

// The store's own currency, threaded rather than assumed. These lines are read
// back to the owner as what J4 understands about their business, so a figure
// carrying the wrong symbol is a claim about which money the business takes.
const formatCents = formatMoney;

function formatDate(value: string | Date): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function trendArrow(direction: "up" | "down" | "flat" | undefined): string {
  return direction === "up" ? "↑" : direction === "down" ? "↓" : "—";
}

export function toUnderstandingGroups(u: BusinessUnderstanding, currency: string): UnderstandingGroup[] {
  const { profile, beliefs, recentDecisions, activeThoughts, platformRelationship, currentAssets } = u;

  const identity: string[] = [];
  identity.push(profile.identity.tagline ? `${profile.identity.name} — ${profile.identity.tagline}` : profile.identity.name);
  if (profile.identity.description) identity.push(profile.identity.description);
  const classification = [
    ...profile.classification.businessCategories.map((c) => c.label),
    ...profile.classification.revenueStreams.map((r) => r.label),
  ];
  if (classification.length > 0) identity.push(classification.join(" · "));

  const offerings: string[] = [
    `${profile.offerings.activeCount} active product${profile.offerings.activeCount === 1 ? "" : "s"}`,
    ...profile.offerings.trends
      .filter((t) => t.trend !== null)
      .slice(0, 3)
      .map((t) => `${trendArrow(t.trend?.direction)} ${t.item.data.name} — ${Math.round((t.trend?.changeRatio ?? 0) * 100)}%`),
  ];

  const people: string[] = [];
  if (profile.people.owner) people.push(`${profile.people.owner.name ?? profile.people.owner.email} — Owner`);
  for (const m of profile.people.members) people.push(`${m.name ?? m.email} — ${m.role}`);
  for (const e of profile.people.employees) {
    people.push(`${e.data.name}${e.data.title ? ` — ${e.data.title}` : ""}${e.data.status === "former" ? " (former)" : ""}`);
  }

  const goals: string[] = [
    ...profile.goals.map((g) => `Goal (${g.data.status}) — ${g.data.description}`),
    ...profile.challenges.map((c) => `Challenge (${c.data.status}) — ${c.data.description}`),
  ];

  return [
    { key: "identity", label: "Identity", lines: identity, empty: "I don't have your business identity yet." },
    {
      // What J4 can point at by name. This is the visible proof that a
      // designated asset resolves to a real record rather than a URL on a
      // column — if "brand.logo" appears here, "that logo" has something to
      // mean.
      key: "assets",
      label: "Assets I can use",
      lines: Object.entries(currentAssets).map(
        ([role, asset]) => `${role} — ${asset.summary ?? asset.originalFilename}${asset.origin ? ` (${asset.origin})` : ""}`
      ),
      empty: "Nothing designated yet. Generated and uploaded files become usable assets once they have a role.",
    },
    { key: "offerings", label: "What you sell", lines: offerings, empty: "Nothing in the catalog yet." },
    {
      key: "revenue",
      label: "Revenue",
      lines: [
        `Last 30 days — ${formatCents(profile.revenue.last30DaysInCents, currency)}`,
        `All time — ${formatCents(profile.revenue.allTimeInCents, currency)}`,
      ],
      empty: "No revenue recorded yet.",
    },
    {
      key: "customers",
      label: "Customers",
      lines: [
        `${profile.customers.totalContactCount} known contact${profile.customers.totalContactCount === 1 ? "" : "s"}`,
        `Repeat ${profile.customers.segments.repeatCustomers.length} ${trendArrow(profile.customers.segmentTrends.repeatCustomers?.direction)} · ` +
          `High-value ${profile.customers.segments.highValueCustomers.length} ${trendArrow(profile.customers.segmentTrends.highValueCustomers?.direction)} · ` +
          `Lapsed ${profile.customers.segments.lapsedCustomers.length} ${trendArrow(profile.customers.segmentTrends.lapsedCustomers?.direction)} · ` +
          `New ${profile.customers.segments.newCustomers.length} ${trendArrow(profile.customers.segmentTrends.newCustomers?.direction)}`,
      ],
      empty: "No customers yet.",
    },
    { key: "people", label: "People", lines: people, empty: "Just you so far." },
    {
      key: "suppliers",
      label: "Suppliers",
      lines: profile.suppliers.map((s) => `${s.data.name}${s.data.email ? ` — ${s.data.email}` : ""}`),
      empty: "None known yet. Mention one in conversation and I'll remember it.",
    },
    {
      key: "locations",
      label: "Locations",
      lines: profile.locations.map(
        (l) => `${l.data.name}${l.data.city ? ` — ${l.data.city}${l.data.state ? `, ${l.data.state}` : ""}` : ""}`
      ),
      empty: "None known yet.",
    },
    { key: "goals", label: "Goals and challenges", lines: goals, empty: "Nothing stated yet. Tell me a goal and I'll hold onto it." },
    {
      key: "assets",
      label: "Business assets",
      lines: profile.assets.map(
        (a) =>
          `${a.data.originalFilename}${a.data.category === "unclassified" ? " — not yet reviewed" : ` — ${a.data.category.replace(/_/g, " ")}`}` +
          `${a.data.summary ? `: ${a.data.summary}` : ""}`
      ),
      empty: "Nothing uploaded yet.",
    },
    {
      key: "systems",
      label: "Connected systems",
      lines: profile.connectedSystems.map(
        (s) => `${s.displayName} — ${s.status}${s.syncedAgoLabel ? ` — synced ${s.syncedAgoLabel}${s.isStale ? " (stale)" : ""}` : ""}`
      ),
      empty: "Nothing connected yet.",
    },
    {
      key: "beliefs",
      label: "What I've learned",
      lines: beliefs.map((b) => `${b.claim} — ${Math.round(b.confidence * 100)}% confidence, ${b.maturity.replace(/_/g, " ")}`),
      empty: "Nothing yet. Beliefs form once a real pattern repeats.",
    },
    {
      key: "decisions",
      label: "Recent decisions",
      lines: recentDecisions.map((d) => `${d.decision === "executed" ? "✓" : "✕"} ${d.summary} — ${formatDate(d.decidedAt)}`),
      empty: "Nothing in the last two weeks.",
    },
    {
      key: "open",
      label: "Still open",
      lines: activeThoughts.slice(0, 5).map((t) => t.summary),
      empty: "Nothing open right now.",
    },
    {
      key: "platform",
      label: "Your relationship with Genesis",
      lines: [
        `${platformRelationship.planName ?? "No plan"} — ${platformRelationship.growthPointBalance} Growth Points`,
        ...(platformRelationship.subscriptionStatus ? [platformRelationship.subscriptionStatus] : []),
        ...(platformRelationship.businessPartnerTrialEndsAt
          ? [`Business Partner trial ends ${formatDate(platformRelationship.businessPartnerTrialEndsAt)}`]
          : []),
      ],
      empty: "No plan yet.",
    },
  ];
}
