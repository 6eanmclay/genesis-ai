import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { declaredRead } from "@/lib/businessModel/declaredReads";
import { withJ4CopyRules } from "@/lib/j4CopyRules";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getRevenue } from "@/lib/businessModel/reasoning";
import { getNewCustomerCountSince } from "./customers";
import { callGenesisModel } from "@/lib/genesisModel";

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
    declaredRead(
      "windowed",
      "revenue since the previous briefing — the canonical model carries last-30-days and all-time, and 'since you were last here' is neither",
      () => getRevenue(storeId, { since })
    ),
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

export interface OwnerBriefingFreshOutput {
  kind: "explanation" | "recommendation" | "opportunity";
  summary: string;
  priority: "high" | "medium" | "low" | null;
}

export interface OwnerBriefingGoalTrajectory {
  description: string;
  onTrack: boolean;
  actualSoFarInCents: number;
  targetValueInCents: number;
  paceRatio: number;
}

const OwnerBriefingReplySchema = z.object({
  reply: z.string(),
});

const OWNER_BRIEFING_SYSTEM_PROMPT = `You are Genesis (J4), a merchant's business partner, speaking directly to the owner the moment they open their dashboard — this is their daily operating rhythm: one short, warm, first-person paragraph that tells them what changed, what matters most today, any real opportunity, and what you'd do next. Never a list, never headers or bullets, never third person — you're talking to them, not reporting on them.

Ground everything in the real data you're given below, and nothing else. changeSet describes what's genuinely happened since you last spoke with this owner (orders, revenue, new customers, and real connected-system activity like invoices/appointments/campaigns) — only mention figures that are actually nonzero or present, never pad with a zero or a "no change" filler for something that's simply absent. freshOutputs are the real findings from this review pass (explanations/recommendations/opportunities) — draw your "what matters most" and "what I'd recommend" from these, in your own words, never copy them verbatim. goalTrajectories are real progress toward the owner's own stated targets when they have one off track or notably on track.

hasPriorAnchor tells you which situation you're in:
- false: this is the very first time you're composing this owner's daily briefing. There is no "since last time" to report — frame this as a warm orientation to what you currently see in the business, never a fabricated "nothing changed since your last visit" (there was no last visit).
- true: you have a real prior anchor. If changeSet is genuinely thin (no orders, no new customers, no real activity) AND freshOutputs has nothing significant AND no goal is off track, say so plainly and briefly — something like "not much changed since we last spoke, but here's what I'd keep an eye on" — never manufacture urgency or invent an opportunity just to fill space. A quiet day is a completely valid, honest thing to report.

2-5 sentences, one flowing paragraph, plain warm language a small-business owner would actually use — never jargon, never a generic corporate tone. Never state a number, name, or trend that isn't in the data you were given.`;

export async function composeOwnerBriefing(
  storeId: string,
  input: {
    storeName: string;
    changeSet: OwnerBriefingChangeSet;
    freshOutputs: OwnerBriefingFreshOutput[];
    goalTrajectories: OwnerBriefingGoalTrajectory[];
  }
): Promise<string | null> {
  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      max_tokens: 1200,
      thinking: { type: "adaptive" },
      system: withJ4CopyRules(OWNER_BRIEFING_SYSTEM_PROMPT),
      messages: [
        {
          role: "user",
          content: `Business data (JSON):\n${JSON.stringify(
            {
              storeName: input.storeName,
              changeSet: input.changeSet,
              freshOutputs: input.freshOutputs,
              goalTrajectories: input.goalTrajectories,
            },
            null,
            2
          )}`,
        },
      ],
      output_config: { effort: "medium", format: zodOutputFormat(OwnerBriefingReplySchema) },
    },
    { storeId, feature: "owner_briefing_composer" }
  );

  if (!outcome.ok || !outcome.message.parsed_output) return null;
  return outcome.message.parsed_output.reply;
}
