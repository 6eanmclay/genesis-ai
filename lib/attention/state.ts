import { prisma } from "@/lib/prisma";
import { DEFERRAL_WINDOW_MS, isDeferred, deferredUntil, type Deferral } from "./deferral";
import { ATTENTION_SOURCES, type AttentionRef, type AttentionSource } from "./identity";

/**
 * WHAT THE OWNER HAS SET ASIDE, ASKED ONCE.
 *
 * ============ ONE DECISION, TWO PRESENTATIONS (2026-09-13) =============
 *
 * Sean: "There should be one underlying eligibility/deferred decision and two
 * presentations... Do not create separate Business and Office dismissal
 * queries."
 *
 * So this is the one reader. The Business arrival and the Office both load
 * this and both ask the same question of it; what they do with the answer is
 * their own business, and deliberately different — see DEFERRED_TREATMENT.
 *
 * ============ WHY TWO KINDS OF ANSWER ================================
 *
 * Because the stored population genuinely has two kinds of row, and pretending
 * otherwise would be the dishonest simplification:
 *
 *   canonical   source + sourceId, naming a real ApprovalRequest, Task or
 *               GenesisObservation. Any surface can ask about these, which is
 *               the entire point of the migration in ea55f8b.
 *
 *   legacy      cardId only. Two populations live here and always will: the
 *               arrival's own `issue:` and `discovery:` items, which have no
 *               canonical source to map to, and old rows whose record is gone.
 *               Sean: these "continue using their existing legacy behavior".
 *
 * The two are answered by two FUNCTIONS rather than one that takes both, so
 * the rule is structural: the canonical path cannot see a cardId, because it
 * is never given one. A surface holding a real item asks isItemDeferred and
 * has no way to fall back to a string.
 */
export interface OwnerAttentionState {
  /** Deferrals that name a real row. Already filtered to the live window. */
  deferrals: Deferral[];
  /**
   * Dismissals that never mapped to a canonical item, by the presentation id
   * they were stored under. Only `issue:` and `discovery:` cards — and rows
   * whose record has since gone — are ever answered from here.
   */
  legacyCardIds: Set<string>;
}

function isKnownSource(value: string | null): value is AttentionSource {
  return value !== null && (ATTENTION_SOURCES as readonly string[]).includes(value);
}

/**
 * One query, for the whole business.
 *
 * Scoped to the live window here rather than at every call site, so a caller
 * cannot accidentally ask a question about expired state — and so the seven
 * days are applied in exactly one place.
 */
export async function loadOwnerAttentionState(storeId: string): Promise<OwnerAttentionState> {
  const rows = await prisma.dismissedAttentionCard.findMany({
    where: { storeId, dismissedAt: { gte: new Date(Date.now() - DEFERRAL_WINDOW_MS) } },
    select: { cardId: true, source: true, sourceId: true, dismissedAt: true },
  });
  return classifyAttentionRows(rows);
}

/**
 * The classification, separated from the query.
 *
 * ============ WHY THIS IS ITS OWN FUNCTION (2026-09-13) ===============
 *
 * So a suite can exercise the real rule against a real test database without
 * importing the app's prisma client. The first version of
 * verify-attention-consumption called loadOwnerAttentionState directly, and
 * the app client in a script process resolves DATABASE_URL from the repo's
 * .env — which is a REAL database, not the harness's ephemeral one. It failed
 * loudly rather than quietly, and read nothing, but the suite had no business
 * pointing there at all.
 *
 * Query in the shell, decision in the core. The suite reads rows through the
 * harness's own client and calls this — so what is tested is the rule that
 * ships, against the data the test actually seeded.
 */
export function classifyAttentionRows(
  rows: readonly { cardId: string; source: string | null; sourceId: string | null; dismissedAt: Date }[],
): OwnerAttentionState {
  const deferrals: Deferral[] = [];
  const legacyCardIds = new Set<string>();
  for (const row of rows) {
    // BOTH HALVES OR NEITHER. A row with a source and no sourceId is not a
    // canonical deferral, and treating it as one would invent an identity —
    // it falls back to its presentation id, where it still works.
    if (isKnownSource(row.source) && row.sourceId !== null) {
      deferrals.push({ source: row.source, sourceId: row.sourceId, deferredAt: row.dismissedAt });
    } else {
      legacyCardIds.add(row.cardId);
    }
  }
  return { deferrals, legacyCardIds };
}

/**
 * Has the owner set this real item aside?
 *
 * THE ONE QUESTION BOTH SURFACES ASK. It takes a ref and nothing else, so
 * there is no card id in scope to regress to.
 */
export function isItemDeferred(
  state: OwnerAttentionState,
  ref: AttentionRef,
  now: Date = new Date(),
): boolean {
  return isDeferred(ref, state.deferrals, now);
}

/** When it comes back, so a surface can say so rather than only grey it out. */
export function itemDeferredUntil(
  state: OwnerAttentionState,
  ref: AttentionRef,
  now: Date = new Date(),
): Date | null {
  return deferredUntil(ref, state.deferrals, now);
}

/**
 * The legacy path, for cards that have no canonical identity to ask about.
 *
 * NOT A FALLBACK FOR CANONICAL ITEMS. An `issue:` or `discovery:` card has no
 * real row behind it in the three-source model, so its own id is the only
 * thing it has ever been identified by and its behaviour is unchanged. A card
 * that HAS a ref must never reach this function — verify-attention-consumption
 * asserts that, because "unchanged for the legacy cases" and "quietly still
 * keyed on presentation ids" look identical from the outside.
 */
export function isLegacyCardDismissed(state: OwnerAttentionState, cardId: string): boolean {
  return state.legacyCardIds.has(cardId);
}
