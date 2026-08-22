import Link from "next/link";
import { sectionHref } from "@/lib/dashboard/navConfig";
import type { Recommendation } from "@/lib/dashboard/types";
import type { RecommendationExplanation } from "@/lib/dashboard/explainRecommendation";
import { RecommendationItem } from "./RecommendationItem";

// One shared soft-tinted container, and — per the emotional-direction pass
// — one lead insight rather than a list of equally-weighted rows. Genesis
// states the one thing it thinks matters most as a real conclusion (full
// message, action, and "why" on demand via RecommendationItem's explain
// button), the same observes -> recommends pattern as the rest of the
// product. Anything else surfaces underneath as plain action links, still
// one click away, just not competing for the same attention as the lead
// insight. No article, no "learn more" — a conclusion and an action, per
// the explicit product principle.
export function RecommendationsPanel({
  recommendations,
  explainAction,
  basePath,
}: {
  recommendations: Recommendation[];
  explainAction: (id: string) => Promise<RecommendationExplanation>;
  /** See RecommendationItem's own note — every link here is business-scoped. */
  basePath: string;
}) {
  const [lead, ...rest] = recommendations;

  return (
    <div className="mt-4 max-w-2xl rounded-2xl border border-[var(--brand-accent)]/15 bg-[var(--brand-accent)]/[0.035] px-5 py-4">
      {!lead ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Nothing to flag right now — ask Genesis for a fresh look anytime.
        </p>
      ) : (
        <>
          <ul>
            <RecommendationItem recommendation={lead} explainAction={explainAction} basePath={basePath} />
          </ul>
          {rest.length > 0 && (
            <p className="mt-3 border-t border-[var(--brand-accent)]/10 pt-3 text-xs text-zinc-500">
              Also worth a look:{" "}
              {rest.map((rec, i) => (
                <span key={rec.id}>
                  {i > 0 && ", "}
                  <Link href={sectionHref(rec.actionHref, basePath)} className="font-medium text-[var(--brand-accent,#2563eb)] underline">
                    {rec.actionLabel}
                  </Link>
                </span>
              ))}
            </p>
          )}
        </>
      )}
    </div>
  );
}
