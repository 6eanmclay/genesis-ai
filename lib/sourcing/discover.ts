import { prisma } from "@/lib/prisma";
import { getProductSources, getProductSource } from "./registry";
import { scoreCandidate, isWorthSuggesting, type SourcingContext } from "./recommend";
import { toVariantKey, type SourcedCandidate, type ProductSource, type SourceUnavailable } from "./types";

// Running discovery, and remembering what it found.
//
// The difference between a catalog and a discovery system is that this survives
// the request. Before it, browsing a supplier produced candidates that existed
// only inside one page load: J4 could not come back to one, could not say why it
// had raised it, and could not tell a suggestion the owner had already turned
// down from one it had never seen. Persisting them is what makes the third of
// those possible, and the third is the one that decides whether this reads as a
// partner or as a nag.

export interface DiscoveryResult {
  /** Candidates now sitting as SUGGESTED for this store, best first. */
  suggested: { id: string; name: string; score: number; reasons: string[] }[];
  /** How many were seen but not worth raising. Counted, never padded in. */
  consideredAndSkipped: number;
  /** Sources that could not be searched, and why. Never silently omitted. */
  unavailable: { key: string; displayName: string; problem: SourceUnavailable }[];
  /** Candidates the owner has already dismissed and which were not raised again. */
  respectedDismissals: number;
}

/**
 * Search every ready source and record what is worth raising.
 *
 * Idempotent by construction: the unique key on
 * (storeId, sourceKey, externalProductId, externalVariantId) makes a re-run an
 * update in place. Running discovery twice does not produce two of anything, and
 * a candidate whose price or description changed at the supplier is corrected
 * rather than duplicated.
 */
export async function discoverProducts(params: {
  storeId: string;
  context: SourcingContext;
  limitPerSource?: number;
  /** Restrict to specific registered sources by key. Omit for all of them. */
  sourceKeys?: string[];
  /**
   * Supply the sources directly, bypassing the registry.
   *
   * The seam that lets the pipeline be proven against BOTH shapes it claims to
   * support. Only one real source is connectable today, so without this the
   * wholesale/dropship half of the contract would be asserted by reading it. An
   * implementation of ./types.ts is not a mock of a supplier — the contract is
   * the thing under test here, and two implementations of it are what test it.
   */
  sources?: ProductSource[];
}): Promise<DiscoveryResult> {
  const { storeId, context } = params;
  const limit = params.limitPerSource ?? 8;

  const sources: ProductSource[] =
    params.sources ??
    (params.sourceKeys
      ? params.sourceKeys.map((key) => getProductSource(key)).filter((s): s is ProductSource => s !== null)
      : getProductSources());

  const unavailable: DiscoveryResult["unavailable"] = [];
  const found: SourcedCandidate[] = [];

  for (const source of sources) {
    // A source that has declared what it is missing is not asked. Making the
    // request anyway would turn a known configuration gap into a provider error
    // in the logs, which reads as something being broken.
    if (source.blockedOn.length > 0) {
      unavailable.push({
        key: source.key,
        displayName: source.displayName,
        problem: {
          reason: "not_configured",
          detail: `${source.displayName} needs ${source.blockedOn.join(", ")} before it can be searched.`,
          missing: source.blockedOn,
        },
      });
      continue;
    }

    const result = await source
      .search({
        storeId,
        keywords: context.ownWords,
        brandPositioning: context.brandPositioning,
        limit,
      })
      .catch((error: unknown) => ({
        ok: false as const,
        reason: "provider_error" as const,
        detail: error instanceof Error ? error.message.slice(0, 200) : "Search failed",
      }));

    if (!result.ok) {
      const { ok: _ok, ...problem } = result;
      unavailable.push({ key: source.key, displayName: source.displayName, problem });
      continue;
    }
    // A source may only speak for itself. A candidate claiming another source's
    // key would land on that source's row through the unique key and quietly
    // overwrite it.
    found.push(...result.candidates.filter((c) => c.sourceKey === source.key));
  }

  // What the owner has already turned down. Read before writing anything, so a
  // dismissal is respected in the same run it would otherwise be undone by.
  const dismissed = await prisma.sourcedProduct.findMany({
    where: { storeId, status: "DISMISSED" },
    select: { sourceKey: true, externalProductId: true, externalVariantId: true },
  });
  const dismissedKeys = new Set(
    dismissed.map((d) => `${d.sourceKey}|${d.externalProductId}|${d.externalVariantId}`)
  );

  let consideredAndSkipped = 0;
  let respectedDismissals = 0;
  const suggested: DiscoveryResult["suggested"] = [];

  for (const candidate of found) {
    const key = `${candidate.sourceKey}|${candidate.externalProductId}|${toVariantKey(candidate.externalVariantId)}`;
    if (dismissedKeys.has(key)) {
      respectedDismissals++;
      continue;
    }

    const recommendation = scoreCandidate(candidate, context);
    if (!isWorthSuggesting(recommendation)) {
      // Counted, not stored. A row for something Genesis had no reason to raise
      // would be indistinguishable later from one it did.
      consideredAndSkipped++;
      continue;
    }

    const shared = {
      kind: candidate.kind,
      name: candidate.name,
      description: candidate.description,
      imageUrl: candidate.imageUrl,
      unitCostInCents: candidate.unitCostInCents,
      suggestedRetailInCents: candidate.suggestedRetailInCents,
      currency: candidate.currency,
      customizable: candidate.customizable,
      fulfillmentProvider: candidate.fulfillmentProvider,
      recommendation: { ...recommendation },
      score: recommendation.score,
    };

    const row = await prisma.sourcedProduct.upsert({
      where: {
        storeId_sourceKey_externalProductId_externalVariantId: {
          storeId,
          sourceKey: candidate.sourceKey,
          externalProductId: candidate.externalProductId,
          externalVariantId: toVariantKey(candidate.externalVariantId),
        },
      },
      create: {
        storeId,
        sourceKey: candidate.sourceKey,
        externalProductId: candidate.externalProductId,
        externalVariantId: toVariantKey(candidate.externalVariantId),
        ...shared,
      },
      // Status is deliberately absent: an ADOPTED candidate stays adopted when
      // discovery runs again, and re-suggesting something the owner already put
      // in their store would be the same failure as re-suggesting a dismissal.
      update: shared,
    });

    if (row.status === "SUGGESTED") {
      suggested.push({ id: row.id, name: row.name, score: recommendation.score, reasons: recommendation.reasons });
    }
  }

  suggested.sort((a, b) => b.score - a.score);
  return { suggested, consideredAndSkipped, unavailable, respectedDismissals };
}
