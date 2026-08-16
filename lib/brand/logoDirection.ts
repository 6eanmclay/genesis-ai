import type { BusinessUnderstanding } from "@/lib/businessModel/understanding";

// The logo prompt, built from what J4 actually knows (2026-08-16).
//
// Sean's requirement, and the reason this file exists rather than a call
// straight into generateBusinessIcon: "do not treat logo generation as a
// disconnected image generator... This is one of the first places where we
// should prove that J4 actually understands the business and can use that
// understanding to create something appropriate."
//
// generateBusinessIcon takes name + vision + personality, which is what was
// knowable during onboarding — a draft with three fields filled in. A store
// that has been running knows far more: what it sells, who buys it, what the
// owner has stated as goals, and what has already been decided about the
// brand. All of that is already assembled by getBusinessUnderstanding, and
// none of it was reaching the generator.
//
// THE OWNER REMAINS THE CREATIVE AUTHORITY. This produces a *direction* — a
// first proposal and a plain-English account of the thinking behind it, so
// the owner can disagree with the reasoning rather than just the picture.
// `refinement` carries their own words back in, and is deliberately weighted
// last in the prompt so it overrides the derived direction rather than
// competing with it: when the owner says "less literal", that beats anything
// inferred from the catalog.

export interface LogoDirection {
  /** The prompt actually sent to the image model. */
  prompt: string;
  /** What J4 is proposing and why, in the owner's language. Shown, not logged. */
  rationale: string;
  /** The grounding actually used — for the record, and for honesty about thin data. */
  groundedIn: string[];
}

function topProductNames(u: BusinessUnderstanding, limit: number): string[] {
  return u.profile.offerings.trends
    .map((t) => t.item.data.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .slice(0, limit);
}

export function buildLogoDirection(params: {
  understanding: BusinessUnderstanding;
  storeName: string;
  /** The owner's own words when they are reacting to a previous attempt. */
  refinement?: string | null;
  /** What we are moving away from, so a revision is not a coin flip. */
  previousPrompt?: string | null;
}): LogoDirection {
  const { understanding: u, storeName, refinement, previousPrompt } = params;

  const identity = u.profile.identity;
  const categories = u.profile.classification.businessCategories.map((c) => c.label);
  const products = topProductNames(u, 4);
  const goals = u.profile.goals.map((g) => g.data.description).slice(0, 2);
  const grounded: string[] = [];

  const parts: string[] = [
    `A clean, modern, iconic logo mark for a business called "${storeName}".`,
  ];

  if (identity.tagline) {
    parts.push(`It positions itself as: ${identity.tagline}.`);
    grounded.push("tagline");
  }
  if (identity.description) {
    parts.push(`What the business is: ${identity.description}`);
    grounded.push("description");
  }
  if (categories.length > 0) {
    parts.push(`Category: ${categories.join(", ")}.`);
    grounded.push("category");
  }
  if (products.length > 0) {
    // What they actually sell, which is usually a truer signal of the brand
    // than anything written about it.
    parts.push(`It sells: ${products.join(", ")}.`);
    grounded.push("catalog");
  }
  if (goals.length > 0) {
    parts.push(`Where the owner is taking it: ${goals.join("; ")}.`);
    grounded.push("stated goals");
  }

  // Craft constraints, unchanged in intent from generateBusinessIcon's own —
  // a logo has real requirements that are not up for interpretation.
  parts.push(
    "Square format, simple and recognizable at small sizes, no text or letters, centered composition, solid or softly gradiented background. A mark this business could use as its icon everywhere, not a photograph, not a scene, not a mockup."
  );

  if (previousPrompt) {
    parts.push(`This is a revision. The previous attempt was: ${previousPrompt}`);
  }
  // Last, so it wins. The owner's reaction outranks everything inferred.
  if (refinement) {
    parts.push(`The owner's direction, which takes priority over everything above: ${refinement}`);
    grounded.push("your direction");
  }

  const rationaleParts: string[] = [];
  if (refinement) {
    rationaleParts.push(`Reworked around what you said: ${refinement}`);
  } else if (grounded.length === 0) {
    // Honest rather than confident. A store J4 knows nothing about gets a
    // generic mark, and saying so is better than implying insight.
    rationaleParts.push(
      `I don't know much about ${storeName} yet, so this is a starting point rather than a considered direction. Tell me what it should feel like and I'll work from that instead.`
    );
  } else {
    rationaleParts.push(`I based this on your ${grounded.join(", ")}.`);
    if (products.length > 0) {
      rationaleParts.push(`What you actually sell says more about the brand than a description does, so ${products.slice(0, 2).join(" and ")} shaped it most.`);
    }
  }
  rationaleParts.push("Tell me what's wrong with it and I'll do another.");

  return {
    prompt: parts.filter(Boolean).join(" "),
    rationale: rationaleParts.join(" "),
    groundedIn: grounded,
  };
}
