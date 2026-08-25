import { randomUUID } from "crypto";
import { stateFact } from "./statements";
import { currentFacts } from "./factLifecycle";
import type { CanonicalRecord } from "./entities";
import type { SingletonFactType } from "./factLifecycle";

// THE OWNER'S OWN ANSWERS TO THE TWO QUESTIONS ONBOARDING ASKS.
//
//   offering — what the business sells or provides
//   intent   — what the owner wants the business or brand to be
//
// THIS FILE IS THE ONLY WRITER, and that is the point of it existing rather
// than the two call sites writing records directly. The rule these records
// live or die by is one sentence long:
//
//   A record is written only when the owner asserted the thing. Generated
//   content is never promoted into an owner-provenance record, on either
//   onboarding path, under any fallback.
//
// A fallback chain is exactly how the old code lost this. Confirmation read
// `inputVision ?? draft.description ?? draft.name` — so a business whose owner
// never described their vision got one anyway, assembled from copy a model had
// written about them, and nothing downstream could tell the difference. There
// are no `??` chains in this file for that reason.
//
// PROVENANCE IS NOT A PARAMETER HERE EITHER. Everything goes through stateFact,
// which fixes provenance to OWNER by construction. What the caller supplies is
// `modelExtracted`, which is the one thing the server knows and the owner does
// not: whether these are the owner's own typed words or a model's reading of
// them. Both are OWNER — the owner is the author either way — and only one of
// them is verbatim.
//
// See DRAFT_FIELD_SPLIT_CONTRACT.md.

/**
 * The business has exactly one CURRENT offering statement and one current intent.
 *
 * SUPERSESSION, NOT OVERWRITE (2026-08-24, D1/D2). These used to be fixed
 * external ids, so restating either one updated the row through the unique
 * constraint — one answer, and the previous one gone permanently. "They used to
 * sell candles and now sell rings" is real business knowledge and that design
 * destroyed it.
 *
 * Now each statement is its own record and the prior one is linked as superseded,
 * so `currentFacts` still returns exactly one and `factHistory` returns the
 * chain. A reader asking what the business sells still never has to pick.
 *
 * Kept exported because the onboarding write is still a singleton write and the
 * id documents that intent — but it is no longer what makes correction work.
 */
export const OWNER_FACT_IDS = {
  offering: "business_offering",
  intent: "business_intent",
} as const;

/** Where the statement came from. Recorded, never parsed for meaning. */
export type OwnerFactSource = "onboarding_form" | "onboarding_conversation";

export interface OwnerFactInput {
  /** The owner's statement. Null or blank means they did not tell us. */
  offering: string | null;
  intent: string | null;
  /**
   * True when a model read these out of something the owner said, false when
   * the owner typed them into a field.
   */
  modelExtracted: boolean;
  source: OwnerFactSource;
  /** When the owner said it — draft creation, not store creation. */
  statedAt?: Date;
}

/**
 * Which of a draft's contents are admissible as owner testimony.
 *
 * A PURE FUNCTION ON PURPOSE. This is the entire admissibility rule of
 * DRAFT_FIELD_SPLIT_CONTRACT.md section 4b, and it is the thing most worth
 * being able to test without a store, a user, or a database.
 *
 * TWO PATHS, DECIDED AS PATHS RATHER THAN FIELD BY FIELD. The form path's
 * answers are typed by the owner; the conversation path's are a model's
 * reading of what they said. Those carry different `modelExtracted` values, so
 * a draft cannot take its offering from one and its intent from the other
 * without one of the two records claiming to be something it is not.
 * `inputVision` is required by the form and absent from the conversation flow,
 * which makes it the honest discriminator.
 *
 * WHAT IS NOT ADMISSIBLE, and this is the whole point:
 *
 *   - `draft.description` and `draft.name` — generated, and the old confirm
 *     path's `inputVision ?? description ?? name` chain is exactly how a
 *     business ended up with a vision nobody had stated.
 *   - `concept.productDescription` — generated product copy.
 *   - `concept.creativeDirection.description` — generated brand copy.
 *
 * Only `ownerOffering` / `ownerIntent`, which the model was asked to source
 * from the visitor's own turns and to return null when they never said.
 */
export function ownerFactsFromDraft(draft: {
  inputProductType: string | null;
  inputVision: string | null;
  experienceState: unknown;
  createdAt?: Date;
}): OwnerFactInput | null {
  if (draft.inputVision?.trim()) {
    return {
      offering: draft.inputProductType,
      intent: draft.inputVision,
      // They typed these into a form. No model in between.
      modelExtracted: false,
      source: "onboarding_form",
      ...(draft.createdAt ? { statedAt: draft.createdAt } : {}),
    };
  }

  const concept = conceptOf(draft.experienceState);
  if (!concept) return null;
  if (!concept.ownerOffering?.trim() && !concept.ownerIntent?.trim()) return null;

  return {
    offering: concept.ownerOffering,
    intent: concept.ownerIntent,
    // A model read these out of the transcript. Still the owner's — they are
    // the author — but not their own words.
    modelExtracted: true,
    source: "onboarding_conversation",
    ...(draft.createdAt ? { statedAt: draft.createdAt } : {}),
  };
}

/**
 * The two admissible fields off an experience state, or nothing.
 *
 * Reads defensively rather than casting the whole state: this JSON was written
 * by earlier versions of the flow that had no such fields, and a session in
 * flight when this shipped simply has neither. Undefined reads as "not known",
 * which is the correct answer for those sessions.
 */
function conceptOf(experienceState: unknown): { ownerOffering: string | null; ownerIntent: string | null } | null {
  const concept = (experienceState as { concept?: unknown } | null)?.concept;
  if (!concept || typeof concept !== "object") return null;
  const { ownerOffering, ownerIntent } = concept as Record<string, unknown>;
  return {
    ownerOffering: typeof ownerOffering === "string" ? ownerOffering : null,
    ownerIntent: typeof ownerIntent === "string" ? ownerIntent : null,
  };
}

/**
 * Write whichever of the two the owner actually gave us.
 *
 * NOTHING IS WRITTEN FOR A BLANK. `inputProductType` is an optional field and a
 * short conversation genuinely may not establish either fact. Absence of a
 * record is the honest representation of "not known", it is what the whole
 * no-backfill decision rests on, and J4 already knows how to ask for what it is
 * missing. Manufacturing a value to avoid a null would defeat all three.
 */
export async function recordOwnerFacts(params: {
  storeId: string;
  userId: string;
  facts: OwnerFactInput;
}): Promise<{ written: ("offering" | "intent")[] }> {
  const { storeId, userId, facts } = params;
  const written: ("offering" | "intent")[] = [];

  const pairs: [("offering" | "intent"), string | null][] = [
    ["offering", facts.offering],
    ["intent", facts.intent],
  ];

  for (const [entityType, raw] of pairs) {
    const statement = raw?.trim();
    // Blank is not a statement. A whitespace-only field is a person who left it
    // empty, and recording it would put an empty answer where "not known" is
    // the truth.
    if (!statement) continue;

    const outcome = await stateFact({
      storeId,
      userId,
      entityType,
      data: { statement },
      modelExtracted: facts.modelExtracted,
      context: facts.source,
      // A NEW RECORD EACH TIME, superseding the last (D2). A fixed id here would
      // reinstate the overwrite this milestone removed: the unique constraint
      // would turn a correction back into an UPDATE and the prior statement
      // would be gone. stateFact resolves the singleton target and links it.
      externalId: `${OWNER_FACT_IDS[entityType]}:${randomUUID()}`,
      ...(facts.statedAt ? { statedAt: facts.statedAt } : {}),
    });
    // A refusal here is a programming error (unknown type, wrong shape), not a
    // condition to swallow — but it must not take down a store confirmation
    // that has already written products, integrations and a live storefront.
    if (!outcome.ok) {
      console.error(`recordOwnerFacts: ${entityType} not written — ${outcome.refusal}`, outcome.detail);
      continue;
    }
    written.push(entityType);
  }

  return { written };
}

/**
 * What the owner told us, or null where they did not.
 *
 * NEVER FALLS BACK to Store.description, brandIdentity.visionStatement, or
 * anything else generated. Those answer a different question — what the
 * storefront should SAY — and substituting one for the other is the exact
 * confusion these records were added to end.
 */
export async function readOwnerFacts(storeId: string): Promise<{
  offering: string | null;
  intent: string | null;
  targetAudience: string | null;
  brandPersonality: string | null;
  brandVoice: string | null;
  sellingProposition: string | null;
}> {
  // CURRENT, NOT ALL (D2). queryRecords would return superseded statements too,
  // and the newest-first ordering would usually hide that — usually being
  // exactly the word that makes it a bug rather than a behaviour.
  //
  // THE FOUR BRAND CLAIMS JOINED 2026-08-24 (D1-A). They were read out of
  // blueprint.brandIdentity, a blob where nothing could tell an audience the
  // owner stated from one a model invented during onboarding — and the
  // proactive layer read it either way.
  const [offering, intent, targetAudience, brandPersonality, brandVoice, sellingProposition] =
    await Promise.all([
      currentFacts(storeId, "offering"),
      currentFacts(storeId, "intent"),
      currentFacts(storeId, "targetAudience"),
      currentFacts(storeId, "brandPersonality"),
      currentFacts(storeId, "brandVoice"),
      currentFacts(storeId, "sellingProposition"),
    ]);
  return {
    offering: statementOf(offering),
    intent: statementOf(intent),
    targetAudience: statementOf(targetAudience),
    brandPersonality: statementOf(brandPersonality),
    brandVoice: statementOf(brandVoice),
    sellingProposition: statementOf(sellingProposition),
  };
}

/**
 * The one statement, from what should be a single record.
 *
 * Defensive about finding more than one: the fixed external ids make that a
 * constraint violation rather than a possibility, but a record written before
 * those ids existed, or by a future second writer, would show up here. Taking
 * the most recently stated is the only answer that can be right.
 */
function statementOf(
  // ANY SINGLETON OWNER FACT. All six carry the same one-field payload — the
  // fact IS the statement — so one reader serves them rather than six.
  records: CanonicalRecord<SingletonFactType>[]
): string | null {
  if (records.length === 0) return null;
  const newest = records.reduce((a, b) => {
    const at = a.statedAt?.getTime() ?? a.syncedAt.getTime();
    const bt = b.statedAt?.getTime() ?? b.syncedAt.getTime();
    return bt > at ? b : a;
  });
  const statement = newest.data.statement.trim();
  return statement.length > 0 ? statement : null;
}
