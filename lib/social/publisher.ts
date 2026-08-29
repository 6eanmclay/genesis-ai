import "server-only";
import { prisma } from "@/lib/prisma";
import type { SocialContent } from "@/lib/businessModel/entities";
import { SOCIAL_PLATFORMS, socialPlatform, type SocialPlatform } from "./platforms";

// storyAmplification lives in socialPresentation.ts, not here: the selection it
// reads changes in the browser, and this module is server-only. Re-exported so
// a server caller does not need to know that.
export { storyAmplification } from "./socialPresentation";

// WHERE A CONNECTION WILL PLUG IN.
//
// ============ THE SEAM, BUILT BEFORE THERE IS ANYTHING TO PLUG =========
//
// Sean, 2026-08-28: "Wire everything so that when we connect
// Instagram/Facebook/X/TikTok later, we're plugging credentials and APIs into an
// already-built creation system rather than redesigning the architecture."
//
// So this is the interface a publisher will implement, and a registry that is
// deliberately EMPTY. Nothing is stubbed, nothing is faked, and no code path
// pretends a post went anywhere. `publisherFor` returns null for all four
// platforms today and every caller is written for that answer, which is the
// only way to be sure the null branch is the honest one rather than the
// forgotten one.
//
// The shape is copied from lib/creation/registry.ts on purpose. The print
// supplier boundary is the reference implementation, it survived a real
// integration, and a second boundary that looked different would be a second
// set of decisions to make under pressure later.
//
// ============ WHAT A PUBLISHER WILL BE HANDED ==========================
//
// The typed content, not a rendered string. A publisher for Instagram needs the
// image and the caption separately because the Graph API takes them separately;
// one that received "the post as text" would have to parse its own input back
// apart. This is the same reason the print supplier takes placements rather
// than a finished picture.

export interface PublishResult {
  /** Where it landed. Null when the platform does not return a URL. */
  url: string | null;
  /** The platform's own id for the post, for later reads. */
  externalId: string | null;
}

/**
 * Where a piece can land on a platform.
 *
 * `feed` is the ordinary post. `story` is the 24-hour surface, and it is a
 * SEPARATE capability because two of the four platforms cannot do it at all.
 */
export type PublishSurface = "feed" | "story";

export interface SocialPublisher {
  /** The platform this publishes to. */
  readonly platformId: string;

  /**
   * ============ WHAT THIS PUBLISHER CAN ACTUALLY DO ==================
   *
   * Sean, 2026-08-29: "design the publisher seam so Story amplification is a
   * capability of the platform publisher rather than a special-case UI hack."
   *
   * So the surfaces are declared here, by the thing that would do the work, and
   * every offer in the interface is derived from this list. Nothing upstream
   * carries a list of "platforms that support stories" — that list would be a
   * second registry to keep in sync, and it would be wrong the first time a
   * platform changed its API.
   *
   * VERIFIED 2026-08-29, and only these:
   *   Instagram — media_type=STORIES on the Content Publishing API.
   *   Facebook  — POST /{page-id}/photo_stories and /video_stories.
   *   TikTok    — the Content Posting API direct-posts to the profile. There is
   *               no Stories endpoint, so a TikTok publisher declares feed only.
   *   X         — has no Stories product, and no connector at all.
   *
   * A publisher must not declare a surface it has not implemented. That is the
   * whole contract: the owner is offered exactly what can be done.
   */
  readonly surfaces: readonly PublishSurface[];

  /**
   * Send it. Throws with a message an owner can read — the same contract every
   * connector in lib/integrations already holds, and the reason failures on the
   * product side became sentences rather than status codes.
   *
   * `surface` is passed rather than inferred, and a publisher handed a surface
   * it does not declare should throw rather than quietly post to the feed.
   */
  publish(input: {
    storeId: string;
    content: SocialContent;
    surface: PublishSurface;
  }): Promise<PublishResult>;
}

/**
 * The registered publishers, by platform id.
 *
 * EMPTY, AND THAT IS THE CURRENT TRUTH. Registering one is the whole change
 * when a connection is ready: nothing above this line and nothing in the
 * workspace needs to move.
 */
const PUBLISHERS = new Map<string, () => SocialPublisher>();

export function registerPublisher(platformId: string, connect: () => SocialPublisher): void {
  PUBLISHERS.set(platformId, connect);
}

export function publisherFor(platformId: string): SocialPublisher | null {
  const connect = PUBLISHERS.get(platformId);
  return connect ? connect() : null;
}

/** What a platform can and cannot do for this business, right now. */
export interface PlatformReadiness {
  platform: SocialPlatform;
  /** A connector exists in the codebase for this platform at all. */
  hasPublisher: boolean;
  /** This business has connected the account. */
  connected: boolean;
  /**
   * The registered publisher declares it can post a story.
   *
   * FALSE WHEN THERE IS NO PUBLISHER, which is every platform today. This is a
   * fact about code, not about the platform's API: Instagram's API supports
   * stories, and this stays false until something implements it. Claiming a
   * capability nobody wrote is exactly what the seam exists to prevent.
   */
  storyCapable: boolean;
  /**
   * One sentence for the owner about publishing, or null when it just works.
   * Never a status code, and never silence.
   */
  blockedReason: string | null;
}

/**
 * Whether each platform could actually publish for this store.
 *
 * ============ THREE DIFFERENT NOS ======================================
 *
 * "Genesis cannot post to X at all", "your business has not connected
 * Instagram", and "it works" are three different facts, and collapsing them
 * into one disabled button is the mistake the product carousel already made
 * once — an unreadable supplier catalogue read as "your supplier doesn't make
 * this". So each is named separately and the sentence says which.
 *
 * ONE QUERY for every platform rather than one per platform, the same shape as
 * creationAccessFor: adding platforms must not add round trips to a page load.
 */
export async function platformReadiness(storeId: string): Promise<PlatformReadiness[]> {
  const providers = SOCIAL_PLATFORMS.map((p) => p.publishProvider).filter(
    (p): p is NonNullable<typeof p> => p !== null,
  );

  const rows =
    providers.length > 0
      ? await prisma.storeIntegration.findMany({
          where: { storeId, provider: { in: providers } },
          select: { provider: true, status: true, credentials: true },
        })
      : [];

  return SOCIAL_PLATFORMS.map((platform) => {
    const publisher = publisherFor(platform.id);
    const hasPublisher = publisher !== null;
    const row = platform.publishProvider
      ? rows.find((r) => r.provider === platform.publishProvider)
      : undefined;
    const connected = row?.status === "CONNECTED" && row.credentials !== null;

    let blockedReason: string | null = null;
    if (platform.publishProvider === null) {
      blockedReason = `Genesis can write ${platform.label} posts, but can't post them for you yet.`;
    } else if (!hasPublisher) {
      blockedReason = `Genesis can write ${platform.label} posts, but posting them isn't switched on yet.`;
    } else if (!connected) {
      blockedReason = `Connect ${platform.label} and Genesis can post this for you.`;
    }

    return {
      platform,
      hasPublisher,
      connected,
      // DECLARED, NOT ASSUMED. Read off the publisher itself.
      storyCapable: publisher?.surfaces.includes("story") ?? false,
      blockedReason,
    };
  });
}

/** The readiness of one platform, or null when the id is not a platform. */
export async function readinessFor(
  storeId: string,
  platformId: string,
): Promise<PlatformReadiness | null> {
  if (!socialPlatform(platformId)) return null;
  const all = await platformReadiness(storeId);
  return all.find((r) => r.platform.id === platformId) ?? null;
}
