import Link from "next/link";
import type { DiscoveryItem } from "@/lib/dashboard/discovery";

const KIND_LABEL: Record<DiscoveryItem["kind"], string> = {
  recommendation: "Recommendation",
  opportunity: "Opportunity",
  explanation: "Worth understanding",
  prediction: "Goal progress",
};

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Home Redesign (v30) — Discovery is the centerpiece, not a collapsed
// lead-item-plus-links. That older pattern (see RecommendationsPanel)
// existed because the underlying data was a flat, undifferentiated list;
// runCognitiveReview's own "typically 1-3 recommendations, never padding"
// discipline already keeps the real count small, so showing every ACTIVE
// item (capped defensively at the query level, see getDiscoveryFeed) is
// honest, not overwhelming.
//
// The empty state is the actual point of this component, not a fallback:
// when Genesis genuinely found nothing, it says so plainly and calmly —
// Sean's own wording — rather than manufacturing something to fill the
// space. This is the one deliberate place in the product that uses the
// "Genesis never stops working on your business" identity line; it isn't
// repeated elsewhere.
export function DiscoveryFeed({ items }: { items: DiscoveryItem[] }) {
  if (items.length === 0) {
    return (
      <div className="mt-4 max-w-2xl rounded-2xl border border-[var(--brand-accent)]/15 bg-[var(--brand-accent)]/[0.035] px-5 py-4">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          I didn&apos;t find anything significant today. Your business appears to be on track.
        </p>
        <p className="mt-1 text-xs text-zinc-500">Genesis never stops working on your business.</p>
      </div>
    );
  }

  return (
    <div className="mt-4 flex max-w-2xl flex-col gap-3">
      {items.map((item) => (
        <div
          key={item.id}
          className="rounded-2xl border border-[var(--brand-accent)]/15 bg-[var(--brand-accent)]/[0.035] px-5 py-4"
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
              {KIND_LABEL[item.kind]}
            </p>
            <p className="text-[10px] text-zinc-400">found {formatTimeAgo(item.generatedAt)}</p>
          </div>
          <p className="mt-1.5 text-sm text-zinc-800 dark:text-zinc-200">{item.summary}</p>
          {item.actionHref && (
            <Link
              href={item.actionHref}
              className="mt-2 inline-block text-xs font-medium text-[var(--brand-accent,#2563eb)] underline"
            >
              {item.actionLabel ?? "Take a look"}
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}
