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
 * data already draws the line, so nothing new is stored to tell them apart. A
 * post is published or it is not, and `publishedAt` is that fact.
 */
export function groupPosts<T extends { publishedAt: string | null }>(
  posts: T[],
): { inProgress: T[]; published: T[] } {
  return {
    inProgress: posts.filter((p) => p.publishedAt === null),
    published: posts.filter((p) => p.publishedAt !== null),
  };
}
