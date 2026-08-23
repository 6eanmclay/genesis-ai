import type { BusinessUnderstanding } from "./understanding";
import { describeStatedAge, isFirstPartyEvidence } from "./provenance";

// WHAT J4 KNOWS, AT THE MOMENT IT DECIDES (2026-08-22, Unified Intelligence UI1).
//
// THE DEFECT THIS CLOSES. The unified call — the one that chooses what J4 does —
// received the message, the ACTIVE PRODUCT NAMES, the workspace path and any
// proposal on the table. It did not receive the business. getBusinessUnderstanding
// was fetched INSIDE the look_up_business_data branch, after the tool had already
// been chosen, so J4 picked blind and then discovered the business afterwards.
//
// The prompts already showed the strain, which is how the audit found it rather
// than guessing at it. generate_brand_logo's description had to say "this tool
// reads their real business understanding itself, so do NOT call
// look_up_business_data first" — a workaround for having nothing at decision
// time. The same description said "if the merchant already has a logo, do NOT
// call this", an instruction the model had no data to obey.
//
// A PURE PROJECTION OF THE CANONICAL OBJECT, and that is the whole design.
// Nothing here queries. It takes the BusinessUnderstanding the caller already
// fetched and reduces it — so there is exactly one representation of what J4
// knows, and this is a view of it rather than a rival to it. A digest that
// gathered its own data would be the parallel model this project has refused
// twice now.
//
// A DIGEST, NOT THE WHOLE THING. The deciding call needs to know WHAT EXISTS —
// is there a logo, are there goals, what is connected, how well-sourced is any
// of it — not every figure. The full object is what look_up_business_data
// already sends when it is actually answering. This one carries on every turn,
// including the simplest, so it is capped in every dimension and its size is
// asserted rather than hoped for.

/** Hard ceilings. Every list here is capped, and the suite asserts the total. */
const MAX_ITEMS = 5;
const MAX_CLAIM_CHARS = 120;
/**
 * The budget the whole rendered digest must fit inside.
 *
 * Chosen to be small against the ~8k tokens of system prompt and tool catalog
 * already carried every turn, and asserted so it cannot grow quietly as a
 * business does. A store with four hundred products must produce the same size
 * digest as one with four.
 */
export const DIGEST_CHAR_BUDGET = 2400;

function truncate(text: string, max = MAX_CLAIM_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export interface UnderstandingDigest {
  name: string;
  tagline: string | null;
  /** What the business is, in its own classification's words. */
  categories: string[];
  activeProductCount: number;
  productNames: string[];
  /**
   * WHICH ASSET ROLES ARE ALREADY HELD — the direct answer to "do they already
   * have a logo", which the model previously had to be told not to guess at.
   */
  assetRolesHeld: string[];
  goals: string[];
  challenges: string[];
  /** What is standing in the way of what, in one line each. */
  blocked: string[];
  connectedSystems: { name: string; stale: boolean }[];
  /** What J4 currently believes, with how well-established each one is. */
  beliefs: { claim: string; maturity: string }[];
  /** The nearest dated obligations, so a plan does not ignore a deadline. */
  commitments: { title: string; dueDate: string }[];
  /**
   * HOW WELL-SOURCED THE PICTURE IS, in one pair of numbers.
   *
   * Not a quality score — a statement about coverage. A business whose facts are
   * mostly unsourced is not less true, it is less traceable, and a model told
   * that reasons differently about how confidently to attribute things.
   */
  sourcing: { withRecordedSource: number; withoutRecordedSource: number };
  /** How stale the oldest thing the owner told us is. Null when nothing is dated. */
  oldestOwnerStatement: string | null;
}

/**
 * Reduce the canonical understanding to what the deciding call needs.
 *
 * `now` is injectable so ages render deterministically in a suite rather than
 * against the wall clock.
 */
export function digestOf(
  understanding: BusinessUnderstanding,
  now: Date = new Date()
): UnderstandingDigest {
  const { profile } = understanding;

  const sourced = [...profile.goals, ...profile.challenges, ...profile.assets];
  const withRecordedSource = sourced.filter((r) => r.provenance !== null).length;

  // The oldest thing the OWNER said, specifically — not the oldest fact. A
  // connector's figure being old means it needs a sync; an owner's goal being
  // old means it may no longer be their goal, which is a different question and
  // the only one worth raising in conversation.
  const ownerStated = sourced
    .filter((r) => r.provenance === "OWNER" && r.statedAt !== null)
    .map((r) => r.statedAt!.getTime());
  const oldestOwnerStatement = ownerStated.length
    ? describeStatedAge(new Date(Math.min(...ownerStated)), now)
    : null;

  return {
    name: profile.identity.name,
    tagline: profile.identity.tagline ? truncate(profile.identity.tagline, 80) : null,
    categories: profile.classification.businessCategories.slice(0, MAX_ITEMS).map((c) => c.label),
    activeProductCount: profile.offerings.activeCount,
    productNames: profile.offerings.trends
      .slice(0, MAX_ITEMS)
      .map((t) => truncate(t.item.data.name, 60)),
    // Roles, not files. "There is a logo" is what changes a decision; which URL
    // it lives at does not, and an internal id in a prompt is noise at best.
    assetRolesHeld: Object.keys(understanding.currentAssets).slice(0, MAX_ITEMS * 2),
    goals: profile.goals
      .filter((g) => g.data.status === "active")
      .slice(0, MAX_ITEMS)
      .map((g) => truncate(g.data.description)),
    challenges: profile.challenges
      .filter((c) => c.data.status === "active")
      .slice(0, MAX_ITEMS)
      .map((c) => truncate(c.data.description)),
    blocked: understanding.blockedGoals
      .slice(0, MAX_ITEMS)
      .map((b) => `${truncate(b.goal, 60)} — held up by ${truncate(b.blockedBy.map((x) => x.challenge).join("; "), 80)}`),
    connectedSystems: profile.connectedSystems
      .slice(0, MAX_ITEMS)
      .map((s) => ({ name: s.displayName, stale: s.isStale })),
    beliefs: understanding.beliefs
      .slice(0, MAX_ITEMS)
      .map((b) => ({ claim: truncate(b.claim), maturity: b.maturity })),
    commitments: (understanding.commitments.upcoming ?? [])
      .slice(0, MAX_ITEMS)
      .map((c) => ({ title: truncate(c.title, 60), dueDate: c.dueDate })),
    sourcing: {
      withRecordedSource,
      withoutRecordedSource: sourced.length - withRecordedSource,
    },
    oldestOwnerStatement,
  };
}

/**
 * The digest as the model reads it.
 *
 * Plain lines rather than JSON, deliberately: this sits in a user-turn message
 * alongside other parenthetical context lines that are already prose, and a JSON
 * blob in the middle of them reads as a different kind of thing. Empty sections
 * are OMITTED rather than rendered as "none" — a business with no connected
 * systems should not spend context saying so on every turn, and an absent line
 * is not a claim the way an empty one is.
 */
export function renderDigest(digest: UnderstandingDigest): string {
  const lines: string[] = [];

  const identity = [digest.name, digest.tagline].filter(Boolean).join(" — ");
  lines.push(`Business: ${identity}${digest.categories.length ? ` (${digest.categories.join(", ")})` : ""}`);

  if (digest.activeProductCount > 0) {
    lines.push(
      `Sells: ${digest.activeProductCount} active product${digest.activeProductCount === 1 ? "" : "s"}` +
        (digest.productNames.length ? ` — ${digest.productNames.join(", ")}` : "")
    );
  } else {
    // Worth saying, because it changes what is worth proposing.
    lines.push("Sells: nothing active yet");
  }

  // THE LINE THAT REPLACES A PROMPT WORKAROUND. generate_brand_logo's
  // description told the model not to offer a logo to someone who has one,
  // without giving it any way to know. This is the way.
  if (digest.assetRolesHeld.length) {
    lines.push(`Already has: ${digest.assetRolesHeld.join(", ")}`);
  }

  if (digest.goals.length) lines.push(`Goals: ${digest.goals.join("; ")}`);
  if (digest.challenges.length) lines.push(`Challenges: ${digest.challenges.join("; ")}`);
  if (digest.blocked.length) lines.push(`In the way: ${digest.blocked.join(" | ")}`);

  if (digest.connectedSystems.length) {
    lines.push(
      `Connected: ${digest.connectedSystems
        .map((s) => `${s.name}${s.stale ? " (stale)" : ""}`)
        .join(", ")}`
    );
  }

  if (digest.beliefs.length) {
    lines.push(
      `You currently believe: ${digest.beliefs.map((b) => `${b.claim} [${b.maturity}]`).join(" | ")}`
    );
  }

  if (digest.commitments.length) {
    lines.push(`Dated: ${digest.commitments.map((c) => `${c.title} (${c.dueDate})`).join(", ")}`);
  }

  if (digest.oldestOwnerStatement) {
    lines.push(`Oldest thing they told you: ${digest.oldestOwnerStatement}`);
  }

  const { withRecordedSource, withoutRecordedSource } = digest.sourcing;
  if (withRecordedSource + withoutRecordedSource > 0) {
    lines.push(
      `Sourcing: ${withRecordedSource} of ${withRecordedSource + withoutRecordedSource} of these facts record where they came from.`
    );
  }

  const rendered = `(What you know about this business:\n${lines.map((l) => `  ${l}`).join("\n")})`;

  // THE CEILING IS ENFORCED, not merely documented. Every list above is capped,
  // so exceeding this means a single field grew unboundedly — and a digest that
  // quietly doubled would push conversation history out of a cached prompt
  // without anybody noticing.
  return rendered.length <= DIGEST_CHAR_BUDGET
    ? rendered
    : `${rendered.slice(0, DIGEST_CHAR_BUDGET - 2)}…)`;
}

/**
 * Whether this digest describes a business J4 knows anything real about.
 *
 * Used to decide whether it is worth sending at all. A brand-new store with no
 * products, no goals and nothing connected produces a line of identity and
 * nothing else, and sending that every turn teaches the model nothing.
 */
export function digestIsSubstantive(digest: UnderstandingDigest): boolean {
  return (
    digest.activeProductCount > 0 ||
    digest.goals.length > 0 ||
    digest.challenges.length > 0 ||
    digest.assetRolesHeld.length > 0 ||
    digest.connectedSystems.length > 0 ||
    digest.beliefs.length > 0 ||
    digest.commitments.length > 0
  );
}

/**
 * Whether any of the facts behind this digest are first-party evidence.
 *
 * Exported for the same reason the sourcing counts are carried: a picture built
 * entirely out of J4's own conclusions is a different thing to reason from than
 * one a bank and an owner contributed to, and the difference should be legible
 * rather than inferred from a count.
 */
export function hasFirstPartyEvidence(understanding: BusinessUnderstanding): boolean {
  return [...understanding.profile.goals, ...understanding.profile.challenges, ...understanding.profile.assets]
    .some((r) => isFirstPartyEvidence(r.provenance));
}
