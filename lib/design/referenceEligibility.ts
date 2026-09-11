import { z } from "zod";

/**
 * IS THIS PICTURE A DESIGN REFERENCE AT ALL?
 *
 * ============ THE FAILURE THIS EXISTS TO STOP (2026-09-10) ============
 *
 * Demonstrated, not anticipated. The first live run fed J4 a mascot logo on a
 * black background and asked it to read the design. It produced four
 * structurally perfect proposals - real observations, honest citations, zero
 * rejected by any gate - including this one:
 *
 *   I saw:      A small green label element near the bottom has fully
 *               rounded pill-shaped ends.
 *   I'd change: Button style: pill
 *
 * A logo's own label, read as guidance for the owner's buttons. It even
 * correctly marked the mascot, the glowing ring and the framing as things it
 * could not act on, so it was not confused about what it was looking at. It
 * simply answered the question it was asked.
 *
 * The ReferenceReading validator was right the whole time and is untouched:
 * it guarantees a reading is internally consistent and executable, which it
 * was. What no amount of internal consistency can supply is whether the
 * picture was the right KIND of picture. That is this file's only job.
 *
 * ============ IT CANNOT PRODUCE A DESIGN INSTRUCTION ==================
 *
 * Sean: "Do not let the eligibility layer produce executable values."
 *
 * So the schema below has no dimension field, no value field, and no proposal
 * array. Its entire output is a label from a closed list and one sentence of
 * description. There is nothing in it that could reach a storefront even if
 * something downstream tried to use it, which is the same data-shape argument
 * the reading's own guardrail rests on.
 *
 * ============ CONSERVATIVE ON PURPOSE ================================
 *
 * Sean: "Do not attempt to make this a perfect image classifier. The goal is a
 * conservative safety boundary: when the image isn't clearly a design
 * reference, don't turn it into storefront instructions."
 *
 * So `unsure` is a refusal, not a pass. The cost of wrongly refusing a real
 * screenshot is that the owner uploads it again or says what they liked; the
 * cost of wrongly accepting a product photo is a store changed on the strength
 * of a label on a mascot.
 */

/** What the picture is. A closed list, so nothing can be invented at runtime. */
export const REFERENCE_KINDS = [
  "website_or_app_screenshot",
  "product_photo",
  "logo_or_mascot",
  "document_or_text",
  "person_or_place",
  "other",
] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export const ReferenceEligibilitySchema = z.object({
  /** One sentence about what is in the picture. Never a design instruction. */
  what: z.string().min(1),
  looksLike: z.enum(REFERENCE_KINDS),
  /** `unsure` is a refusal. Being sure is the requirement, not a bonus. */
  confidence: z.enum(["clear", "unsure"]),
});

export type ReferenceEligibility = z.infer<typeof ReferenceEligibilitySchema>;

export type EligibilityVerdict =
  | { eligible: true; kind: ReferenceKind }
  | { eligible: false; because: string };

/** How each refusal is explained, in the owner's terms rather than the model's. */
const REFUSAL: Record<Exclude<ReferenceKind, "website_or_app_screenshot">, string> = {
  product_photo:
    "That looks like a photo of a product rather than a website design. If it is one of yours, upload it as a " +
    "product image and I will use it there. If you meant the site it came from, send me a screenshot of the page.",
  logo_or_mascot:
    "That looks like a logo or an illustration rather than a website design. I could read shapes off it, but they " +
    "would not be design decisions about a page - send me a screenshot of a site you like and I will read that instead.",
  document_or_text:
    "That looks like a document rather than a website design. Upload a screenshot of a page you like and I will read " +
    "its layout, spacing and type.",
  person_or_place:
    "That looks like a photograph rather than a website design. Send me a screenshot of a site whose look you want " +
    "and I will read that.",
  other:
    "I could not tell that this is a screenshot of a website or app, so I am not going to turn it into design " +
    "decisions for your store. Send me a screenshot of a page you like and I will read it properly.",
};

/**
 * The verdict, from an assessment. Pure, and the whole decision.
 *
 * Separated from the model call on purpose: "what counts as eligible" is the
 * part worth testing, and it needs no API key to exercise.
 */
export function verdictFor(assessment: ReferenceEligibility): EligibilityVerdict {
  if (assessment.looksLike !== "website_or_app_screenshot") {
    return { eligible: false, because: REFUSAL[assessment.looksLike] };
  }
  if (assessment.confidence !== "clear") {
    // UNSURE IS A REFUSAL. The asymmetry is the point: a wrongly refused
    // screenshot costs one more upload, a wrongly accepted product photo
    // costs a storefront changed on the strength of something that was never
    // a design decision.
    return {
      eligible: false,
      because:
        "I am not confident enough that this is a screenshot of a website or app, and I would rather ask than " +
        "change your store based on a guess. Send me a clearer screenshot of the page you like.",
    };
  }
  return { eligible: true, kind: assessment.looksLike };
}

export const ASSESS_REFERENCE_SYSTEM_PROMPT = `Look at this image and say what KIND of thing it is. That is your only job: you are not designing anything and you are not making recommendations.

Answer with:
  what        — one plain sentence describing what is in the picture.
  looksLike   — exactly one of:
                  website_or_app_screenshot  a screen from a website or an application: a page with navigation,
                                             sections, text and controls laid out as an interface
                  product_photo              a photograph or render of a physical product
                  logo_or_mascot             a logo, wordmark, icon, character or illustration on its own
                  document_or_text           a document, invoice, receipt, contract, spreadsheet or page of text
                  person_or_place            a photograph of people, a place, or a scene
                  other                      anything else, or you cannot tell
  confidence  — "clear" if you are confident in that label, "unsure" if you are not.

Be strict about website_or_app_screenshot. A logo on a coloured background is NOT a screenshot. A product photo that happens to sit on a web page IS a product photo if that is what fills the frame. If you are weighing it up, the answer is "unsure" — something downstream will ask the owner rather than guess, and that is the outcome we want.`;
