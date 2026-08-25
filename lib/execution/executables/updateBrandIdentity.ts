import { prisma } from "@/lib/prisma";
import { stateFact } from "@/lib/businessModel/statements";
import { currentFacts } from "@/lib/businessModel/factLifecycle";
import { verifyBlueprintSection } from "../readBack";
import { verifiedUnless, type VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

export interface UpdateBrandIdentityInput {
  brandStory: string;
  missionStatement: string;
  visionStatement: string;
  brandPromise: string;
  coreValues: string[];
  brandPersonality: string;
  brandVoiceAndTone: string;
  targetAudience: string;
  uniqueSellingProposition: string;
}

// Twin of updateHero.ts/updateSeo.ts — same opaque-JSON blueprint merge
// pattern, targeting brandIdentity instead of homepageContent/marketingAssets.
interface BlueprintShape {
  brandIdentity?: Record<string, unknown>;
  [key: string]: unknown;
}

/** What the storefront renders. The other four input fields are claims, not copy. */
const COPY_FIELDS = [
  "brandStory",
  "missionStatement",
  "visionStatement",
  "brandPromise",
  "coreValues",
] as const;

/**
 * The copy half of the input — and only the keys it actually carries.
 *
 * PRESENCE, NOT VALUE, and that distinction is the whole function. This used to
 * merge `...input` wholesale, so a caller sending one field changed one field.
 * Splitting the claims out by naming the five copy fields explicitly quietly
 * changed that: an absent key became `undefined` written over a real value, and
 * a partial update erased missionStatement and coreValues. Caught by
 * verify-blueprint-writers, which exists for precisely this.
 *
 * A caller must still be able to clear a field by sending "", so absence is
 * what is filtered on, never falsiness.
 */
function copyFieldsOf(input: UpdateBrandIdentityInput): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const field of COPY_FIELDS) {
    if (Object.hasOwn(input, field)) copy[field] = input[field];
  }
  return copy;
}

/**
 * The four claims: entity type, and the input field carrying it.
 *
 * One list, read by both run() and verify(), because a verify that checks a
 * different set than run() writes is the failure mode this repository keeps
 * finding — a rule true for one of something after that something became plural.
 */
const CLAIM_FIELDS = [
  ["targetAudience", "targetAudience"],
  ["brandPersonality", "brandPersonality"],
  ["brandVoice", "brandVoiceAndTone"],
  ["sellingProposition", "uniqueSellingProposition"],
] as const;

export const updateBrandIdentityExecutable: Executable<UpdateBrandIdentityInput, Record<string, never>> = {
  action: EXECUTION_ACTIONS.STORE_UPDATE_BRAND_IDENTITY,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { blueprint: true },
    });
    const blueprint = (store.blueprint as BlueprintShape | null) ?? {};
    // COPY TO THE BLUEPRINT, CLAIMS TO THE FACT LIFECYCLE (2026-08-24, D1-A).
    //
    // brandStory and the other narrative fields are what the storefront renders,
    // and they stay exactly where they were. The four the proactive layer
    // REASONS from are claims about the business, so they go where claims live —
    // with an author, a date, and a correction path.
    const updatedBlueprint: BlueprintShape = {
      ...blueprint,
      brandIdentity: { ...blueprint.brandIdentity, ...copyFieldsOf(input) },
    };
    await prisma.store.update({
      where: { id: ctx.storeId },
      data: { blueprint: updatedBlueprint as object },
    });

    // OWNER provenance by construction — stateFact does not take it as a
    // parameter. modelExtracted false: this executable runs on an owner's
    // approved change, not a model's reading of one.
    for (const [entityType, field] of CLAIM_FIELDS) {
      const statement = input[field];
      if (!statement?.trim()) continue;
      // NO OWNER, NO OWNER TESTIMONY. ctx.userId is null for a SYSTEM or
      // autonomous actor, and stateFact fixes provenance to OWNER by
      // construction — writing one here would attribute a claim to a person who
      // did not make it. Skipped rather than forged; the invariant working.
      if (!ctx.userId) continue;
      await stateFact({
        storeId: ctx.storeId,
        userId: ctx.userId,
        entityType,
        data: { statement },
        modelExtracted: false,
        context: "brand_identity",
      });
    }

    return { message: "Updated brand identity" };
  },

  // CLASS B — a merge into blueprint.brandIdentity. Only the keys this input named
  // are compared: that section holds keys written by other actions too, and
  // comparing the whole of it would fail a merge that did exactly what it
  // promised.
  async verify(input, ctx): Promise<VerificationOutcome> {
    // THE READ-BACK MOVED WITH THE FIELDS; IT DID NOT SHRINK.
    //
    // The copy is still a blueprint merge, so it is still Class B. The four
    // claims now live in the fact lifecycle, so they are read back from THERE —
    // dropping them here instead would have quietly stopped verifying four of
    // the nine things this action writes.
    const copy = await verifyBlueprintSection(ctx.storeId, "brandIdentity", copyFieldsOf(input));

    // Propagated rather than folded away: "could not be checked" is not "checked
    // and fine", and flattening it into an empty mismatch list would say so.
    if (copy.state === "unavailable") return copy;
    const mismatches = copy.state === "failed" ? [...copy.mismatches] : [];
    for (const [entityType, statement] of CLAIM_FIELDS) {
      const wanted = input[statement];
      // Not sent, or no owner to attribute it to — run() wrote nothing, so
      // there is nothing to verify. Asserting a fact here would fail the action
      // for correctly declining to forge one.
      if (!wanted?.trim() || !ctx.userId) continue;
      const current = await currentFacts(ctx.storeId, entityType);
      const stored = (current[0]?.data as { statement?: string } | undefined)?.statement;
      if (stored !== wanted) {
        mismatches.push(`${entityType}: stored ${JSON.stringify(stored)}, asked for ${JSON.stringify(wanted)}`);
      }
    }
    return verifiedUnless(mismatches);
  },
};
