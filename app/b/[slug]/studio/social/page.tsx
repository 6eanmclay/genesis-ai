import { notFound } from "next/navigation";
import { requireBusinessPage, PERMISSIONS } from "@/lib/permissions";
import { businessBasePath } from "@/lib/dashboard/navConfig";
import { prisma } from "@/lib/prisma";
import { emptyContent, socialPlatform } from "@/lib/social/platforms";
import { platformReadiness } from "@/lib/social/publisher";
import { SocialComposer } from "./SocialComposer";
import { loadSocialDraft } from "./actions";

// THE SOCIAL CREATION WORKSPACE.
//
// ============ THE PLATFORM IS IN THE URL ===============================
//
// ?platform=instagram starts a new piece with Instagram already selected;
// adding &post=<id> reopens one. The mirror of the design side's ?kind= and
// ?garment=&design=, and the same reasoning: the intention travels in the URL,
// so a link is a real address and the page can render before it has fetched.
//
// A piece can carry several platforms, so ?platform= is the STARTING selection
// rather than the whole story — the composer adds and removes from there.

export default async function SocialCreationPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ platform?: string; post?: string }>;
}) {
  const { slug } = await params;
  const { platform: platformId, post: postId } = await searchParams;
  const { store } = await requireBusinessPage(PERMISSIONS.PRODUCTS_MANAGE, slug);
  const basePath = businessBasePath(slug);

  const existing = postId ? await loadSocialDraft(postId, slug) : null;

  // A post id that names nothing is a 404 rather than a silently blank new
  // piece: somebody following a stale link should be told, not handed an empty
  // composer that looks like their work vanished.
  if (postId && !existing) notFound();

  // A new piece starts on the platform the carousel sent. An unknown platform
  // is a 404 — a workspace for something Genesis cannot write is not a page
  // that exists.
  const starting = existing ? null : socialPlatform(platformId ?? "");
  if (!existing && !starting) notFound();

  const [readiness, balanceRow] = await Promise.all([
    platformReadiness(store.id),
    prisma.store.findUnique({ where: { id: store.id }, select: { growthPointBalance: true } }),
  ]);

  return (
    <SocialComposer
      slug={slug}
      basePath={basePath}
      postId={postId ?? null}
      initialName={existing?.name ?? ""}
      initialTargets={
        existing?.targets ?? [{ platform: starting!.id, content: emptyContent(starting!.id) }]
      }
      initialAmplifyStory={existing?.amplifyStory ?? false}
      // ONLY WHAT THE CLIENT NEEDS crosses the boundary: capability, connection,
      // and the sentence. Never credentials, never the publisher itself.
      readiness={readiness.map((r) => ({
        platform: { id: r.platform.id, label: r.platform.label },
        storyCapable: r.storyCapable,
        connected: r.connected,
        blockedReason: r.blockedReason,
      }))}
      balance={balanceRow?.growthPointBalance ?? 0}
    />
  );
}
