"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { PERMISSIONS, requireBusiness } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { SocialPostSchema, type SocialContent } from "@/lib/businessModel/entities";
import { emptyContent, socialPlatform } from "@/lib/social/platforms";
import { pieceSummary, piecePublishedAt } from "@/lib/social/socialPresentation";

// SAVING A POST THAT IS NOT FINISHED.
//
// ============ THE MIRROR OF THE DESIGN DRAFT PATH ======================
//
// Product Creation is the reference implementation, so this follows it exactly:
// a BusinessRecord row per draft, written through persistSyncedRecords with
// OWNER provenance, keyed by a generated externalId that the URL carries.
//
// No new table and no migration. `socialPost` is an entity type in
// ENTITY_REGISTRY, its data is validated by SocialPostSchema, and a draft is a
// row exactly as a saved design is.
//
// ============ SAVE IS FREE AND MUST NEVER TOUCH A NETWORK =============
//
// The design side learned this the hard way: Save waited on the supplier's
// heaviest call, and the button that was supposed to be instant depended on
// Printful being up. Nothing here calls a platform. Nothing here can, because
// no publisher is registered — see lib/social/publisher.ts.
//
// ============ AND THE ACTIONS RETURN THEIR FAILURES ===================
//
// Next replaces a thrown Server Action's message with a placeholder in
// production, which cost three rounds of debugging on the product side. These
// return the failure as data so the owner can read it. Redirects still throw,
// so they are re-thrown untouched.

const DRAFT_SOURCE = "genesis_social";

function isControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && (digest.startsWith("NEXT_REDIRECT") || digest === "NEXT_NOT_FOUND");
}

function reportable(error: unknown): string {
  if (isControlFlow(error)) throw error;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message || "Something went wrong and did not say what.";
}

export interface SaveSocialResult {
  ok: boolean;
  postId?: string;
  error?: string;
}

/** One platform's writing, as it arrives from the composer. */
export interface SocialTargetInput {
  platform: string;
  content: SocialContent;
}

export async function saveSocialDraft(
  slug: string,
  input: {
    postId?: string | null;
    name: string;
    targets: SocialTargetInput[];
    /** Whether the owner took the Story amplification. */
    amplifyStory?: boolean;
  },
): Promise<SaveSocialResult> {
  try {
    return await saveSocialDraftOrThrow(slug, input);
  } catch (error) {
    return { ok: false, error: `That post could not be saved: ${reportable(error)}` };
  }
}

async function saveSocialDraftOrThrow(
  slug: string,
  input: {
    postId?: string | null;
    name: string;
    targets: SocialTargetInput[];
    amplifyStory?: boolean;
  },
): Promise<SaveSocialResult> {
  // requireBusiness takes the SLUG. requireStorePermission's second parameter is
  // a store ID, and passing a slug to it made every Creation Station action
  // throw "Store not found" for everyone, always. Guarded by assertion now.
  const { store, userId } = await requireBusiness(PERMISSIONS.PRODUCTS_MANAGE, slug);

  if (input.targets.length === 0) {
    return { ok: false, error: "Pick at least one platform to post to." };
  }

  // EVERY TARGET MUST BE A REAL PLATFORM, AND ITS CONTENT MUST MATCH IT.
  // The union makes a mismatch unrepresentable in our own code and says nothing
  // about what arrives over the wire.
  const seen = new Set<string>();
  for (const target of input.targets) {
    const platform = socialPlatform(target.platform);
    if (!platform) return { ok: false, error: "That isn't a platform Genesis can write for." };
    if (target.content.kind !== platform.id) {
      return { ok: false, error: "That content doesn't match the platform it was written for." };
    }
    // One target per platform. Two Instagram targets on one piece would make
    // "posting to 2 platforms" a lie and double-publish to the same account.
    if (seen.has(platform.id)) {
      return { ok: false, error: "That platform is already on this post." };
    }
    seen.add(platform.id);
  }

  const postId = input.postId || randomUUID();

  // PUBLISHED STATE IS CARRIED FORWARD PER TARGET, never re-derived. Re-saving a
  // piece whose Instagram half already posted must not make it look unposted —
  // the same rule the design side follows for productId, and the reason the
  // Continue panel can group on it.
  const existing = input.postId
    ? await prisma.businessRecord.findFirst({
        where: {
          storeId: store.id,
          entityType: "socialPost",
          sourceProvider: DRAFT_SOURCE,
          externalId: postId,
        },
        select: { data: true },
      })
    : null;
  const previous = existing ? SocialPostSchema.safeParse(existing.data) : null;
  const previousTargets = previous?.success ? previous.data.targets : [];

  const targets = input.targets.map((target) => {
    const before = previousTargets.find((p) => p.platform === target.platform);
    return {
      platform: target.platform,
      content: target.content,
      publishedAt: before?.publishedAt ?? null,
      publishedUrl: before?.publishedUrl ?? null,
      storyPublishedAt: before?.storyPublishedAt ?? null,
    };
  });

  const data = {
    name: input.name.trim() || null,
    targets,
    // THE FLAG IS RECORDED, NOT ACTED ON. Whether the story actually reaches a
    // platform is decided by capability at publish time — storyAmplification in
    // lib/social/publisher.ts — never by this alone.
    amplifyStory: input.amplifyStory ?? false,
    updatedAt: new Date().toISOString(),
  };

  const result = await persistSyncedRecords(
    store.id,
    DRAFT_SOURCE,
    [{ entityType: "socialPost", externalId: postId, data }],
    {
      // THE OWNER WROTE THIS. Even when J4 drafted the words, the owner edited
      // and saved them — the same distinction the design side draws between a
      // composition somebody arranged and one J4 produced unattended.
      provenance: "OWNER",
      provenanceDetail: "social creation",
      statedById: userId,
      modelExtracted: false,
    },
  );
  if (result.errors.length > 0) {
    return { ok: false, error: "That post could not be saved." };
  }

  revalidatePath(`/b/${slug}/studio`);
  return { ok: true, postId };
}

export interface SocialDraftRow {
  postId: string;
  /** Every platform this piece goes to. */
  platforms: string[];
  name: string;
  summary: string;
  updatedAt: string | null;
  /** Null until EVERY target has landed — see piecePublishedAt. */
  publishedAt: string | null;
}

/** Every piece the owner has written, newest first. */
export async function socialDraftsFor(storeId: string): Promise<SocialDraftRow[]> {
  const rows = await prisma.businessRecord.findMany({
    where: { storeId, entityType: "socialPost", sourceProvider: DRAFT_SOURCE },
    select: { id: true, externalId: true, data: true },
    orderBy: { syncedAt: "desc" },
    take: 60,
  });

  const drafts: SocialDraftRow[] = [];
  for (const row of rows) {
    const parsed = SocialPostSchema.safeParse(row.data);
    if (!parsed.success) continue;
    const post = parsed.data;
    drafts.push({
      postId: row.externalId ?? row.id,
      platforms: post.targets.map((target) => target.platform),
      // A PIECE IS OFTEN UNNAMED, because naming it is work nobody wants to do
      // before writing it. What it is for stands in rather than "Untitled",
      // which says nothing somebody could pick out of a list.
      name: post.name ?? defaultName(post.targets.map((target) => target.platform)),
      summary: pieceSummary(post.targets, (id) => socialPlatform(id)?.label ?? id),
      updatedAt: post.updatedAt,
      publishedAt: piecePublishedAt(post.targets),
    });
  }
  return drafts;
}

/** What an unnamed piece is called in a list. */
function defaultName(platformIds: string[]): string {
  if (platformIds.length === 1) {
    return `${socialPlatform(platformIds[0])?.label ?? "Social"} draft`;
  }
  return `${platformIds.length}-platform draft`;
}

/** One piece, ready to go back into the composer. */
export async function loadSocialDraft(
  storeId: string,
  postId: string,
): Promise<{
  name: string;
  targets: { platform: string; content: SocialContent }[];
  amplifyStory: boolean;
} | null> {
  const row = await prisma.businessRecord.findFirst({
    where: {
      storeId,
      entityType: "socialPost",
      sourceProvider: DRAFT_SOURCE,
      externalId: postId,
    },
    select: { data: true },
  });
  if (!row) return null;

  const parsed = SocialPostSchema.safeParse(row.data);
  if (!parsed.success) return null;
  const post = parsed.data;

  // A STORED SHAPE THAT NO LONGER MATCHES ITS PLATFORM opens empty rather than
  // crashing the workspace, and a target naming a platform that no longer
  // exists is dropped rather than rendering a section with no editor. Both can
  // only happen after a deliberate change to the registry — which is exactly
  // when somebody needs to open their old draft and see what survived.
  const targets = post.targets.flatMap((target) => {
    const platform = socialPlatform(target.platform);
    if (!platform) return [];
    return [{
      platform: platform.id,
      content: target.content.kind === platform.id ? target.content : emptyContent(platform.id),
    }];
  });
  if (targets.length === 0) return null;

  return { name: post.name ?? "", targets, amplifyStory: post.amplifyStory };
}
