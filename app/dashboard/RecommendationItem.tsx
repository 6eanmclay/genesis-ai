"use client";

import { useState } from "react";
import Link from "next/link";
import type { Recommendation } from "@/lib/dashboard/types";
import type { RecommendationExplanation } from "@/lib/dashboard/explainRecommendation";

// Deliberately no severity dot and no own card chrome here — that's
// Attention's visual language (a problem needing a decision). An insight is
// a suggestion, not a status, so several of these sit together inside one
// shared container (RecommendationsPanel) separated only by a hairline
// divider, reading as one cohesive message from Genesis rather than a stack
// of dashboard cards. Priority still determines sort order (see
// lib/dashboard/recommendations.ts) — it just isn't drawn as a stoplight.
export function RecommendationItem({
  recommendation,
  explainAction,
}: {
  recommendation: Recommendation;
  explainAction: (id: string) => Promise<RecommendationExplanation>;
}) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [explanation, setExplanation] = useState<string | null>(null);

  async function handleAsk() {
    setState("loading");
    try {
      const result = await explainAction(recommendation.id);
      setExplanation(result.explanation);
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <p className="text-sm text-black dark:text-zinc-50">{recommendation.message}</p>
      {explanation && <p className="mt-1.5 text-xs text-zinc-500">{explanation}</p>}
      <div className="mt-2.5 flex flex-wrap items-center gap-3">
        <Link
          href={recommendation.actionHref}
          className="text-xs font-medium text-[var(--brand-accent,#2563eb)] underline"
        >
          {recommendation.actionLabel}
        </Link>
        {/* Genesis-authored recommendations (source: "genesis") already state
            their own reasoning in `message` — no separate explain step for
            them, and their ids are real DB cuids never present in
            RECOMMENDATION_MESSAGES, so the lookup this button relies on
            would throw. Only rule-based recommendations get this pill. */}
        {!explanation && recommendation.source === "rules" && (
          <button
            onClick={handleAsk}
            disabled={state === "loading"}
            className="text-xs font-medium text-zinc-500 underline decoration-dotted hover:text-black disabled:opacity-50 dark:hover:text-zinc-50"
          >
            {state === "loading"
              ? "Asking Genesis..."
              : state === "error"
                ? "Couldn't explain — try again"
                : "Why does this matter?"}
          </button>
        )}
      </div>
    </li>
  );
}
