import { prisma } from "@/lib/prisma";
import { growthPointCostFor } from "./catalog";
import type { GenesisActionType } from "@/lib/execution/genesisActions";

// WHEN TO ASK ABOUT GROWTH POINTS, AND WHEN NOT TO.
//
// ============ A GLOBAL RULE, NOT A FEATURE'S OWN (2026-08-28) ===========
//
// Sean: "Growth Point costs should never be presented during the workflow. The
// cost is disclosed only at the final commitment point, immediately before the
// action executes... This should be a global Genesis behavior for every Growth
// Point-consuming action, not something implemented separately for Creation
// Station, Social, or individual features."
//
// So this file is the decision, once, for everything. A surface asks it what to
// do and gets an answer; it does not get to invent its own policy. The
// alternative — every feature deciding when to ask — is how three features end
// up asking three different ways and one of them forgets.
//
// ============ WHAT THE PREFERENCE DOES AND DOES NOT DO =================
//
// "The preference means skip recurring cost confirmation, not hide Growth Point
// accounting." Opting out removes a question, never the record: after a
// successful action the owner is still told what it cost and what is left, and
// the ledger is untouched either way. `spendSummary` below is that line.
//
// And it is overridable by design. The rule names three cases, all of them
// here: the cost went up, the balance cannot cover it, or the caller has its
// own reason to insist.

export interface GrowthPointDecision {
  /** What this action costs. Zero when the action is not metered at all. */
  cost: number;
  /** What the owner has right now, read at the moment of asking. */
  balance: number;
  /** Whether to put the question in front of them. */
  mustAsk: boolean;
  /**
   * Why it is being asked, or why not — so a surface can say something true
   * rather than guess, and so this is debuggable from the outside.
   */
  reason:
    | "not-metered"
    | "never-asked"
    | "cost-increased"
    | "insufficient-balance"
    | "caller-insists"
    | "preference-set";
  /** Whether the balance can actually cover it. */
  affordable: boolean;
}

/**
 * Should this action ask before it spends?
 *
 * READ AT THE COMMITMENT POINT, never at page load. A balance rendered when a
 * screen opened is a number that was true earlier; this one was true a moment
 * ago, which is the only version worth showing somebody about to spend.
 */
export async function growthPointDecision(params: {
  storeId: string;
  userId: string | null;
  actionType: GenesisActionType;
  /**
   * Force the question regardless of preference — for an action that carries
   * its own consequences beyond the points, where the confirmation is doing a
   * second job. Rare, and named at the call site.
   */
  alwaysAsk?: boolean;
}): Promise<GrowthPointDecision> {
  const cost = growthPointCostFor(params.actionType) ?? 0;

  const [store, user] = await Promise.all([
    prisma.store.findUnique({
      where: { id: params.storeId },
      select: { growthPointBalance: true },
    }),
    params.userId
      ? prisma.user.findUnique({
          where: { id: params.userId },
          select: { growthPointConfirmSkippedAt: true, growthPointConfirmSkippedCost: true },
        })
      : null,
  ]);

  const balance = store?.growthPointBalance ?? 0;
  const affordable = balance >= cost;

  // An action nobody is charged for has nothing to confirm. Saving a design,
  // editing one, coming back to it later — none of these reach here at all,
  // and the ones that do with a null price are the bookkeeping actions the
  // catalogue deliberately leaves unpriced.
  if (cost <= 0) return { cost, balance, mustAsk: false, reason: "not-metered", affordable: true };

  // THE THREE OVERRIDES, in the order they matter.
  if (params.alwaysAsk) return { cost, balance, mustAsk: true, reason: "caller-insists", affordable };

  // Not being able to afford it is not a confirmation, it is news — and it has
  // to reach them before anything runs rather than as a failure afterwards.
  if (!affordable) return { cost, balance, mustAsk: true, reason: "insufficient-balance", affordable };

  const skippedAt = user?.growthPointConfirmSkippedAt ?? null;
  if (!skippedAt) return { cost, balance, mustAsk: true, reason: "never-asked", affordable };

  // "Always override the preference if the cost materially changes." Made
  // concrete rather than left to judgement: waving through an action at one
  // price authorises that price and anything cheaper, never more.
  const agreedTo = user?.growthPointConfirmSkippedCost ?? 0;
  if (cost > agreedTo) return { cost, balance, mustAsk: true, reason: "cost-increased", affordable };

  return { cost, balance, mustAsk: false, reason: "preference-set", affordable };
}

/**
 * Remember that they would rather not be asked.
 *
 * The cost they agreed to is recorded with it, which is what makes the
 * "materially changes" override above a comparison rather than an opinion.
 * A later, dearer action asks again on its own.
 */
export async function rememberSkipGrowthPointConfirmation(userId: string, cost: number): Promise<void> {
  // THE COMMENT BELOW USED TO BE A CLAIM THIS CODE DID NOT KEEP (fixed
  // 2026-09-04). It said "the highest cost they have waved through" while
  // writing `Math.max(cost, 0)`, which never looked at the stored value and
  // so recorded whatever was waved through LAST.
  //
  // Reachable, though not by the ordinary route: an action cheaper than the
  // agreed cost never asks, so it never gets here. Two overrides sit ABOVE
  // that comparison and do ask - `alwaysAsk`, and a balance too low to
  // afford even a cheap action. Waving one of those through narrowed a
  // 5-point permission to 1, and the owner started being asked again about
  // things they had already accepted.
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { growthPointConfirmSkippedCost: true },
  });
  await prisma.user.update({
    where: { id: userId },
    data: {
      growthPointConfirmSkippedAt: new Date(),
      // The HIGHEST cost they have waved through, so the preference does not
      // narrow itself every time they confirm something cheap.
      growthPointConfirmSkippedCost: Math.max(cost, existing?.growthPointConfirmSkippedCost ?? 0, 0),
    },
  });
}

/** Let them be asked again. Nothing here is one-way. */
export async function resumeGrowthPointConfirmation(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { growthPointConfirmSkippedAt: null, growthPointConfirmSkippedCost: null },
  });
}

/**
 * What it cost and what is left, for after it worked.
 *
 * "Posted ✓ · 1 Growth Point used · 23 remaining." This is the accounting the
 * preference explicitly does NOT switch off — somebody who asked not to be
 * interrupted still gets told what their business spent.
 */
export function spendSummary(params: { verb: string; cost: number; remaining: number }): string {
  const { verb, cost, remaining } = params;
  if (cost <= 0) return `${verb} ✓`;
  const points = cost === 1 ? "1 Growth Point" : `${cost} Growth Points`;
  return `${verb} ✓ · ${points} used · ${remaining} remaining`;
}
