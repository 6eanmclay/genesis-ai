import type { SocialContent } from "@/lib/businessModel/entities";
import { X_MAX_CHARACTERS } from "./platforms";

// WHAT SOCIAL CREATION SAYS AND WHERE IT LINKS, IN ONE PLACE.
//
// The mirror of lib/creation/creationPresentation.ts, and for the same reason:
// the Studio carousel and the workspace are two screens that must not become
// two opinions about the same draft. Pure, so it is testable without a server.

/** Starting something new: the platform travels, not a draft id. */
export function socialHref(basePath: string, platformId: string): string {
  return `${basePath}/studio/social?platform=${encodeURIComponent(platformId)}`;
}

/**
 * Reopening a draft.
 *
 * BOTH PARAMETERS, always — the same rule the design side learned the hard way.
 * The workspace needs to know which platform it is rendering before it has
 * loaded anything, because the four are genuinely different screens; a link
 * carrying only the post id would have to fetch before it could render.
 */
export function socialDraftHref(basePath: string, platformId: string, postId: string): string {
  return (
    `${basePath}/studio/social` +
    `?platform=${encodeURIComponent(platformId)}` +
    `&post=${encodeURIComponent(postId)}`
  );
}

/**
 * One line describing a draft, in that platform's own terms.
 *
 * ============ NOT A GENERIC PREVIEW ===================================
 *
 * The obvious implementation is "first forty characters of the caption", which
 * requires the four shapes to have a caption — the exact assumption the content
 * union exists to prevent. So this switches, and each branch says what that
 * platform's draft actually contains: a TikTok with six shots and no caption is
 * further along than one with a caption and no shots.
 */
export function draftSummary(content: SocialContent): string {
  switch (content.kind) {
    case "instagram": {
      const parts: string[] = [];
      parts.push(content.imageUrl ? "picture ready" : content.imageBrief ? "picture described" : "no picture yet");
      if (content.caption) parts.push("caption written");
      if (content.hashtags.length > 0) parts.push(`${content.hashtags.length} tags`);
      return parts.join(" · ");
    }
    case "facebook": {
      const parts: string[] = [];
      if (content.body) parts.push("post written");
      parts.push(content.question ? "asks a question" : "no question yet");
      return parts.join(" · ");
    }
    case "x": {
      const used = content.text.trim().length;
      if (used === 0) return "nothing written yet";
      return `${used} of ${X_MAX_CHARACTERS} characters`;
    }
    case "tiktok": {
      const parts: string[] = [];
      parts.push(content.hook ? "hook written" : "no hook yet");
      if (content.shots.length > 0) parts.push(`${content.shots.length} shots`);
      if (content.caption) parts.push("caption written");
      return parts.join(" · ");
    }
    default: {
      const unreachable: never = content;
      throw new Error(`No summary for ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Whether a draft is far enough along to be worth publishing.
 *
 * ============ READY IS PER PLATFORM, NOT A WORD COUNT =================
 *
 * Nothing can publish yet, and this is deliberately built before that: the
 * question "is this finished" is about the content, not about the connection,
 * and answering it in the platform's own terms is what stops a future publish
 * button asking "is the caption non-empty" of a TikTok.
 *
 * An Instagram post needs a picture — that is what visual-first means, and a
 * caption alone is not a post.
 */
export function isReadyToPublish(content: SocialContent): boolean {
  switch (content.kind) {
    case "instagram":
      return content.imageUrl !== null && content.caption.trim().length > 0;
    case "facebook":
      return content.body.trim().length > 0;
    case "x": {
      const text = content.text.trim();
      return text.length > 0 && text.length <= X_MAX_CHARACTERS;
    }
    case "tiktok":
      return content.hook.trim().length > 0 && content.shots.some((s) => s.description.trim().length > 0);
    default: {
      const unreachable: never = content;
      throw new Error(`No readiness rule for ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * What is stopping this from being finished, in the owner's words.
 *
 * `isReadyToPublish` answers yes or no; this answers "why not", because a
 * disabled control with no explanation is the thing every other part of this
 * codebase has been corrected for.
 */
export function whatIsMissing(content: SocialContent): string | null {
  if (isReadyToPublish(content)) return null;
  switch (content.kind) {
    case "instagram":
      if (content.imageUrl === null) return "This needs a picture — Instagram posts are the image first.";
      return "This needs a caption.";
    case "facebook":
      return "This needs something to say.";
    case "x": {
      const text = content.text.trim();
      if (text.length === 0) return "This needs something to say.";
      return `This is ${text.length - X_MAX_CHARACTERS} characters over the limit.`;
    }
    case "tiktok":
      if (content.hook.trim().length === 0) return "This needs a hook — the first two seconds decide the rest.";
      return "This needs at least one shot.";
    default: {
      const unreachable: never = content;
      throw new Error(`No missing-reason for ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Drafts split into the two states an owner recognises.
 *
 * The mirror of groupSavedWork on the product side, and the same reasoning: the
 * data already draws the line, so nothing new is stored to tell them apart.
 *
 * ============ A PIECE IS PUBLISHED WHEN EVERY TARGET IS ================
 *
 * Publishing is per target — Instagram can succeed while Facebook fails — so a
 * piece with three targets and two successes is still unfinished work, and
 * belongs under "In progress" where somebody will go back to it. Reading "any
 * target published" as done is how a half-posted piece disappears from the list
 * that would have let its owner finish it.
 */
export function groupPosts<T extends { publishedAt: string | null }>(
  posts: T[],
): { inProgress: T[]; published: T[] } {
  return {
    inProgress: posts.filter((p) => p.publishedAt === null),
    published: posts.filter((p) => p.publishedAt !== null),
  };
}

/**
 * When a whole piece counts as published: every target has landed, or none has.
 *
 * Returns null while any target is still unpublished, which is what groupPosts
 * reads. Kept separate and pure so the rule has one home.
 */
export function piecePublishedAt(
  targets: { publishedAt: string | null }[],
): string | null {
  if (targets.length === 0) return null;
  const times = targets.map((t) => t.publishedAt);
  if (times.some((time) => time === null)) return null;
  // The last one to land is when the piece was finished.
  return times.filter((time): time is string => time !== null).sort().at(-1) ?? null;
}

/**
 * One line describing a whole piece across its platforms.
 *
 * A piece going to three platforms has three summaries, and showing all of them
 * in a list row is unreadable. So the row says how many platforms and then the
 * state of the one furthest along — enough to recognise it, which is the job.
 */
export function pieceSummary(
  targets: { platform: string; content: SocialContent }[],
  labelFor: (platformId: string) => string,
): string {
  if (targets.length === 0) return "nothing selected yet";
  if (targets.length === 1) {
    return `${labelFor(targets[0].platform)} · ${draftSummary(targets[0].content)}`;
  }
  const names = targets.map((t) => labelFor(t.platform)).join(", ");
  return `${targets.length} platforms · ${names}`;
}


/**
 * Whether to offer the Story amplification, and for which platforms.
 *
 * ============ CAPABILITY-DERIVED, NEVER HARDCODED ======================
 *
 * Sean, 2026-08-29: "The Story offer must be capability-derived, never
 * hardcoded. Only offer it when at least one selected platform's registered
 * publisher declares story capability AND that platform account is actually
 * connected. If no connected publisher supports Story, show nothing. Do not
 * show a disabled or fake Story option."
 *
 * So both conditions are required and the result is a LIST rather than a
 * boolean: an owner posting to Instagram, X and TikTok should be told the story
 * goes to Instagram, not left to assume it goes everywhere.
 *
 * TODAY THIS ALWAYS RETURNS AN EMPTY LIST, because no publisher is registered.
 * That is the honest state, and the reason the caller renders nothing rather
 * than a disabled control.
 */
export interface StoryCapability {
  platform: { id: string; label: string };
  storyCapable: boolean;
  connected: boolean;
}

export function storyAmplification<T extends StoryCapability>(
  readiness: T[],
  selectedPlatformIds: string[],
): { offered: boolean; platforms: T["platform"][] } {
  const platforms = readiness
    .filter((r) => selectedPlatformIds.includes(r.platform.id))
    .filter((r) => r.storyCapable && r.connected)
    .map((r) => r.platform);
  return { offered: platforms.length > 0, platforms };
}
