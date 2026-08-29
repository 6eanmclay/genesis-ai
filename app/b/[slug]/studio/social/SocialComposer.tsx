"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useJ4Ask } from "@/app/dashboard/J4AskContext";
import type { SocialContent } from "@/lib/businessModel/entities";
import { SOCIAL_PLATFORMS, X_MAX_CHARACTERS, emptyContent, socialPlatform } from "@/lib/social/platforms";
import {
  isReadyToPublish,
  storyAmplification,
  whatIsMissing,
  type StoryCapability,
} from "@/lib/social/socialPresentation";
import { investmentSummary, socialInvestment } from "@/lib/social/investment";
import { saveSocialDraft } from "./actions";
import { GENESIS_GREEN } from "@/lib/brand/palette";

// WRITING ONE PIECE, FOR ONE OR MORE PLATFORMS.
//
// ============ FOUR EDITORS, NOT ONE WITH A DROPDOWN ===================
//
// Sean: "Keep platform-specific content generation separate — never assume one
// caption can simply be copied across platforms." The content union already
// makes that true in the data; this is where it becomes true on the screen.
//
// Selecting a second platform adds an EMPTY section for it, never a copy of the
// first. That is the single most important behaviour in this file: the moment
// selecting Facebook prefilled it with the Instagram caption, the whole
// architecture would be decoration.
//
// ============ ONE CREATION, NOT FOUR ==================================
//
// Sean, 2026-08-29: "The four platforms remain one creation, not four separate
// charges." So this is one draft with several targets, and the investment line
// says 1 or 2 Growth Points for the whole piece — never one per platform.
//
// ============ WHAT IS DELIBERATELY NOT HERE ==========================
//
// A Publish button. No platform is connected and no publisher is registered, so
// a button that appeared to post would be the one thing this codebase keeps
// being corrected for. What IS here is the honest sentence about why.

export interface ComposerReadiness extends StoryCapability {
  blockedReason: string | null;
}

export function SocialComposer({
  slug,
  basePath,
  postId,
  initialName,
  initialTargets,
  initialAmplifyStory,
  readiness,
  balance,
}: {
  slug: string;
  basePath: string;
  /** Null for a piece that has never been saved. */
  postId: string | null;
  initialName: string;
  initialTargets: { platform: string; content: SocialContent }[];
  initialAmplifyStory: boolean;
  /** Per-platform capability and connection facts, resolved on the server. */
  readiness: ComposerReadiness[];
  /** Growth Points this business has right now. */
  balance: number;
}) {
  const router = useRouter();
  const { ask, available: j4Available } = useJ4Ask();
  const [name, setName] = useState(initialName);
  const [targets, setTargets] = useState(initialTargets);
  const [amplifyStory, setAmplifyStory] = useState(initialAmplifyStory);
  const [savedId, setSavedId] = useState<string | null>(postId);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  const selectedIds = targets.map((t) => t.platform);

  // ============ THE STORY OFFER IS DERIVED, EVERY RENDER =============
  //
  // Sean: "The Story offer must be capability-derived, never hardcoded. Only
  // offer it when at least one selected platform's registered publisher declares
  // story capability AND that platform account is actually connected. If no
  // connected publisher supports Story, show nothing."
  //
  // Recomputed from the current selection rather than decided once, because
  // ticking Instagram off must take the offer away with it. Today no publisher
  // is registered, so `offered` is always false and nothing renders — which is
  // the honest state, not an oversight.
  const amplification = useMemo(
    () => storyAmplification(readiness, selectedIds),
    [readiness, selectedIds],
  );

  // A STALE TICK MUST NOT BUY ANYTHING. If the offer disappears — the last
  // story-capable platform was deselected — the flag stops counting, so the
  // investment can never include a +1 for something not on offer.
  const storyTaken = amplifyStory && amplification.offered;

  const investment = socialInvestment({ targetCount: targets.length, amplifyStory: storyTaken });
  const summary = investmentSummary({ investment, balance });

  const blocked = readiness
    .filter((r) => selectedIds.includes(r.platform.id))
    .map((r) => r.blockedReason)
    .filter((reason): reason is string => reason !== null);

  function toggle(platformId: string) {
    setTargets((current) => {
      const already = current.some((t) => t.platform === platformId);
      if (already) return current.filter((t) => t.platform !== platformId);
      const platform = socialPlatform(platformId);
      if (!platform) return current;
      // EMPTY, NEVER A COPY. See the note at the top of this file.
      return [...current, { platform: platform.id, content: emptyContent(platform.id) }];
    });
  }

  function updateContent(platformId: string, content: SocialContent) {
    setTargets((current) =>
      current.map((t) => (t.platform === platformId ? { ...t, content } : t)),
    );
  }

  function save() {
    setMessage(null);
    setFailed(false);
    startTransition(async () => {
      const result = await saveSocialDraft(slug, {
        postId: savedId,
        name,
        targets,
        amplifyStory: storyTaken,
      });
      if (!result.ok) {
        setFailed(true);
        setMessage(result.error ?? "That post could not be saved.");
        return;
      }
      setFailed(false);
      setSavedId(result.postId ?? null);
      setMessage("Saved. You can come back to this from Studio.");
      if (result.postId && !postId) {
        // replace, not push: saving is not a place somebody should be able to
        // go back to and find an empty composer.
        router.replace(
          `${basePath}/studio/social?platform=${encodeURIComponent(selectedIds[0] ?? "")}&post=${encodeURIComponent(result.postId)}`,
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
        <h1 className="mt-1 text-[26px] font-semibold tracking-tight">
          {targets.length === 1
            ? socialPlatform(targets[0].platform)?.label
            : `${targets.length} platforms`}
        </h1>
        <p className="mt-1 text-[14px] text-zinc-600 dark:text-zinc-400">
          One piece. Each platform gets its own writing.
        </p>
      </header>

      {/* WHERE THIS IS GOING. Every platform is offered; the ones not selected
          are simply off. Adding one adds an empty section for it. */}
      <div className="mt-6">
        <span className="text-[13px] font-medium">Post this to</span>
        <div className="mt-2 flex flex-wrap gap-2">
          {SOCIAL_PLATFORMS.map((platform) => {
            const on = selectedIds.includes(platform.id);
            return (
              <button
                key={platform.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(platform.id)}
                className={[
                  "rounded-full border px-4 py-2 text-[13px] font-medium transition",
                  on
                    ? "border-transparent text-white"
                    : "border-black/[.14] text-zinc-600 hover:border-black/40 dark:border-white/[.18] dark:text-zinc-300 dark:hover:border-white/50",
                ].join(" ")}
                style={on ? { background: GENESIS_GREEN } : undefined}
              >
                {platform.label}
              </button>
            );
          })}
        </div>
      </div>

      {j4Available && targets.length > 0 && (
        <div className="mt-5 flex flex-col gap-2">
          {targets.map((target) => {
            const platform = socialPlatform(target.platform);
            if (!platform) return null;
            return (
              <button
                key={target.platform}
                type="button"
                onClick={() => ask(platform.intent)}
                className="rounded-xl border border-black/[.10] px-4 py-2.5 text-left text-[13.5px] transition hover:border-black/30 dark:border-white/[.14] dark:hover:border-white/40"
              >
                <span className="font-medium">Ask J4 to write the {platform.label} one</span>
                {/* ONE ASK PER PLATFORM, deliberately. A single "write them all"
                    button would be the copied-caption problem wearing a
                    different hat. */}
              </button>
            );
          })}
        </div>
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

      {targets.length === 0 && (
        <p className="mt-8 text-[14px] text-zinc-500">
          Pick a platform above and its own editor appears here.
        </p>
      )}

      {targets.map((target) => {
        const platform = socialPlatform(target.platform);
        if (!platform) return null;
        const missing = whatIsMissing(target.content);
        return (
          <section
            key={target.platform}
            // A NAMED HOOK, not a count. Four editors can be on screen at once
            // and several of them label a field "The post" — selecting by DOM
            // order would resolve to whichever happened to render first.
            data-platform-editor={target.platform}
            className="mt-8 border-t border-black/[.08] pt-6 dark:border-white/[.10]"
          >
            <div className="flex items-baseline justify-between">
              <h2 className="text-[17px] font-semibold">{platform.label}</h2>
              <button
                type="button"
                onClick={() => toggle(target.platform)}
                className="rounded-lg px-2 py-1 text-[12px] text-zinc-500 transition hover:bg-black/[.05] dark:hover:bg-white/[.08]"
              >
                Remove
              </button>
            </div>
            <p className="mt-0.5 text-[13px] text-zinc-500">{platform.makes}</p>

            <div className="mt-4">
              <PlatformFields
                content={target.content}
                onChange={(content) => updateContent(target.platform, content)}
              />
            </div>

            <p className="mt-4 text-[13px] text-zinc-500">
              {isReadyToPublish(target.content) ? `The ${platform.label} one is ready.` : missing}
            </p>
          </section>
        );
      })}

      {/* ============ THE AMPLIFICATION, ONLY WHEN IT IS REAL ===========
          Rendered only when a registered publisher for a SELECTED platform
          declares story capability and that account is connected. There is no
          disabled state and no "coming soon" — if it cannot happen, it is not
          on the screen. */}
      {amplification.offered && (
        <div className="mt-8 rounded-2xl border border-black/[.10] p-4 dark:border-white/[.14]">
          <p className="text-[15px] font-medium">Want to extend your reach?</p>
          <p className="mt-1 text-[13.5px] text-zinc-500">
            Repost this to your Story on{" "}
            {amplification.platforms.map((p) => p.label).join(" and ")}. Genesis makes the
            upright version — a Story is a different shape from a post.
          </p>
          <label className="mt-3 flex items-center gap-2 text-[14px]">
            <input
              type="checkbox"
              checked={amplifyStory}
              onChange={(e) => setAmplifyStory(e.target.checked)}
              className="h-4 w-4"
            />
            <span>Add the Story · invest 1 more Growth Point</span>
          </label>
        </div>
      )}

      {/* ============ THE INVESTMENT, BEFORE COMMITMENT ==================
          Sean: "Make the +1 Story investment explicit before commitment" and
          "Say invest/investment, not spend/cost." So the total is shown, what it
          is made of is shown, and what would be left is shown — and the word is
          invest throughout. Nothing is deducted here: nothing can publish yet. */}
      {targets.length > 0 && (
        <div className="mt-6 rounded-2xl bg-black/[.03] p-4 dark:bg-white/[.05]">
          <p className="text-[15px] font-medium">{summary.total}</p>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {summary.lines.map((line) => (
              <li key={line} className="text-[13px] text-zinc-500">
                {line}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[13px] text-zinc-500">{summary.afterwards}</p>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending || targets.length === 0}
          className="rounded-full px-6 py-2.5 text-[15px] font-medium text-white transition hover:brightness-110 disabled:opacity-60"
          style={{ background: GENESIS_GREEN }}
        >
          {pending ? "Saving…" : savedId ? "Save changes" : "Save draft"}
        </button>
        <span className={`text-[13px] ${failed ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>
          {message}
        </span>
      </div>

      {/* WHY THERE IS NO POST BUTTON, named per selected platform rather than
          once — the reasons genuinely differ between X and Instagram. */}
      {blocked.length > 0 && (
        <div className="mt-6 flex flex-col gap-1.5 rounded-xl border border-black/[.08] px-4 py-3 dark:border-white/[.10]">
          {blocked.map((reason) => (
            <p key={reason} className="text-[13px] text-zinc-600 dark:text-zinc-400">
              {reason}
            </p>
          ))}
        </div>
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
                  // The id exists so removing shot 2 of 5 cannot renumber the
                  // others out from under React.
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
