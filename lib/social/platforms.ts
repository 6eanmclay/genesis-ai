import type { IntegrationProvider } from "@prisma/client";
import type { SocialContent } from "@/lib/businessModel/entities";

// WHAT YOU CAN POST, AS A QUESTION ABOUT INTENT.
//
// ============ THE SAME SHAPE AS lib/creation/creatables.ts ==============
//
// Product Creation is the reference implementation, and this is its mirror:
// data, not a switch. Adding a platform is an entry here — the carousel, the
// workspace and the draft list all read this list and none of them knows any
// platform by name.
//
// ============ WHAT J4 IS ASKED FOR IS PART OF THE PLATFORM ==============
//
// Sean: "Keep platform-specific content generation separate — never assume one
// caption can simply be copied across platforms."
//
// So `intent` lives beside the platform rather than being composed at a call
// site, and each one asks for the thing that platform actually needs. The
// content SHAPES enforce the same thing at the type level (see
// SocialContentSchema); this is the half a language model reads.
//
// ============ AND PUBLISHING IS AN HONEST NULL =========================
//
// `publishProvider` names the connector that would eventually publish this.
// Three of the four exist as IntegrationProvider values already, because the
// social connectors were built and paused in 2026-08. X does not exist at all:
// posting there needs a new enum value and therefore a migration, and pretending
// otherwise here would hide a schema change behind a UI change.
//
// MIRRORED REGISTRY (ARCHITECTURE.md): every non-null publishProvider must be a
// real IntegrationProvider, and every platform id must be a `kind` the content
// union can hold. Neither is checkable by the compiler at runtime — the enum is
// a type, and the union is erased — so scripts/verify-social-creation.ts asserts
// both. A drift here would offer a platform whose content cannot be stored, or
// name a connector that does not exist.

export interface SocialPlatform {
  /** Matches a `kind` in SocialContentSchema. Checked at runtime. */
  id: SocialContent["kind"];
  label: string;
  /** What you are making there, in the owner's words. */
  makes: string;
  /** The sentence that reaches J4, written for this platform alone. */
  intent: string;
  /**
   * The connector that will publish this one day, or null when none exists yet.
   * Null is not "unknown" — it is "this needs a migration first".
   */
  publishProvider: IntegrationProvider | null;
}

export const SOCIAL_PLATFORMS: SocialPlatform[] = [
  {
    id: "instagram",
    label: "Instagram",
    makes: "A square post, with the image made for it",
    intent:
      "Write an Instagram post for my business and make the square image for it — describe the picture, then the caption and hashtags that go with it.",
    publishProvider: "INSTAGRAM",
  },
  {
    id: "facebook",
    label: "Facebook",
    makes: "A post that starts conversations",
    intent:
      "Write a Facebook post for my business that invites people to reply — longer and warmer than a caption, ending on a real question.",
    publishProvider: "FACEBOOK",
  },
  {
    id: "x",
    label: "X",
    makes: "Short and direct, in your voice",
    intent:
      "Write a post for X for my business — short and direct, in my own voice, under 280 characters.",
    // NO CONNECTOR EXISTS. Adding one means a new IntegrationProvider value and
    // a migration; leaving this null is what stops the interface implying
    // otherwise.
    publishProvider: null,
  },
  {
    id: "tiktok",
    label: "TikTok",
    makes: "A vertical video, planned shot by shot",
    intent:
      "Plan a TikTok for my business — the hook for the first two seconds, what happens shot by shot, and the caption to post it with.",
    publishProvider: "TIKTOK",
  },
];

export function socialPlatform(id: string): SocialPlatform | null {
  return SOCIAL_PLATFORMS.find((p) => p.id === id) ?? null;
}

/** Every platform id, for validating a URL parameter before it is trusted. */
export const SOCIAL_PLATFORM_IDS: string[] = SOCIAL_PLATFORMS.map((p) => p.id);

/**
 * An empty post for a platform.
 *
 * ============ WHY THIS IS A FUNCTION AND NOT A CONSTANT ================
 *
 * Every branch returns a fresh object. A shared constant would be one object
 * handed to every draft, and the first edit would mutate the template for every
 * post afterwards — the kind of bug that only shows up on the second post
 * somebody writes.
 *
 * The switch is exhaustive by construction: `never` in the default makes adding
 * a platform to SOCIAL_PLATFORMS without a content shape a compile error, which
 * is the one part of this mirror the compiler CAN hold.
 */
export function emptyContent(id: SocialContent["kind"]): SocialContent {
  switch (id) {
    case "instagram":
      return { kind: "instagram", imageBrief: "", imageUrl: null, caption: "", hashtags: [] };
    case "facebook":
      return { kind: "facebook", body: "", question: "" };
    case "x":
      return { kind: "x", text: "" };
    case "tiktok":
      return { kind: "tiktok", hook: "", shots: [], caption: "" };
    default: {
      const unreachable: never = id;
      throw new Error(`No empty content for platform ${String(unreachable)}`);
    }
  }
}

/**
 * X's limit, as a number the composer and any future publisher both read.
 *
 * Named rather than inlined because two places enforcing 280 separately is how
 * one of them ends up enforcing 279.
 */
export const X_MAX_CHARACTERS = 280;
