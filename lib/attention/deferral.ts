import type { AttentionRef, AttentionSource } from "./identity";

/**
 * "NOT NOW" BELONGS TO THE OWNER, NOT TO THE SCREEN THEY SAID IT ON.
 *
 * ============ THE RULE (2026-09-13, Sean) ==============================
 *
 * "Treat dismissal as a J4/business-level attention state, not a per-surface
 * convenience. If an owner tells J4 'not now', another J4 surface should not
 * immediately present the same underlying item as if the dismissal never
 * happened."
 *
 * Today it does. Proven on the rendered page: dismiss an approval on the
 * Business arrival and the Office still shows it, in DECIDE, with a live
 * Approve and Reject. Not because anyone decided the Office should ignore it
 * — because the state was written under a name the Office cannot ask about.
 * See identity.ts.
 *
 * ============ WHAT THIS MODULE IS, AND IS NOT =========================
 *
 * It is the CONTRACT: what a deferral is, and whether one is in force for an
 * item right now. Pure, with no value imports, so both a server surface and a
 * client component can hold it without dragging anything behind them — the
 * same discipline officeSections.ts follows and for the same reason.
 *
 * It is NOT the store, and it is NOT a change to any surface. Nothing reads
 * or writes a deferral yet. The migration of the existing
 * DismissedAttentionCard rows and the two surfaces that consume them are
 * separate commits, deliberately: this one can be read and argued with on its
 * own before anything depends on it.
 *
 * ============ WHAT IS DELIBERATELY UNCHANGED ==========================
 *
 * The semantics are exactly today's, with one difference — the identity. A
 * deferral still lasts seven days and still never touches the underlying
 * record. Sean: "Migrate DismissedAttentionCard semantics without breaking
 * existing behavior." So this is the same rule, asked a different way.
 *
 * One question this does NOT answer, raised rather than decided: today a
 * deferral is purely time-boxed, so re-detecting a condition does not clear
 * it — an observation whose `lastConfirmedAt` bumps every sweep stays
 * deferred for the full week. Whether a re-confirmed condition should
 * interrupt an owner again is a product decision, not a refactor, and
 * inventing it here would be exactly the speculative fix this codebase keeps
 * being asked not to make.
 */

/**
 * How long "not now" lasts.
 *
 * THE ONE DEFINITION. lib/dashboard/attentionCards.ts currently holds its own
 * `DISMISS_DURATION_MS` with this value; when the arrival is migrated onto
 * this layer that constant comes here, so the two cannot drift into meaning
 * different weeks.
 */
export const DEFERRAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One deferral, as stored: which item, and when the owner said it.
 *
 * Keyed on the PAIR from identity.ts rather than on an encoded string. That
 * is the whole point of the change — a row that says `observation` + the
 * observation's own id can be asked about by any surface, where
 * "observation:<dedupeKey>" could only be asked about by the surface that
 * spelled it that way.
 */
export interface Deferral {
  source: AttentionSource;
  /** The underlying row's primary key. See AttentionRef.id. */
  sourceId: string;
  deferredAt: Date;
}

/**
 * Is this item currently deferred?
 *
 * Takes the deferrals already loaded for the business rather than reaching
 * for a store, so this stays pure and a caller cannot accidentally make it a
 * per-item query inside a render loop.
 */
export function isDeferred(
  ref: AttentionRef,
  deferrals: readonly Deferral[],
  now: Date = new Date(),
): boolean {
  return deferrals.some(
    (d) =>
      d.source === ref.source &&
      d.sourceId === ref.id &&
      now.getTime() - d.deferredAt.getTime() < DEFERRAL_WINDOW_MS,
  );
}

/**
 * When this item's deferral expires, or null if it is not deferred.
 *
 * Exists so a surface can SAY something true about the state rather than only
 * act on it — the Office is to show a deferred item marked as deferred, and
 * "you set this aside, back on Tuesday" is a better sentence than a grey row.
 */
export function deferredUntil(
  ref: AttentionRef,
  deferrals: readonly Deferral[],
  now: Date = new Date(),
): Date | null {
  let latest: number | null = null;
  for (const d of deferrals) {
    if (d.source !== ref.source || d.sourceId !== ref.id) continue;
    const expires = d.deferredAt.getTime() + DEFERRAL_WINDOW_MS;
    if (expires <= now.getTime()) continue;
    if (latest === null || expires > latest) latest = expires;
  }
  return latest === null ? null : new Date(latest);
}

/**
 * How a surface is allowed to treat a deferred item.
 *
 * ============ ELIGIBILITY IS SHARED, PRESENTATION IS CONTEXTUAL =======
 *
 * Sean drew this line and it is the architecture: "Do not force Business and
 * Office into one UI or one rendering model merely to eliminate divergence."
 *
 * So this module answers "is it deferred" for everyone, and each surface
 * answers "what do I do about that" for itself. The two answers the product
 * has decided on:
 *
 *   Business   may suppress or deprioritise it. Its job is a concise,
 *              contextual read on the way past.
 *   Office     shows it, marked deferred. Its job is the complete working
 *              picture, and hiding work there would make the one surface an
 *              owner opens ON PURPOSE the surface that tells them least.
 *
 * A deferred item's live controls must not read as ordinarily actionable —
 * Sean: "Do not silently turn a deferred approval into something that looks
 * currently actionable." That is a rendering rule, enforced where the row is
 * rendered, and this type is what the renderer is handed.
 */
export type DeferredTreatment = "suppress" | "show_marked";

/** What each surface does with a deferred item. Named here so it is one decision. */
export const DEFERRED_TREATMENT: Record<"business" | "office", DeferredTreatment> = {
  business: "suppress",
  office: "show_marked",
};
