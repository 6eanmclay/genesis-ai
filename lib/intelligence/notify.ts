import {
  upsertObservation,
  resolveMissingObservations,
} from "@/lib/dashboard/genesisObservations";
import type { Insight } from "./insights";

// Phase 3 Milestone 3 — Part 5, Notifications. Deliberately not a new
// table: this is a thin mapping layer onto Phase 4's existing
// GenesisObservation (real dedup, real auto-resolve, a real UI surface
// already built) rather than a duplicate notification system.
//
// A real, separate, HIGHER bar than "worth mentioning to the
// Recommendation Engine" — the Insight Engine's own thresholds
// (lib/intelligence/insights.ts) already gate what counts as an insight
// at all; this is a second gate on top, so only the insights that should
// become an ambient Red/Purple badge do. Insights that don't cross this
// bar still reach generateGenesisRecommendations.ts's prompt context and
// may still produce a GeneratedRecommendation — just never an ambient
// signal — preserving Phase 4's "Purple/Red stays narrow and high-signal"
// discipline rather than diluting it with routine sync noise.
const NOTIFY_WORTHY: Partial<Record<string, (insight: Insight) => boolean>> = {
  "revenue.decreased": (i) => Math.abs(i.metrics.change as number) >= 0.25,
  "revenue.increased": (i) => Math.abs(i.metrics.change as number) >= 0.25,
  "engagement.declined": (i) => Math.abs(i.metrics.change as number) >= 0.25,
  "invoices.overdue": () => true, // the Insight Engine's own bar (3+) already is the notify bar
  "inventory.depleted": () => true, // even one depleted item is always notify-worthy
  "appointments.cancellations_up": () => true, // "doubled" is already a high bar
  // engagement.improved / revenue.increased below 25% / anything else not
  // listed here: real, but stays in the Recommendation Engine's context
  // only — never an ambient badge.
};

const INSIGHT_PREFIX = "insight:";

// Called once per store per scheduler cycle, after the Insight Engine
// (lib/intelligence/insights.ts) has produced this cycle's insights.
export async function notifyFromInsights(storeId: string, insights: Insight[]): Promise<void> {
  const worthy = insights.filter((i) => (NOTIFY_WORTHY[i.type] ?? (() => false))(i));

  await Promise.all(
    worthy.map((insight) =>
      upsertObservation(storeId, {
        dedupeKey: `${INSIGHT_PREFIX}${insight.type}`,
        genesisState: insight.severity,
        summary: insight.summary,
        actionHref: null,
      })
    )
  );

  // Resolved per genesisState, matching resolveMissingObservations' own
  // shape — an insight that used to be "urgent" (e.g. revenue.decreased)
  // and a different one that's "opportunity" (e.g. revenue.increased)
  // never share a dedupeKey (the type itself already disambiguates), but
  // the resolve call is still scoped per state, same as every other sweep.
  for (const state of ["urgent", "opportunity"] as const) {
    const stillActive = worthy
      .filter((i) => i.severity === state)
      .map((i) => `${INSIGHT_PREFIX}${i.type}`);
    await resolveMissingObservations(storeId, stillActive, state, INSIGHT_PREFIX);
  }
}
