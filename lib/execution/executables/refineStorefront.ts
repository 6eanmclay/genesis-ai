import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";
import { DEFAULT_THEME, type Theme, type Presentation, type Composition } from "@/lib/theme";
import {
  isRefinableDimension,
  isValidDimensionValue,
  dimensionGroup,
  describeDimension,
  type RefinableDimensionKey,
} from "@/lib/storefront/dimensions";

// Storefront Canvas, step 3 of 6 (2026-08-12) — one improvement, applied.
//
// This is the verb the whole canvas converges on. It exists because
// update_theme is a single five-point action covering colours AND typography
// AND layout AND presentation AND composition, so "nudge the hero layout"
// cost the same as a rebrand and arrived as one enormous diff. That is the
// giant redesign this product is trying not to do, only delayed.
//
// One approval is one improvement is one charge. The list of changes is the
// implementation detail of a single idea: "make the hero feel more premium"
// may legitimately be a split layout AND a display type scale AND roomier
// spacing. The engine charges once per execute(), so Sean's pricing rule
// ("one Growth Point per approved meaningful change, regardless of how many
// underlying mutations") needs no billing code at all — only this shape.
//
// Business Partner pays nothing for it, and that too needs no code here: the
// catalog price is 2 GP and that tier's unlimitedActionCostCeiling is 2, so
// lib/growthPoints/ledger.ts waives the deduction at the entitlement layer
// while this action's contract stays exactly as written.

export interface RefineStorefrontChange {
  dimension: string;
  value: string;
}

export interface RefineStorefrontInput {
  /** A key of STOREFRONT_TARGETS — which part of the storefront this concerns. */
  target: string;
  /** 1 to 4 mutations that together constitute ONE improvement. */
  changes: RefineStorefrontChange[];
  /** Required. The evidence behind the improvement. */
  reason: string;
  /** One owner-facing sentence, shown on the approval card. */
  summary: string;
}

/**
 * Applies a set of refinements to a theme. Pure, and deliberately shared.
 *
 * Extracted from run() (2026-08-14) so the visual proposal preview can render
 * the storefront exactly as executing this action would leave it. Two copies
 * of this transform would be a preview that quietly lies: the owner would
 * approve one storefront and receive another, and nothing would report an
 * error. One function, two callers, so any divergence is a compile error
 * rather than a silent difference the owner discovers after approving.
 *
 * Throws on an invalid dimension or value. Validated here rather than only at
 * the schema boundary, so this holds regardless of how the input arrived —
 * which now includes a stored ApprovalRequest.input read back much later, not
 * just a freshly validated tool call.
 */
export function applyRefinementsToTheme(current: Theme, changes: RefineStorefrontChange[]): Theme {
  // Start from the store's real current values, falling back to the defaults
  // lib/theme.ts documents as reproducing the storefront's original hardcoded
  // rendering. A store that predates presentation or composition therefore
  // gains a complete, known-good set rather than a half-populated one.
  const presentation: Presentation = { ...(current.presentation ?? DEFAULT_THEME.presentation!) };
  const composition: Composition = { ...(current.composition ?? DEFAULT_THEME.composition!) };

  for (const change of changes) {
    if (!isRefinableDimension(change.dimension)) {
      throw new Error(`Not a refinable part of the storefront: ${change.dimension}`);
    }
    if (!isValidDimensionValue(change.dimension, change.value)) {
      throw new Error(`"${change.value}" is not a real option for ${describeDimension(change.dimension)}.`);
    }
    if (dimensionGroup(change.dimension) === "presentation") {
      (presentation as Record<string, string>)[change.dimension] = change.value;
    } else {
      (composition as Record<string, string>)[change.dimension] = change.value;
    }
  }

  // Colours and typography are deliberately untouched. This action changes
  // structure and presentation only; a palette or font change remains
  // update_theme's job, which is the separation that keeps this one small.
  return { ...current, presentation, composition };
}

export const refineStorefrontExecutable: Executable<
  RefineStorefrontInput,
  { applied: { dimension: string; value: string }[] }
> = {
  action: EXECUTION_ACTIONS.STORE_REFINE_STOREFRONT,
  requiredPermission: PERMISSIONS.STORE_MANAGE,

  async run(input, ctx) {
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { theme: true },
    });
    const current = (store.theme as Theme | null) ?? DEFAULT_THEME;

    const nextTheme = applyRefinementsToTheme(current, input.changes);

    await prisma.store.update({
      where: { id: ctx.storeId },
      data: { theme: nextTheme as unknown as object },
    });

    const applied = input.changes.map((c) => ({ dimension: c.dimension, value: c.value }));
    return {
      message:
        applied.length === 1
          ? `Refined ${describeDimension(applied[0].dimension as RefinableDimensionKey).toLowerCase()} to ${applied[0].value}`
          : `Refined ${applied.length} parts of the storefront`,
      metadata: { applied },
    };
  },

  // Real verification, not a formality. Re-reads the stored theme and
  // confirms every requested mutation actually landed. A partial application
  // must fail rather than report success, because the owner approved one
  // improvement and half an improvement is not it — and because a FAILED
  // result is what stops the engine charging for it.
  async verify(input, ctx) {
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { theme: true },
    });
    const stored = (store.theme as Theme | null) ?? DEFAULT_THEME;

    const missing: string[] = [];
    for (const change of input.changes) {
      if (!isRefinableDimension(change.dimension)) {
        missing.push(change.dimension);
        continue;
      }
      const group = dimensionGroup(change.dimension) === "presentation" ? stored.presentation : stored.composition;
      const actual = (group as Record<string, string> | undefined)?.[change.dimension];
      if (actual !== change.value) {
        missing.push(`${describeDimension(change.dimension)} (expected ${change.value}, found ${actual ?? "nothing"})`);
      }
    }

    if (missing.length > 0) {
      return {
        ok: false,
        error: `The storefront was not fully updated. Still wrong: ${missing.join("; ")}.`,
      };
    }
    return { ok: true };
  },
};
