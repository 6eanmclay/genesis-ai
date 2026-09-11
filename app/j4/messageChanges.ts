import type { ReferencePresentation, ReferenceChoice } from "@/lib/design/referencePresentation";

// StoreMessage.changes shape parsers — moved out of J4Workspace.tsx
// (2026-08-08, J4 Room Phase 1) so J4Room.tsx can render the same message
// shapes (images, voice memos, quick replies, diff lists) without a second,
// drifting copy of these checks. Pure functions, no behavior change from
// their original definitions.

export function extractChangeList(changes: unknown): string[] | null {
  return Array.isArray(changes) ? changes.filter((c): c is string => typeof c === "string") : null;
}

export function extractImageUrl(changes: unknown): string | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const value = (changes as Record<string, unknown>).imageUrl;
  return typeof value === "string" ? value : null;
}

export function extractAudioUrl(changes: unknown): string | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const value = (changes as Record<string, unknown>).audioUrl;
  return typeof value === "string" ? value : null;
}

export function extractImageUrls(changes: unknown): string[] | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const value = (changes as Record<string, unknown>).imageUrls;
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
}

export function extractQuickReplies(changes: unknown): string[] | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const value = (changes as Record<string, unknown>).quickReplies;
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
}

/**
 * A reference reading J4 attached to its own message.
 *
 * Stored on `changes` the same way a photo's URL already is - one structured
 * per-message field, rather than a second message system. Validated on the way
 * OUT as well as in: a malformed payload renders nothing rather than a card
 * with holes in it, and a card is the thing an owner is about to say yes to.
 */
export function extractReferencePresentation(changes: unknown): ReferencePresentation | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const value = (changes as Record<string, unknown>).designReference;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.inWords !== "string") return null;
  if (!Array.isArray(candidate.choices) || !Array.isArray(candidate.seenButUnchangeable)) return null;
  const choices = candidate.choices.filter(
    (c): c is ReferenceChoice =>
      !!c && typeof c === "object" &&
      typeof (c as ReferenceChoice).index === "number" &&
      typeof (c as ReferenceChoice).saw === "string" &&
      typeof (c as ReferenceChoice).label === "string" &&
      typeof (c as ReferenceChoice).value === "string" &&
      typeof (c as ReferenceChoice).why === "string",
  );
  // A choice that lost its observation on the way through is not shown. The
  // whole point of the card is that the owner can judge the recommendation
  // against what was seen, and a recommendation with nothing beside it is the
  // collapse this feature exists to prevent.
  const whole = choices.filter((c) => c.saw.length > 0);
  return {
    inWords: candidate.inWords,
    choices: whole,
    seenButUnchangeable: candidate.seenButUnchangeable.filter((s): s is string => typeof s === "string"),
    nothingActionable: whole.length === 0,
  };
}
