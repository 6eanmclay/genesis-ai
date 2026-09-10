import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { callGenesisModel } from "@/lib/genesisModel";
import { REFINABLE_DIMENSIONS, REFINABLE_DIMENSION_KEYS } from "@/lib/storefront/dimensions";
import {
  actionableProposals,
  misattributedProposals,
  unusableProposals,
  uncitedProposals,
  seenButNotActionable,
  type ReferenceReading,
} from "./referenceObservation";

/**
 * READING A SCREENSHOT THE OWNER LIKES, AS DESIGN LANGUAGE.
 *
 * ============ OBSERVE, THEN CLASSIFY, THEN PROPOSE ====================
 *
 * Sean: "Do not let the model infer bearsOn from the proposal it wants to
 * make. The observation exists independently of the proposed change."
 *
 * That ordering is the whole design of the schema below, and it is a schema
 * decision rather than a sentence in a prompt. `observations` is a separate
 * array from `proposals`; an observation carries `what` (a description of the
 * picture) and `bearsOn` (a classification of that description), and a
 * proposal can only point back at one by id.
 *
 * The failure being designed out is specific: a model that has decided to
 * propose `cardStyle: sharp` and then writes an observation to justify it.
 * Asking for the description first, in its own field, and the classification
 * second, gives it nothing to work backwards from - and where it does anyway,
 * the gate in referenceObservation.ts refuses the result.
 *
 * ============ MODEL OUTPUT IS UNTRUSTED INPUT ========================
 *
 * Sean: "Model output is untrusted input and must pass the same validation
 * before it can reach the approval card or execution path."
 *
 * So this module VALIDATES, it does not decide. Everything it returns has been
 * through the same functions the offline suite exercises, and a reading that
 * fails them arrives with its faults named rather than trimmed. Nothing here
 * writes to a store, and nothing here can approve anything.
 *
 * ============ PRINCIPLES OUT, NEVER ASSETS ===========================
 *
 * There is no field in this schema capable of carrying a hex value, a font
 * name, an image or a line of the reference's copy. `value` is constrained to
 * a dimension's own enumerated words at the boundary AND at the gate, and
 * `what` is prose about the picture that never reaches the store.
 */

/**
 * The model's raw shape.
 *
 * `bearsOn` is a nullable enum of REFINABLE_DIMENSION_KEYS: a model that wants
 * to say "this is about the photography" has exactly two honest choices -
 * name a real dimension, or say null. It cannot invent a name here, which is
 * the runtime half of "do not invent a new dimension at runtime".
 */
const ObservationSchema = z.object({
  id: z.string().min(1),
  what: z.string().min(1),
  bearsOn: z.enum(REFINABLE_DIMENSION_KEYS as [string, ...string[]]).nullable(),
});

const ProposalSchema = z.object({
  dimension: z.enum(REFINABLE_DIMENSION_KEYS as [string, ...string[]]),
  value: z.string().min(1),
  becauseOf: z.string().min(1),
  soThat: z.string().min(1),
});

export const ReferenceReadingSchema = z.object({
  inWords: z.string().min(1),
  observations: z.array(ObservationSchema),
  proposals: z.array(ProposalSchema),
});

/** Every dimension and its permitted values, written out for the prompt. */
export function vocabularyForPrompt(): string {
  return REFINABLE_DIMENSION_KEYS.map((key) => {
    const dimension = REFINABLE_DIMENSIONS[key];
    return `  ${key} (${dimension.label}): ${dimension.values.join(" | ")}`;
  }).join("\n");
}

export const ANALYZE_REFERENCE_SYSTEM_PROMPT = `You are looking at a screenshot of a website an owner has said they like. Your job is to read its DESIGN LANGUAGE so their own store can be moved toward it.

Work in three separate steps, and do not let a later step change an earlier one.

STEP 1 — OBSERVE. Describe what is actually visible in the image. Each observation is one plain sentence about THE REFERENCE, not about the owner's store and not a recommendation. Write these before you have decided what to change.
  Good: "The headings are several times larger than the body text."
  Good: "Product photographs run edge to edge with no border or frame."
  Bad:  "Their type scale should be display." (that is a proposal)
  Bad:  "You should use more space." (that is about the owner's store)

STEP 2 — CLASSIFY. For each observation, say which single dimension of the owner's storefront it genuinely relates to, or null.

The dimensions available, with their only permitted values:
${vocabularyForPrompt()}

null is a correct and expected answer. A screenshot contains far more design than these ten dimensions can express — an asymmetric grid, a sticky navigation bar, a particular photographic style, motion, illustration, iconography, a logo. When an observation is about something in that list, bearsOn MUST be null.

DO NOT choose the closest available dimension. An observation about photography is not an observation about card corners. If nothing genuinely fits, null is the honest answer and the owner will still be shown what you saw.

Classify the observation you actually wrote. Do not adjust it so that a dimension fits.

STEP 3 — PROPOSE. Only now, and only for observations whose bearsOn is not null, suggest a change to the owner's store.
  - dimension MUST equal that observation's bearsOn.
  - value MUST be one of that dimension's permitted values above, exactly as written.
  - becauseOf MUST be the id of the observation it follows from.
  - soThat is one sentence for the owner about why it is worth doing.

Never propose a change for an observation whose bearsOn is null. Never invent a dimension or a value. Never copy a colour, a font name, a logo, an image, or any of the reference's own words into a value — you are extracting principles, not assets.

Fewer, well-founded proposals are better than covering every dimension.`;

export interface ReferenceAnalysis {
  reading: ReferenceReading;
  /** Proposals the owner may approve. Already through the gate. */
  actionable: ReturnType<typeof actionableProposals>;
  /** Things J4 saw and cannot act on. Shown, never dropped. */
  seenOnly: string[];
  /**
   * Everything the model got wrong, named.
   *
   * Empty on a good reading. Non-empty is reported rather than thrown: the
   * usable half of a partly-bad reading is still worth showing, and a silent
   * trim is how "eight executions failed and J4 said it went well" happened.
   */
  rejected: string[];
}

/** Validate a reading that came from anywhere. Model output is untrusted. */
export function validateReading(reading: ReferenceReading): ReferenceAnalysis {
  return {
    reading,
    actionable: actionableProposals(reading),
    seenOnly: seenButNotActionable(reading),
    rejected: [
      ...unusableProposals(reading),
      ...uncitedProposals(reading).map((d) => `${d} cites an observation that does not exist`),
      ...misattributedProposals(reading),
    ],
  };
}

/**
 * Read an uploaded screenshot as design language.
 *
 * The image block is the same one classifyAndExtractAsset uses - a stored URL
 * handed to the model - because there is one image ingestion path in this
 * codebase and this is not a reason to build a second. That module asks "what
 * business fact is this"; this asks the opposite question of the same picture.
 *
 * Returns null when the call fails or produces nothing parseable. A caller
 * must not present a null as "the reference had no design worth noting".
 */
export async function analyzeReferenceImage(params: {
  imageUrl: string;
  storeId: string;
}): Promise<ReferenceAnalysis | null> {
  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      system: ANALYZE_REFERENCE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: params.imageUrl } },
            {
              type: "text",
              text: "Read this reference's design language. Observe first, classify second, propose third.",
            },
          ],
        },
      ],
      output_config: { effort: "medium", format: zodOutputFormat(ReferenceReadingSchema) },
    },
    { storeId: params.storeId, feature: "reference_design_analysis" },
  );

  if (!outcome.ok || !outcome.message.parsed_output) return null;
  // Straight into the same validation the offline suite exercises. The model
  // has no privileged path to the approval card.
  return validateReading(outcome.message.parsed_output as ReferenceReading);
}
