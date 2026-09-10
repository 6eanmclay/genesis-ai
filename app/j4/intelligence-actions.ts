"use server";

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { resolveOfficeAccess } from "@/lib/j4/officeAccess";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { getOpenTasks } from "@/lib/dashboard/tasks";
import { getHandledSince } from "@/lib/dashboard/handled";
import { ACTION_SECTIONS } from "@/lib/execution/genesisActions";
import { LEGACY_BUSINESS_BASE, businessBasePath, sectionHref } from "@/lib/dashboard/navConfig";
import { officeFacts, type OfficeFact } from "@/lib/j4/officeFacts";
import { buildBriefing, summariseHandled, type BriefingItem, type HandledSummary } from "@/lib/j4/officeBriefing";
import { officeActionForObservation, officeActionForExplanation } from "@/lib/j4/officeActions";

/**
 * EVERYTHING J4 FOUND, LOADED AFTER THE OWNER CAN ALREADY TALK TO HIM.
 *
 * ============ THE TIER THIS IMPLEMENTS (Sean, 2026-09-09) ==============
 *
 *   CRITICAL     J4 identity, Office shell, composer, ability to accept a
 *                message, the conversation request
 *   PROGRESSIVE  briefing, observations/facts, explanations, approvals,
 *                tasks, handled/changed          <- this file
 *   ON-DEMAND    business understanding, documents, analytics
 *
 * And the rule that decides the split: "Only load what the current surface
 * needs, and don't block the user on data that isn't needed to make the
 * surface usable." Nothing here is needed to type a message to J4.
 *
 * ============ MEASURED, NOT ASSUMED ====================================
 *
 * Against production, read by read:
 *
 *     conversation      167ms   critical - the shell genuinely needs it
 *     observations       72ms
 *     explanations       74ms
 *     approvals         185ms
 *     tasks              66ms
 *     handled/changed   499ms   <- the slowest thing left after understanding
 *
 * All of it used to sit in one awaited Promise.all, so the floor for a usable
 * composer was the slowest of them. Moving these behind the first paint leaves
 * the conversation alone in front of it.
 *
 * ============ NOTHING IS DELETED, AND THE RULES ARE NOT RE-DECIDED =====
 *
 * The same reads, the same officeActions rule about what is owner-facing, the
 * same briefing order, the same fact sourcing. Sean's success condition was
 * "same intelligence + same capabilities + faster usable J4", so this file
 * imports every decision rather than restating one: a second copy of "what
 * counts as actionable" is how the two rails of the promotions defect drifted.
 *
 * It repeats the AUTHORISATION, deliberately - a server action is a public
 * endpoint, and the component that used to hold these reads had already
 * resolved the store and the role.
 */
export interface OfficeIntelligence {
  briefingItems: BriefingItem[];
  handled: HandledSummary;
  facts: OfficeFact[];
  tasks: { id: string; title: string; summary: string; href: string | null; priority: string; because?: string }[];
  ideas: { id: string; summary: string; href: string | null; because?: string }[];
  decisions: { id: string; summary: string; createdAt: string; href: string | null; because?: string }[];
  information: { id: string; summary: string; href: string | null; kind: "urgent" | "curiosity"; because?: string }[];
}

const HANDLED_WINDOW_DAYS = 14;

function empty(): OfficeIntelligence {
  return {
    briefingItems: [],
    handled: { resolvedByJ4: 0, decisionsSettled: 0, changes: [], windowDays: HANDLED_WINDOW_DAYS },
    facts: [],
    tasks: [],
    ideas: [],
    decisions: [],
    information: [],
  };
}

export async function loadOfficeIntelligence(slug?: string): Promise<OfficeIntelligence> {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // ONE RESOLVER. Both of these actions originally called
  // accessTo(slug, session.user.id) - a slug where a user id belongs and a
  // user id where a store id belongs. Both are strings, so nothing complained,
  // and every owner on a /b/[slug] route would have silently got an empty
  // business. See lib/j4/officeAccess.ts.
  const resolved = await resolveOfficeAccess(session.user.id, slug);
  if (!resolved) return empty();
  const { store, role } = resolved;
  if (!hasPermission(role, PERMISSIONS.GENESIS_CHAT)) return empty();

  const basePath = slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE;

  const [observations, explanations, pendingApprovals, openTasks, activeProductCount, handledRaw] = await Promise.all([
    prisma.genesisObservation.findMany({
      where: { storeId: store.id, status: "ACTIVE" },
      select: { id: true, genesisState: true, summary: true, actionHref: true, firstNoticedAt: true },
      orderBy: { firstNoticedAt: "desc" },
    }),
    prisma.cognitiveOutput.findMany({
      where: { storeId: store.id, kind: "explanation", status: "ACTIVE" },
      select: { id: true, summary: true, actionHref: true },
      orderBy: { generatedAt: "desc" },
    }),
    // Same permission tier as before the move.
    hasPermission(role, PERMISSIONS.ANALYTICS_VIEW) ? getPendingApprovals(store.id) : Promise.resolve([]),
    getOpenTasks(store.id),
    prisma.product.count({ where: { storeId: store.id, active: true } }),
    getHandledSince(store.id, HANDLED_WINDOW_DAYS),
  ]);

  const urgent = observations.filter((o) => o.genesisState === "urgent");
  const ideas = observations.filter((o) => o.genesisState === "opportunity");

  const asRow = (id: string, summary: string, action: ReturnType<typeof officeActionForObservation>, kind: "urgent" | "curiosity") => ({
    id,
    summary,
    href: action.kind === "open" ? action.href : null,
    because: action.kind === "none" || action.kind === "internal" ? action.because : undefined,
    kind,
  });

  return {
    briefingItems: buildBriefing(
      {
        decisions: pendingApprovals.map((a) => ({ id: a.id, summary: a.summary, rationale: a.rationale, createdAt: a.createdAt })),
        observations,
      },
      basePath,
    ),
    handled: summariseHandled(handledRaw, basePath),
    facts: officeFacts(
      {
        activeProducts: activeProductCount,
        openTasks: openTasks.length,
        pendingDecisions: pendingApprovals.length,
        opportunities: ideas.length,
        needsYou: urgent.length,
      },
      basePath,
    ),
    tasks: openTasks.map((t) => ({ id: t.id, title: t.title, summary: t.summary, href: t.actionHref, priority: t.priority })),
    ideas: ideas.map((o) => {
      const action = officeActionForObservation(o, basePath);
      return {
        id: o.id,
        summary: o.summary,
        href: action.kind === "open" ? action.href : null,
        because: action.kind === "none" ? action.because : undefined,
      };
    }),
    decisions: pendingApprovals.map((a) => ({
      id: a.id,
      summary: a.summary,
      createdAt: a.createdAt.toISOString(),
      // Inside the business being viewed — the hazard J4Surface documents:
      // the legacy spelling resolves the ACCOUNT'S active business, so a
      // decision followed without rebasing can move the owner elsewhere.
      href: ACTION_SECTIONS[a.actionType] ? sectionHref(ACTION_SECTIONS[a.actionType].href, basePath) : null,
    })),
    information: [
      ...urgent.map((o) => asRow(o.id, o.summary, officeActionForObservation(o, basePath), "urgent")),
      ...explanations.map((e) => asRow(e.id, e.summary, officeActionForExplanation(e, basePath), "curiosity")),
    ],
  };
}
