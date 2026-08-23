import { prisma } from "@/lib/prisma";
import { getBusinessProfile } from "@/lib/businessModel/profile";
import { formatMoneyApprox } from "@/lib/money";
import { getUpcomingAppointments } from "@/lib/businessModel/reasoning";
import { communicateFinding } from "@/lib/execution/genesisAutonomy";
import { upsertObservation, resolveMissingObservations } from "@/lib/dashboard/genesisObservations";
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
  // The store's own currency for the revenue figure below. Read here rather
  // than added to BusinessProfile: nothing else in that shape is money, and
  // widening a profile used across several subsystems to carry one string for
  // one sentence is the wrong trade.
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { currency: true } });
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
        const amount = formatMoneyApprox(profile.revenue.allTimeInCents, store?.currency ?? "USD");
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

// Called unconditionally inside runCognitiveReview, right alongside the
// existing goal-trajectory "prediction" block — same real pattern: a
// fully deterministic per-item write (getConnectionGaps above makes zero
// AI call), superseding prior ACTIVE rows first, one communicateFinding()
// call per real gap. topicKey is scoped to "connection_gap:" specifically
// so this only ever supersedes its own prior rows, never another real
// opportunity-kind CognitiveOutput unrelated to connections.
/** The prefix these findings own, so a sweep only ever resolves its own rows. */
const CONNECTION_GAP_PREFIX = "connection_gap:";

export async function proposeConnectionGaps(storeId: string): Promise<void> {
  const gaps = await getConnectionGaps(storeId);

  await prisma.cognitiveOutput.updateMany({
    where: { storeId, status: "ACTIVE", topicKey: { startsWith: CONNECTION_GAP_PREFIX } },
    data: { status: "SUPERSEDED" },
  });

  for (const gap of gaps) {
    const topicKey = `${CONNECTION_GAP_PREFIX}${gap.provider}`;

    await communicateFinding(storeId, {
      kind: "opportunity",
      // J4'S OWN VOICE, not a report about J4 (fixed 2026-08-23). This read
      // `Genesis noticed ${gap.reason}` — and every reason above is already a
      // complete first-person sentence ending "…would let me help you…", so
      // the result switched person mid-sentence: Genesis noticed, and then I
      // would help you. The reason is the finding; nothing needs to introduce
      // it.
      summary: gap.reason,
      priority: "medium",
      confidence: 0.8,
      actionLabel: `Connect ${gap.name}`,
      actionHref: "/dashboard/connections",
      topicKey,
    });

    // AND AS A FINDING J4 CAN SAY OUT LOUD (2026-08-23).
    //
    // J4_IDENTITY.md freezes "how J4 asks for what it's missing" and names this
    // function as the one shipped instance of it. It was shipped where it could
    // not be heard: a CognitiveOutput surfaces on the Connections page, so the
    // ask only reached an owner who had already gone looking for it. The whole
    // point of the principle is asking at the moment the gap matters.
    //
    // Now it is also an observation, which is what Proactive J4 speaks — so the
    // frozen example sentence ("Would you like to connect QuickBooks so I can
    // understand profitability?") finally reaches the conversation.
    //
    // Written alongside rather than instead: the Connections page still reads
    // the CognitiveOutput, and this is the same finding in the representation
    // the conversation reads. Same summary, same topicKey, so the page and the
    // conversation cannot describe one gap two ways.
    //
    // "opportunity" is deliberate. A missing connection is never urgent — it
    // sits behind anything actually wrong, and Proactive J4's own ordering
    // already guarantees that.
    await upsertObservation(storeId, {
      dedupeKey: topicKey,
      genesisState: "opportunity",
      summary: gap.reason,
      actionHref: "/dashboard/connections",
    });
  }

  // A GAP THAT CLOSED STOPS BEING SAID. Connecting QuickBooks removes it from
  // getConnectionGaps, which resolves the observation — and resolving is what
  // releases Proactive J4 to mention it again if it ever comes back (a
  // disconnected integration is a real recurrence). Scoped to this prefix so it
  // never resolves another sweep's opportunity rows.
  await resolveMissingObservations(
    storeId,
    gaps.map((g) => `${CONNECTION_GAP_PREFIX}${g.provider}`),
    "opportunity",
    CONNECTION_GAP_PREFIX
  );
}
