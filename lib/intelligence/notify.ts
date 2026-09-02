import {
  upsertObservation,
  resolveMissingObservations,
} from "@/lib/dashboard/genesisObservations";
import type { Insight } from "./insights";
import { prisma } from "@/lib/prisma";

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
  // M4 — already governed twice before it reaches here: evaluateStorefront
  // only reports a finding when one is really true, and the storefront
  // suggestion gate decides whether J4 may raise it at all (cooldown,
  // previously-rejected, learned preference). A third threshold on top would
  // be a second governor disagreeing with the first, not more restraint.
  "storefront.readiness": () => true,
  // engagement.improved / revenue.increased below 25% / anything else not
  // listed here: real, but stays in the Recommendation Engine's context
  // only — never an ambient badge.
};

const INSIGHT_PREFIX = "insight:";

// Called once per store per scheduler cycle, after the Insight Engine
// (lib/intelligence/insights.ts) has produced this cycle's insights.
/**
 * The record an insight named, but only if it is really there and really ours.
 *
 * ============ THE INSIGHT ENGINE IS NOT A TRUST BOUNDARY, AND THIS IS ====
 *
 * Tier 1's ids come from `runCognitiveReview`, which had already checked them
 * against `BusinessRecord where { id, storeId, entityType }`. An insight's id
 * has had no such check: it is read off a record a detector queried, and a
 * detector is one bug or one deletion away from an id that no longer exists,
 * or -- through a mis-scoped query -- one belonging to another store. Writing
 * a cross-tenant id into an observation would put one business's finding onto
 * another business's entity card.
 *
 * A failed check drops THE LINK, never the observation: the owner still hears
 * that something is out of stock, it simply is not pinned to a record we could
 * not confirm.
 */
async function verifiedRecord(
  storeId: string,
  insight: Insight,
): Promise<{ recordId: string | null; entityType: string | null }> {
  const none = { recordId: null, entityType: null };
  if (!insight.recordId || !insight.entityType) return none;

  const row = await prisma.businessRecord.findFirst({
    where: { id: insight.recordId, storeId, entityType: insight.entityType },
    select: { id: true },
  });
  return row ? { recordId: insight.recordId, entityType: insight.entityType } : none;
}

export async function notifyFromInsights(storeId: string, insights: Insight[]): Promise<void> {
  const worthy = insights.filter((i) => (NOTIFY_WORTHY[i.type] ?? (() => false))(i));

  await Promise.all(
    worthy.map(async (insight) =>
      upsertObservation(storeId, {
        // UNCHANGED IDENTITY. The dedupeKey is still the insight's type alone,
        // so the same real condition remains the same row whether or not it
        // could name a record this cycle.
        dedupeKey: `${INSIGHT_PREFIX}${insight.type}`,
        genesisState: insight.severity,
        summary: insight.summary,
        actionHref: null,
        ...(await verifiedRecord(storeId, insight)),
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
