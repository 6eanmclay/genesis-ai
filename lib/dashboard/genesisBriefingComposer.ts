import { prisma } from "@/lib/prisma";
import { getRevenue } from "@/lib/businessModel/reasoning";
import { getNewCustomerCountSince } from "./customers";

// Daily Operating Rhythm — the real "since you were last here" anchor is
// the previous briefing composition itself, not a literal per-page-load
// timestamp. A literal every-visit anchor would make the very next
// composition's own window trivially short (minutes), producing a near-
// empty change-set almost every time; tying it to the ~24h composition
// cadence (see runOpportunisticAiReviewIfStale's own staleness gate) keeps
// the window meaningful by construction. Any status, not just ACTIVE — a
// superseded prior briefing still genuinely marks "when Genesis last spoke."
export async function getPreviousBriefingAnchor(storeId: string): Promise<Date | null> {
  const previous = await prisma.cognitiveOutput.findFirst({
    where: { storeId, kind: "briefing" },
    orderBy: { generatedAt: "desc" },
    select: { generatedAt: true },
  });
  return previous?.generatedAt ?? null;
}

export interface OwnerBriefingChangeSet {
  // False only on the very first composition for this store — the composer
  // treats this as a real, distinct "no prior visit to compare against"
  // case, never a fabricated "nothing changed" reading of an empty window.
  hasPriorAnchor: boolean;
  sinceIso: string | null;
  orderCount: number;
  revenueDeltaInCents: number;
  newCustomerCount: number;
  // Real BusinessEvent rows (connector activity — invoices, appointments,
  // campaigns) since the anchor, newest first, capped — each summary is
  // already real human-readable text (see changeDetection.ts's own writers).
  recentBusinessEvents: { summary: string; occurredAt: string }[];
}

const MAX_BUSINESS_EVENTS = 15;

export async function getChangeSetSince(
  storeId: string,
  since: Date | null
): Promise<OwnerBriefingChangeSet> {
  if (!since) {
    return {
      hasPriorAnchor: false,
      sinceIso: null,
      orderCount: 0,
      revenueDeltaInCents: 0,
      newCustomerCount: 0,
      recentBusinessEvents: [],
    };
  }

  const [orderCount, revenueDeltaInCents, newCustomerCount, businessEvents] = await Promise.all([
    prisma.order.count({ where: { storeId, createdAt: { gte: since } } }),
    getRevenue(storeId, { since }),
    getNewCustomerCountSince(storeId, since),
    prisma.businessEvent.findMany({
      where: { storeId, occurredAt: { gte: since } },
      orderBy: { occurredAt: "desc" },
      take: MAX_BUSINESS_EVENTS,
      select: { summary: true, occurredAt: true },
    }),
  ]);

  return {
    hasPriorAnchor: true,
    sinceIso: since.toISOString(),
    orderCount,
    revenueDeltaInCents,
    newCustomerCount,
    recentBusinessEvents: businessEvents.map((e) => ({
      summary: e.summary,
      occurredAt: e.occurredAt.toISOString(),
    })),
  };
}
