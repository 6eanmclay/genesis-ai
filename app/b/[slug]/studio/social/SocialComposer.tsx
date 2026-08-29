"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useJ4Ask } from "@/app/dashboard/J4AskContext";
import type { SocialContent } from "@/lib/businessModel/entities";
import type { SocialPlatform } from "@/lib/social/platforms";
import { X_MAX_CHARACTERS } from "@/lib/social/platforms";
import { isReadyToPublish, whatIsMissing } from "@/lib/social/socialPresentation";
import { saveSocialDraft } from "./actions";
import { GENESIS_GREEN } from "@/lib/brand/palette";

// WRITING ONE POST, FOR ONE PLATFORM.
//
// ============ FOUR EDITORS, NOT ONE WITH A DROPDOWN ===================
//
// Sean: "Keep platform-specific content generation separate — never assume one
// caption can simply be copied across platforms." The content union already
// makes that true in the data; this is where it becomes true on the screen.
//
// An Instagram post asks what the picture shows before it asks for words. X is
// one box with a counter. TikTok is a hook and an ordered list of shots. They
// are different screens because they are different jobs, and a single "caption"
// field with a platform selector above it would have quietly made them the same
// job with four labels.
//
// ============ WHAT IS DELIBERATELY NOT HERE ==========================
//
// A Publish button. No platform is connected and no publisher is registered, so
// a button that appeared to post would be the one thing this codebase keeps
// being corrected for. What IS here is the honest sentence about why, from
// lib/social/publisher.ts, which names three different reasons rather than
// greying out a control and saying nothing.

export function SocialComposer({
  slug,
  basePath,
  platform,
  postId,
  initialName,
  initialContent,
  blockedReason,
}: {
  slug: string;
  basePath: string;
  platform: SocialPlatform;
  /** Null for a post that has never been saved. */
  postId: string | null;
  initialName: string;
  initialContent: SocialContent;
  /** Why this cannot be posted yet, or null when it could be. */
  blockedReason: string | null;
}) {
  const router = useRouter();
  const { ask, available: j4Available } = useJ4Ask();
  const [name, setName] = useState(initialName);
  const [content, setContent] = useState<SocialContent>(initialContent);
  const [savedId, setSavedId] = useState<string | null>(postId);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  const missing = whatIsMissing(content);
  const ready = isReadyToPublish(content);

  function save() {
    setMessage(null);
    setFailed(false);
    startTransition(async () => {
      const result = await saveSocialDraft(slug, {
        postId: savedId,
        platform: platform.id,
        name,
        content,
      });
      if (!result.ok) {
        setFailed(true);
        setMessage(result.error ?? "That post could not be saved.");
        return;
      }
      setFailed(false);
      setSavedId(result.postId ?? null);
      setMessage("Saved. You can come back to this from Studio.");
      // THE URL GAINS THE POST ID once there is one, so a refresh reopens the
      // draft that was just saved rather than a blank one. replace, not push:
      // saving is not a place in the history somebody should be able to go back
      // to and find an empty composer.
      if (result.postId && !postId) {
        router.replace(
          `${basePath}/studio/social?platform=${encodeURIComponent(platform.id)}&post=${encodeURIComponent(result.postId)}`,
        );
      }
    });
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-8">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Social creation
        </p>
        <h1 className="mt-1 text-[26px] font-semibold tracking-tight">{platform.label}</h1>
        <p className="mt-1 text-[14px] text-zinc-600 dark:text-zinc-400">{platform.makes}</p>
      </header>

      {/* ASK J4, with this platform's own intent. The same sentence the
          carousel sends, so the two ways in cannot diverge. */}
      {j4Available && (
        <button
          type="button"
          onClick={() => ask(platform.intent)}
          className="mt-5 w-full rounded-xl border border-black/[.10] px-4 py-3 text-left text-[14px] transition hover:border-black/30 dark:border-white/[.14] dark:hover:border-white/40"
        >
          <span className="block font-medium">Ask J4 to write this</span>
          <span className="mt-0.5 block text-[13px] text-zinc-500">
            It writes for {platform.label} specifically, not one caption for everywhere.
          </span>
        </button>
      )}

      <label className="mt-6 block">
        <span className="text-[13px] font-medium">What is this post about?</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Only so you can find it later"
          className="mt-1.5 w-full rounded-xl border border-black/[.12] bg-transparent px-3 py-2.5 text-[15px] outline-none focus:border-black/40 dark:border-white/[.16] dark:focus:border-white/50"
        />
      </label>

      <div className="mt-6">
        <PlatformFields content={content} onChange={setContent} />
      </div>

      {/* WHAT IS STILL MISSING, in this platform's own terms. Shown always
          rather than on a failed submit: somebody writing a post should be able
          to see what "finished" means before they are told they missed it. */}
      <p className="mt-6 text-[13px] text-zinc-500">
        {ready ? "This is ready." : missing}
      </p>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-full px-6 py-2.5 text-[15px] font-medium text-white transition hover:brightness-110 disabled:opacity-60"
          style={{ background: GENESIS_GREEN }}
        >
          {pending ? "Saving…" : savedId ? "Save changes" : "Save draft"}
        </button>
        <span className={`text-[13px] ${failed ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>
          {message}
        </span>
      </div>

      {/* ============ WHY THERE IS NO POST BUTTON =======================
          Named plainly rather than left as an absence. Three different reasons
          produce three different sentences — see platformReadiness. */}
      {blockedReason && (
        <p className="mt-6 rounded-xl border border-black/[.08] px-4 py-3 text-[13px] text-zinc-600 dark:border-white/[.10] dark:text-zinc-400">
          {blockedReason}
        </p>
      )}
    </div>
  );
}

/**
 * The fields for this platform, and only this platform.
 *
 * The switch is exhaustive: adding a content shape without an editor is a
 * compile error rather than a blank screen.
 */
function PlatformFields({
  content,
  onChange,
}: {
  content: SocialContent;
  onChange: (next: SocialContent) => void;
}) {
  switch (content.kind) {
    case "instagram":
      return (
        <div className="flex flex-col gap-5">
          {/* VISUAL-FIRST, and the order on screen is the argument. The picture
              is asked about before the words, because on Instagram the words
              serve the picture. */}
          <Field
            label="What should the picture show?"
            hint="Describe it and J4 can make it. This is the post."
            value={content.imageBrief}
            onChange={(imageBrief) => onChange({ ...content, imageBrief })}
            rows={3}
          />
          <Field
            label="Caption"
            value={content.caption}
            onChange={(caption) => onChange({ ...content, caption })}
            rows={4}
          />
          <label className="block">
            <span className="text-[13px] font-medium">Hashtags</span>
            <input
              value={content.hashtags.join(" ")}
              onChange={(e) =>
                onChange({
                  ...content,
                  // Stored without the #, so the tag is the data. Split on
                  // whitespace or commas, because people type both.
                  hashtags: e.target.value
                    .split(/[\s,]+/)
                    .map((tag) => tag.replace(/^#+/, "").trim())
                    .filter(Boolean),
                })
              }
              placeholder="handmade copper jewellery"
              className="mt-1.5 w-full rounded-xl border border-black/[.12] bg-transparent px-3 py-2.5 text-[15px] outline-none focus:border-black/40 dark:border-white/[.16] dark:focus:border-white/50"
            />
            <span className="mt-1 block text-[12px] text-zinc-500">
              {content.hashtags.length > 0
                ? content.hashtags.map((t) => `#${t}`).join(" ")
                : "Separate them with spaces. The # is added for you."}
            </span>
          </label>
        </div>
      );

    case "facebook":
      return (
        <div className="flex flex-col gap-5">
          <Field
            label="The post"
            hint="Longer and warmer than a caption."
            value={content.body}
            onChange={(body) => onChange({ ...content, body })}
            rows={6}
          />
          {/* ITS OWN FIELD, not the last line of the body. A post that ends in
              a question by accident is not one written to be answered. */}
          <Field
            label="What are you asking them?"
            hint="The line that invites a reply."
            value={content.question}
            onChange={(question) => onChange({ ...content, question })}
            rows={2}
          />
        </div>
      );

    case "x": {
      const used = content.text.trim().length;
      const over = used > X_MAX_CHARACTERS;
      return (
        <div>
          <Field
            label="The post"
            value={content.text}
            onChange={(text) => onChange({ ...content, text })}
            rows={4}
          />
          {/* THE COUNTER IS THE FORMAT. Not decoration — the limit is the one
              thing that makes writing for X different from writing anywhere. */}
          <p
            className={`mt-1.5 text-right text-[12px] tabular-nums ${
              over ? "font-medium text-red-600 dark:text-red-400" : "text-zinc-500"
            }`}
          >
            {used} / {X_MAX_CHARACTERS}
          </p>
        </div>
      );
    }

    case "tiktok":
      return (
        <div className="flex flex-col gap-5">
          <Field
            label="The hook"
            hint="The first two seconds. This decides whether the rest is watched."
            value={content.hook}
            onChange={(hook) => onChange({ ...content, hook })}
            rows={2}
          />

          <div>
            <span className="text-[13px] font-medium">Shot by shot</span>
            <ul className="mt-2 flex flex-col gap-2">
              {content.shots.map((shot, i) => (
                <li key={shot.id} className="flex items-start gap-2">
                  <span className="mt-2.5 w-5 shrink-0 text-right text-[12px] tabular-nums text-zinc-500">
                    {i + 1}
                  </span>
                  <textarea
                    value={shot.description}
                    rows={2}
                    onChange={(e) =>
                      onChange({
                        ...content,
                        shots: content.shots.map((s) =>
                          s.id === shot.id ? { ...s, description: e.target.value } : s,
                        ),
                      })
                    }
                    placeholder="What happens in this shot"
                    className="w-full rounded-xl border border-black/[.12] bg-transparent px-3 py-2 text-[15px] outline-none focus:border-black/40 dark:border-white/[.16] dark:focus:border-white/50"
                  />
                  <button
                    type="button"
                    aria-label={`Remove shot ${i + 1}`}
                    onClick={() =>
                      onChange({ ...content, shots: content.shots.filter((s) => s.id !== shot.id) })
                    }
                    className="mt-1.5 rounded-lg px-2 py-1.5 text-[13px] text-zinc-500 transition hover:bg-black/[.05] dark:hover:bg-white/[.08]"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...content,
                  // crypto.randomUUID is available in every browser this ships
                  // to; the id exists so removing shot 2 of 5 cannot renumber
                  // the others out from under React.
                  shots: [...content.shots, { id: crypto.randomUUID(), description: "", seconds: null }],
                })
              }
              className="mt-2 rounded-lg border border-black/[.12] px-3 py-1.5 text-[13px] font-medium transition hover:border-black/35 dark:border-white/[.16] dark:hover:border-white/45"
            >
              Add a shot
            </button>
          </div>

          <Field
            label="Caption"
            value={content.caption}
            onChange={(caption) => onChange({ ...content, caption })}
            rows={3}
          />
        </div>
      );

    default: {
      const unreachable: never = content;
      throw new Error(`No editor for ${JSON.stringify(unreachable)}`);
    }
  }
}

function Field({
  label,
  hint,
  value,
  onChange,
  rows,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  rows: number;
}) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium">{label}</span>
      {hint && <span className="mt-0.5 block text-[12px] text-zinc-500">{hint}</span>}
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 w-full rounded-xl border border-black/[.12] bg-transparent px-3 py-2.5 text-[15px] leading-relaxed outline-none focus:border-black/40 dark:border-white/[.16] dark:focus:border-white/50"
      />
    </label>
  );
}
