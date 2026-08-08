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
