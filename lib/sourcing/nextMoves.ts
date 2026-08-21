import { prisma } from "@/lib/prisma";
import { currentPolicy } from "./progressionPolicy";
import { currentMovePolicy, type MovePolicy } from "./movePolicy";
import {
  businessStage,
  capitalPosture,
  earnedRungs,
  storeProductEvidence,
  type BusinessStage,
  type ProductEvidence,
} from "./progression";
import { findGraduationOpportunities, RECONSIDERATION_EXPLANATION } from "./graduation";
import { assessFeasibility, decide } from "./feasibility";
import {
  bulkTerms,
  missingEconomics,
  supplierEconomics,
  ECONOMICS_GAP_EXPLANATION,
  NO_TERMS,
  type SupplierEconomics,
} from "./economics";
import { QUOTABLE_FACTS } from "./economicsIngest";
import { methodProfile } from "./methodProfile";
import { scoreCandidate, type SourcingContext } from "./recommend";
import { buildSourcingContext } from "./context";
import { fromVariantKey } from "./types";
import {
  candidateMove,
  concentration,
  deepenMove,
  evidenceStrength,
  rankMoves,
  unblockMove,
  type BusinessMove,
} from "./moves";

// WHAT SHOULD THIS BUSINESS DO NEXT — one call, one ranked answer.
//
// The orchestrator. It gathers every move available to a business, asks the
// existing engine to judge each one, and ranks them. It decides nothing itself:
// fit comes from recommend.ts, affordability from feasibility.ts, earned rungs
// from progression.ts, and comparison from moves.ts.
//
// THE LEDGER IS TWO EXISTING STORES, NOT A NEW ONE. Candidates the owner turned
// down are already remembered on SourcedProduct.status, and graduations they
// declined on ProgressionDecision with their conditions. Both are verified and
// both already implement "not raised again until something material changed".
// Adding a third table would be a second mechanism for a solved problem, and the
// one nobody maintained would be the one that got it wrong.

export interface NextMoves {
  stage: BusinessStage;
  moves: BusinessMove[];
  /** Everything considered, for explaining why something is NOT in the three. */
  consideredCount: number;
  /** Named, never silently omitted. */
  blockedSources: { key: string; displayName: string; blockedOn: string[] }[];
}

/**
 * The question to ask, which depends on what already happened.
 *
 * Three different situations, three different sentences. Asking somebody to
 * repeat work they did last week is how an assistant becomes noise; never asking
 * again is how a closed door stays closed forever.
 */
function unblockQuestion(productName: string, stated: SupplierEconomics | null): string {
  // WHICH FACTS WERE ACTUALLY REFUSED, not "was this record a refusal". A
  // supplier can quote a price and decline to discuss minimums, and asking the
  // owner to go back for both would be asking them to repeat half the work.
  const refused = QUOTABLE_FACTS.filter(
    (fact) => stated?.attribution[fact].provenance === "UNAVAILABLE"
  );
  if (refused.length === 0) {
    return `What would ${productName} cost you to buy in bulk, and how many would you have to order?`;
  }

  // THE ONE PLACE STALENESS CHANGES BEHAVIOUR RATHER THAN WORDING. "They
  // wouldn't say" is a reason not to ask again next week; past the window it
  // stops being a reason not to ask at all. Suppliers change their minds, and by
  // now this owner may be a customer worth quoting.
  const oldest = refused
    .map((fact) => stated!.attribution[fact].freshness)
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .sort((a, b) => b.ageDays - a.ageDays)[0];

  if (oldest?.state === "stale") {
    const months = Math.max(1, Math.round(oldest.ageDays / 30));
    return `It's been ${months === 1 ? "a month" : `${months} months`} since they wouldn't quote you on ${productName}. Worth asking again?`;
  }

  return `Can you find another supplier for ${productName}, or ask again what they'd charge in bulk?`;
}

export async function nextMoves(
  storeId: string,
  options: { movePolicy?: MovePolicy; context?: SourcingContext } = {}
): Promise<NextMoves> {
  const movePolicy = options.movePolicy ?? currentMovePolicy();
  const policy = currentPolicy();

  const [stage, posture, evidenceByProduct, context] = await Promise.all([
    businessStage(storeId, policy),
    capitalPosture(storeId),
    storeProductEvidence(storeId),
    options.context ?? buildSourcingContext(storeId),
  ]);

  const products = await prisma.product.findMany({
    where: { storeId, active: true },
    select: { id: true, name: true, sourceKind: true },
  });

  // What this business has actually proven. Used for two different things: the
  // start/widen distinction, and how much a further product would add.
  const proven: { id: string; name: string; evidence: ProductEvidence }[] = [];
  for (const product of products) {
    const evidence = evidenceByProduct.get(product.id);
    if (evidence && earnedRungs(evidence, policy).length > 0) {
      proven.push({ id: product.id, name: product.name, evidence });
    }
  }
  const hasProven = proven.length > 0;
  const narrowness = concentration(products.length, proven.length);

  const moves: BusinessMove[] = [];
  let considered = 0;

  // --- deepen, and the unblocks that stand in for a deepen ------------------
  const graduations = await findGraduationOpportunities(storeId, { policy });
  for (const opportunity of graduations) {
    considered++;
    const fit = { verdict: "fits" as const, score: 0, reasons: [], concerns: [], basedOn: [] };
    const outcome = decide(
      {
        ...fit,
        // A product the business already sells fits it by definition — it is
        // being sold. What is in question is the economics, not the belonging.
        reasons: [`You already sell this, and it's working.`],
      },
      opportunity.feasibility
    );

    const sourced = await prisma.sourcedProduct.findFirst({
      where: { storeId, adoptedProductId: opportunity.productId },
      select: {
        bulkUnitCostInCents: true,
        minimumOrderUnits: true,
        sourceKey: true,
        externalProductId: true,
        externalVariantId: true,
      },
    });
    const stated = sourced
      ? await supplierEconomics(storeId, {
          sourceKey: sourced.sourceKey,
          externalProductId: sourced.externalProductId,
          externalVariantId: sourced.externalVariantId === "" ? null : sourced.externalVariantId,
        })
      : null;

    if (outcome.kind === "cannot_assess") {
      // NOT DROPPED — turned into the question that would resolve it. This is
      // the move most systems never model: when Genesis cannot decide, the
      // useful output is the specific thing it would need to know.
      //
      // And it says WHY each gap matters, not just that it exists. "I don't know
      // the minimum order" is a fact about Genesis; "it decides what buying in
      // bulk would actually cost you up front" is a reason for the owner to go
      // and find out.
      const gaps = missingEconomics(stated);
      moves.push(
        unblockMove({
          productId: opportunity.productId,
          sourcedProductId: null,
          subject: opportunity.productName,
          missing:
            gaps.length > 0
              ? gaps.map((gap) => ECONOMICS_GAP_EXPLANATION[gap])
              : outcome.missing,
          question: unblockQuestion(opportunity.productName, stated),
          // Worth exactly what it would unlock: strong product, valuable
          // question; weak product, not worth asking about.
          blockedMoveStrength:
            evidenceStrength(opportunity.evidence, methodProfile(opportunity.toKind).rung, policy) *
            movePolicy.evidenceStrengthWeight,
          outcome,
          movePolicy,
        })
      );
      continue;
    }

    moves.push(
      deepenMove({
        productId: opportunity.productId,
        productName: opportunity.productName,
        fromKind: opportunity.fromKind,
        toKind: opportunity.toKind,
        evidence: opportunity.evidence,
        outcome,
        bulkUnitCostInCents: bulkTerms(stated).bulkUnitCostInCents ?? sourced?.bulkUnitCostInCents ?? null,
        upfrontCents:
          opportunity.feasibility.kind === "not_yet" ? opportunity.feasibility.upfrontCents : null,
        paybackWeeks:
          opportunity.feasibility.kind === "not_yet" ? opportunity.feasibility.paybackWeeks : null,
        reconsideration: opportunity.reconsideration
          ? RECONSIDERATION_EXPLANATION[opportunity.reconsideration]
          : null,
        policy,
        movePolicy,
      })
    );
  }

  // --- start and widen, from candidates already discovered ------------------
  //
  // Only SUGGESTED rows. A dismissed candidate is the owner's decision and is
  // honoured here by the same mechanism that honours it in discovery — no
  // second ledger, no second rule.
  const candidates = await prisma.sourcedProduct.findMany({
    where: { storeId, status: "SUGGESTED" },
    orderBy: [{ score: "desc" }],
    take: 25,
  });

  for (const candidate of candidates) {
    considered++;
    const fit = scoreCandidate(
      {
        sourceKey: candidate.sourceKey,
        externalProductId: candidate.externalProductId,
        externalVariantId: fromVariantKey(candidate.externalVariantId),
        kind: candidate.kind,
        name: candidate.name,
        description: candidate.description,
        imageUrl: candidate.imageUrl,
        unitCostInCents: candidate.unitCostInCents,
        suggestedRetailInCents: candidate.suggestedRetailInCents,
        currency: candidate.currency,
        customizable: candidate.customizable,
        fulfillmentProvider: candidate.fulfillmentProvider,
      },
      context
    );

    // Economics from their own record, falling back to whatever discovery
    // recorded. Unknown either way stays unknown.
    const candidateEconomics = await supplierEconomics(storeId, {
      sourceKey: candidate.sourceKey,
      externalProductId: candidate.externalProductId,
      externalVariantId: fromVariantKey(candidate.externalVariantId),
    });
    const candidateTerms = candidateEconomics
      ? bulkTerms(candidateEconomics)
      : {
          // Discovery's own columns, which carry no provenance and no date.
          // NO_TERMS spreads the honest nulls for everything they cannot answer
          // rather than a partial shape that implies those questions were asked.
          ...NO_TERMS,
          minimumOrderUnits: candidate.minimumOrderUnits,
          bulkUnitCostInCents: candidate.bulkUnitCostInCents,
        };

    const feasibility = assessFeasibility({
      profile: methodProfile(candidate.kind),
      posture,
      supplier: candidateTerms,
      evidence: null,
      currency: context.currency ?? posture.currency,
    });

    const outcome = decide(fit, feasibility);
    // A product that does not belong is not a move. It was already explained as
    // a non-fit by discovery; repeating it here would be a list of rejections.
    if (outcome.kind === "not_a_fit" || outcome.kind === "cannot_assess") continue;

    moves.push(
      candidateMove({
        sourcedProductId: candidate.id,
        name: candidate.name,
        kind: candidate.kind,
        fit,
        outcome,
        movePolicy,
        concentration: narrowness,
        provenNames: proven.map((p) => p.name),
        hasProvenProduct: hasProven,
      })
    );
  }

  const { describeBlockedSources } = await import("./registry");

  return {
    stage,
    moves: rankMoves(moves, movePolicy),
    consideredCount: considered,
    blockedSources: describeBlockedSources(),
  };
}
