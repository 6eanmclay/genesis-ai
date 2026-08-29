"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { PERMISSIONS, requireBusiness } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { SocialPostSchema, type SocialContent } from "@/lib/businessModel/entities";
import { emptyContent, socialPlatform } from "@/lib/social/platforms";
import { draftSummary } from "@/lib/social/socialPresentation";

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

export async function saveSocialDraft(
  slug: string,
  input: { postId?: string | null; platform: string; name: string; content: SocialContent },
): Promise<SaveSocialResult> {
  try {
    return await saveSocialDraftOrThrow(slug, input);
  } catch (error) {
    return { ok: false, error: `That post could not be saved: ${reportable(error)}` };
  }
}

async function saveSocialDraftOrThrow(
  slug: string,
  input: { postId?: string | null; platform: string; name: string; content: SocialContent },
): Promise<SaveSocialResult> {
  // requireBusiness takes the SLUG. requireStorePermission's second parameter is
  // a store ID, and passing a slug to it made every Creation Station action
  // throw "Store not found" for everyone, always. Guarded by assertion now.
  const { store, userId } = await requireBusiness(PERMISSIONS.PRODUCTS_MANAGE, slug);

  const platform = socialPlatform(input.platform);
  if (!platform) return { ok: false, error: "That isn't a platform Genesis can write for." };

  // THE CONTENT MUST BE FOR THE PLATFORM IT CLAIMS. A client could post an X
  // body under an Instagram platform id; the union makes that unrepresentable
  // in our own code but says nothing about what arrives over the wire.
  if (input.content.kind !== platform.id) {
    return { ok: false, error: "That content doesn't match the platform it was written for." };
  }

  const postId = input.postId || randomUUID();

  // PUBLISHED STATE IS CARRIED FORWARD, never re-derived. Re-saving a post that
  // has been published must not make it look unpublished — the same rule the
  // design side follows for productId, and for the same reason: the Continue
  // panel groups on exactly this field.
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

  const data = {
    platform: platform.id,
    name: input.name.trim() || null,
    content: input.content,
    updatedAt: new Date().toISOString(),
    publishedAt: previous?.success ? previous.data.publishedAt : null,
    publishedUrl: previous?.success ? previous.data.publishedUrl : null,
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
  platform: string;
  name: string;
  summary: string;
  updatedAt: string | null;
  publishedAt: string | null;
}

/** Every post the owner has written, newest first. */
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
      platform: post.platform,
      // A POST IS OFTEN UNNAMED, because naming it is work nobody wants to do
      // before writing it. The platform stands in rather than "Untitled",
      // which says nothing somebody could pick out of a list.
      name: post.name ?? `${socialPlatform(post.platform)?.label ?? "Post"} draft`,
      summary: draftSummary(post.content),
      updatedAt: post.updatedAt,
      publishedAt: post.publishedAt,
    });
  }
  return drafts;
}

/** One post, ready to go back into the composer. */
export async function loadSocialDraft(
  storeId: string,
  postId: string,
): Promise<{ platform: string; name: string; content: SocialContent; publishedAt: string | null } | null> {
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
  const platform = socialPlatform(post.platform);
  if (!platform) return null;

  // A STORED SHAPE THAT NO LONGER MATCHES ITS PLATFORM opens empty rather than
  // crashing the workspace. This can only happen if a platform's content shape
  // changes under existing rows, which is exactly when somebody needs to be
  // able to open their old draft and see what survived.
  const content = post.content.kind === platform.id ? post.content : emptyContent(platform.id);

  return { platform: platform.id, name: post.name ?? "", content, publishedAt: post.publishedAt };
}
