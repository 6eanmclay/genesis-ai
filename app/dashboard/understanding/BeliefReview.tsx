"use client";

import { useState, useTransition } from "react";
import type { ReviewableBelief } from "@/lib/intelligence/beliefReview";
import { contradictBeliefAction, restoreBeliefAction } from "./actions";

// WHAT J4 BELIEVES, AND THE ARGUMENT BACK (2026-08-22, U4).
//
// The section this replaces showed a claim, a confidence percentage and a
// maturity phrase, and that was all — no evidence, no dates, and no way to
// disagree. Its own comment said so: "A real correction UI is named future
// work".
//
// THE TONE IS THE RISK HERE, more than the mechanics. A confident-sounding
// wrong belief shown to an owner is worse than one they never saw, because it
// arrives with the authority of a system that has been watching their business.
// So this reads as "here is what I have noticed, tell me if I am wrong" — the
// evidence sits directly under the claim where it can be checked, and
// disagreeing is one click rather than a buried setting.

const QUIET =
  "rounded-full border border-black/[.08] px-3 py-1.5 text-xs transition-colors hover:bg-black/[.03] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-white/[.05]";
const INPUT =
  "w-full rounded-lg border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50";

const EVIDENCE_LABEL: Record<string, string> = {
  finding: "Noticed",
  event: "Happened",
  measurement: "Measured",
  decision: "You decided",
};

function formatDate(value: Date): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function BeliefCard({
  belief,
  canCorrect,
  slug,
  contradicted,
}: {
  belief: ReviewableBelief;
  canCorrect: boolean;
  slug?: string;
  contradicted: boolean;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const [arguing, setArguing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState("");

  // WHETHER IT IS BEING RECONSIDERED, read from the dates rather than stored.
  // A belief that held for months and was contradicted last week is the single
  // most useful thing on this screen, and it is derivable — describeMaturity
  // already says so in words; this is the same fact, shown.
  const shaken =
    belief.lastContradictedAt !== null &&
    belief.lastContradictedAt.getTime() > belief.lastConfirmedAt.getTime();

  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className={`text-sm ${contradicted ? "text-zinc-500 line-through" : "text-black dark:text-zinc-50"}`}>
          {belief.claim}
        </p>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
          {belief.aboutYou && (
            <span className="rounded-full bg-black/[.05] px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-600 dark:bg-white/[.1] dark:text-zinc-300">
              About you
            </span>
          )}
          {shaken && !contradicted && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              Reconsidering
            </span>
          )}
          <span className="rounded-full bg-black/[.05] px-2 py-0.5 text-[10px] text-zinc-600 dark:bg-white/[.1] dark:text-zinc-300">
            {Math.round(belief.confidence * 100)}% confidence
          </span>
        </div>
      </div>

      <p className="mt-1 text-xs text-zinc-500">
        {belief.categoryLabel} &middot; {belief.maturity}
      </p>

      {/* THE DATES, which are what say whether a belief still holds. First
          noticed and last confirmed were both on the row and neither was ever
          shown, so a pattern from March and one from yesterday read identically. */}
      <p className="mt-1 text-xs text-zinc-500">
        First noticed {formatDate(belief.firstObservedAt)} &middot; last confirmed{" "}
        {formatDate(belief.lastConfirmedAt)}
        {belief.lastContradictedAt && <> &middot; last contradicted {formatDate(belief.lastContradictedAt)}</>}
      </p>

      {contradicted && belief.contradictedReason && (
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">{belief.contradictedReason}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/* Evidence is one click away rather than always open: a belief with
            eleven supporting rows would otherwise bury the next claim. */}
        {belief.evidenceCount > 0 && (
          <button className={QUIET} onClick={() => setShowEvidence((v) => !v)}>
            {showEvidence ? "Hide" : "Why"} &middot; {belief.evidenceCount}{" "}
            {belief.evidenceCount === 1 ? "thing" : "things"}
          </button>
        )}
        {canCorrect && !contradicted && (
          <button className={QUIET} disabled={pending} onClick={() => setArguing((v) => !v)}>
            This isn&apos;t right
          </button>
        )}
        {canCorrect && contradicted && (
          <button
            className={QUIET}
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError("");
                const data = new FormData();
                data.set("beliefId", belief.id);
                const outcome = await restoreBeliefAction(data, slug);
                if (!outcome.ok) setError("That couldn't be undone.");
              })
            }
          >
            {pending ? "Undoing..." : "Actually, it was right"}
          </button>
        )}
      </div>

      {showEvidence && (
        <ul className="mt-2 flex flex-col gap-1 border-l border-black/[.08] pl-3 dark:border-white/[.145]">
          {belief.evidence.map((item, index) => (
            <li key={index} className="text-xs text-zinc-600 dark:text-zinc-400">
              <span className="text-zinc-500">{EVIDENCE_LABEL[item.kind] ?? "Recorded"}</span>{" "}
              {formatDate(item.occurredAt)} — {item.summary}
            </li>
          ))}
          {/* REPORTED, NOT HIDDEN. Evidence can legitimately be gone, and a list
              that silently shrank would make a belief look thinner than the
              number on the button says. */}
          {belief.evidenceMissing > 0 && (
            <li className="text-xs text-zinc-500">
              {belief.evidenceMissing} older {belief.evidenceMissing === 1 ? "one is" : "ones are"} no
              longer on file.
            </li>
          )}
          {belief.evidence.length === 0 && belief.evidenceMissing === 0 && (
            <li className="text-xs text-zinc-500">Nothing on file to show for this one.</li>
          )}
        </ul>
      )}

      {arguing && (
        <form
          className="mt-3 flex flex-col gap-2"
          action={(formData) =>
            start(async () => {
              setError("");
              formData.set("beliefId", belief.id);
              const outcome = await contradictBeliefAction(formData, slug);
              if (outcome.ok) {
                setArguing(false);
              } else {
                setError(
                  outcome.refusal === "not_permitted"
                    ? "Only the business owner can correct what J4 believes."
                    : "I couldn't find that one any more."
                );
              }
            })
          }
        >
          <input
            name="note"
            className={INPUT}
            placeholder="What's actually true? (optional)"
            maxLength={500}
          />
          <div className="flex items-center gap-2">
            <button type="submit" className={QUIET} disabled={pending}>
              {pending ? "Saving..." : "Mark this wrong"}
            </button>
            <button type="button" className={QUIET} disabled={pending} onClick={() => setArguing(false)}>
              Cancel
            </button>
          </div>
          {/* Stating what IS true is a different act from marking this wrong,
              and conflating them would put a sentence the owner typed into a
              field meant for a conclusion J4 derived. */}
          <p className="text-xs text-zinc-500">
            This stops J4 using it. To tell J4 what is actually true, say so in chat.
          </p>
        </form>
      )}

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </li>
  );
}

export function BeliefReview({
  active,
  contradicted,
  canCorrect,
  slug,
}: {
  active: ReviewableBelief[];
  contradicted: ReviewableBelief[];
  canCorrect: boolean;
  slug?: string;
}) {
  const [showContradicted, setShowContradicted] = useState(false);

  if (active.length === 0 && contradicted.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        Nothing yet — beliefs form once a real pattern repeats.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {active.length > 0 ? (
        <ul className="flex flex-col divide-y divide-black/[.06] dark:divide-white/[.08]">
          {active.map((b) => (
            <BeliefCard key={b.id} belief={b} canCorrect={canCorrect} slug={slug} contradicted={false} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-500">
          Nothing J4 currently believes — everything it had, you&apos;ve corrected.
        </p>
      )}

      {/* KEPT AND SHOWN, not deleted. A correction the owner cannot see is a
          correction they cannot take back, and "what have I told J4 is wrong?"
          is a reasonable question to be able to answer. */}
      {contradicted.length > 0 && (
        <div>
          {/* Built as ONE string rather than interleaved JSX expressions. The
              interleaved form rendered "Show 1you've corrected" in a real
              browser — JSX dropped the space between the count and the next
              word, which typechecks perfectly and reads as a typo to an owner. */}
          <button className={QUIET} onClick={() => setShowContradicted((v) => !v)}>
            {`${showContradicted ? "Hide" : "Show"} ${contradicted.length} you've corrected`}
          </button>
          {showContradicted && (
            <ul className="mt-2 flex flex-col divide-y divide-black/[.06] dark:divide-white/[.08]">
              {contradicted.map((b) => (
                <BeliefCard key={b.id} belief={b} canCorrect={canCorrect} slug={slug} contradicted />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
