"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CreationStage, StageDots } from "@/app/b/[slug]/studio/create/CreationStage";
import { SOCIAL_PLATFORMS } from "@/lib/social/platforms";
import { groupPosts, socialDraftHref, socialHref } from "@/lib/social/socialPresentation";
import { lastEdited } from "@/lib/creation/creationPresentation";
import type { SocialDraftRow } from "@/app/b/[slug]/studio/social/actions";
import { StageFrame } from "./StageFrame";
import { PlatformArt } from "./PlatformArt";
import { GENESIS_GREEN } from "@/lib/brand/palette";

// SOCIAL CREATION — the same room, different objects.
//
// ============ THE SAME EXPERIENCE, NOT A SECOND ONE (2026-08-28) =======
//
// Sean: "Keep the same CreationStage/carousel experience as Product Creation...
// Keep the same visual language, carousel behavior, mobile behavior, and Genesis
// staging as Product Creation."
//
// So this runs the SAME stage component as the product carousel and the doorway,
// inside the same StageFrame, with the same Continue / Create New pair beneath
// the focused object. If the carousel's behaviour changes, it changes in all
// three places at once — which is the only way "one Genesis system" survives
// contact with a third surface.
//
// ============ WHAT THE OBJECTS ARE ====================================
//
// Not the four logos — the four CANVASES. A square post, a feed card, a short
// line of text, a vertical video. See PlatformArt for why: the objects in this
// room are the thing being made, and the label already says where it goes.
//
// ============ AND WHERE THEY GO ======================================
//
// Into the Social Creation workspace at /studio/social?platform=<id>, which is
// a real screen with a real draft behind it — not a chat message. Asking J4 to
// write it is one control INSIDE that workspace rather than the only way in,
// because a post somebody wants to edit is a document, and a document needs a
// place to live.

export function StudioSocialCarousel({
  basePath,
  draftsFor,
}: {
  basePath: string;
  /** Drafts by platform id. Absent means none for that platform. */
  draftsFor: Record<string, SocialDraftRow[]>;
}) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [openDrafts, setOpenDrafts] = useState(false);

  const count = SOCIAL_PLATFORMS.length;
  const focused = SOCIAL_PLATFORMS[((index % count) + count) % count];
  const drafts = draftsFor[focused.id] ?? [];
  const groups = groupPosts(drafts);

  const stageItems = SOCIAL_PLATFORMS.map((p) => ({
    id: p.id,
    label: p.label,
    art: <PlatformArt id={p.id} className="relative h-[86%] w-[86%]" />,
  }));

  return (
    <div>
      <StageFrame>
        <CreationStage
          items={stageItems}
          index={index}
          onIndexChange={(next) => {
            // CHANGING PLATFORM CLOSES THE LIST. It belongs to Instagram, and
            // leaving it open over TikTok would offer Instagram drafts under
            // the wrong heading.
            setOpenDrafts(false);
            setIndex(next);
          }}
          onChoose={(item) => router.push(socialHref(basePath, item.id))}
          ariaLabel="What to post"
          height="h-[270px] sm:h-[320px]"
        />

        <div className="relative z-10 mt-3 text-center">
          <p className="text-[20px] font-medium text-zinc-100">{focused.label}</p>
          <p className="mx-auto mt-1 max-w-xs text-[13px] text-zinc-400">{focused.makes}</p>

          <div className="mt-4 flex items-center justify-center gap-2">
            {drafts.length > 0 && (
              <button
                type="button"
                aria-expanded={openDrafts}
                aria-controls="studio-social-panel"
                onClick={() => setOpenDrafts((o) => !o)}
                className="rounded-full border border-white/25 px-5 py-2.5 text-[14px] font-medium text-zinc-100 transition hover:border-white/60"
              >
                Continue
                <span aria-hidden="true" className="ml-1.5 inline-block text-[10px]">
                  {openDrafts ? "▲" : "▼"}
                </span>
              </button>
            )}

            <Link
              href={socialHref(basePath, focused.id)}
              className="rounded-full px-5 py-2.5 text-[14px] font-medium text-white transition hover:brightness-110"
              style={{ background: GENESIS_GREEN }}
            >
              Create New
            </Link>
          </div>

          <div className="mt-5 pb-1">
            <StageDots count={count} index={index} ids={SOCIAL_PLATFORMS.map((p) => p.id)} />
          </div>
        </div>
      </StageFrame>

      {/* The list opens below the stage, never inside it — the stage clips, and
          its objects are absolutely positioned with their own z-indexes. */}
      {openDrafts && (
        <div
          id="studio-social-panel"
          className="mt-3 rounded-2xl border border-black/[.08] bg-white p-3 dark:border-white/[.10] dark:bg-[#222226]"
        >
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-medium">Continue a {focused.label} post</p>
            <button
              type="button"
              onClick={() => setOpenDrafts(false)}
              className="rounded-lg px-2 py-1 text-[12px] text-zinc-500 transition hover:bg-black/[.05] dark:hover:bg-white/[.08]"
            >
              Close
            </button>
          </div>

          {/* TWO GROUPS, on the line the data already draws: a post is
              published or it is not. Nothing is published today, so in practice
              everything is in progress — and the grouping exists now so that
              the day something publishes, the list does not need rebuilding. */}
          {groups.inProgress.length > 0 && (
            <DraftGroup heading="In progress" drafts={groups.inProgress} basePath={basePath} />
          )}
          {groups.published.length > 0 && (
            <DraftGroup heading="Published" drafts={groups.published} basePath={basePath} />
          )}
        </div>
      )}
    </div>
  );
}

function DraftGroup({
  heading,
  drafts,
  basePath,
}: {
  heading: string;
  drafts: SocialDraftRow[];
  basePath: string;
}) {
  return (
    <div className="mt-3 first:mt-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{heading}</p>
      <ul className="mt-1 flex flex-col gap-1">
        {drafts.map((draft) => (
          <li key={draft.postId}>
            <Link
              href={socialDraftHref(basePath, draft.platform, draft.postId)}
              className="flex items-center gap-3 rounded-xl p-2 transition hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{draft.name}</span>
                {/* WHAT IS IN IT, in that platform's own terms — "hook written ·
                    3 shots" rather than the first forty characters of something
                    a TikTok may not even have. See draftSummary. */}
                <span className="block truncate text-[12px] text-zinc-500">{draft.summary}</span>
              </span>
              <span className="shrink-0 text-[11px] text-zinc-400">{lastEdited(draft.updatedAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
