import { notFound } from "next/navigation";
import { requireBusinessPage, PERMISSIONS } from "@/lib/permissions";
import { businessBasePath } from "@/lib/dashboard/navConfig";
import { emptyContent, socialPlatform } from "@/lib/social/platforms";
import { readinessFor } from "@/lib/social/publisher";
import { SocialComposer } from "./SocialComposer";
import { loadSocialDraft } from "./actions";

// THE SOCIAL CREATION WORKSPACE.
//
// ============ THE PLATFORM IS IN THE URL ===============================
//
// ?platform=instagram starts a new post; adding &post=<id> reopens one. The
// mirror of the design side's ?kind= and ?garment=&design=, and the same
// reasoning: the intention travels in the URL, so a link is a real address and
// the page can render before it has fetched anything.
//
// The platform is validated against the registry rather than trusted. An
// unknown platform is a 404, not an empty screen — a workspace for something
// Genesis cannot write is not a page that exists.

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

  // A POST ID WITHOUT A PLATFORM IS STILL OPENABLE. The draft knows which
  // platform it is for, so the link works either way rather than 404ing on a
  // parameter the row itself can supply.
  const existing = postId ? await loadSocialDraft(store.id, postId) : null;
  const resolvedId = existing?.platform ?? platformId;

  const platform = resolvedId ? socialPlatform(resolvedId) : null;
  if (!platform) notFound();

  // A post id that names nothing is a 404 rather than a silently blank new
  // post: somebody following a stale link should be told, not handed an empty
  // composer that looks like their work vanished.
  if (postId && !existing) notFound();

  const readiness = await readinessFor(store.id, platform.id);

  return (
    <SocialComposer
      slug={slug}
      basePath={basePath}
      platform={platform}
      postId={postId ?? null}
      initialName={existing?.name ?? ""}
      initialContent={existing?.content ?? emptyContent(platform.id)}
      blockedReason={readiness?.blockedReason ?? null}
    />
  );
}
