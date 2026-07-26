import Link from "next/link";
import type { AttentionItem } from "@/lib/dashboard/types";

// Severity shapes both the dot and the message weight — a genuine failure
// stays clearly visible, but a routine "worth a look" item recedes into
// quiet gray text rather than reading as an alarm. No borders/boxes here on
// purpose: this list sits inline under a heading, not stacked as cards.
const SEVERITY_DOT: Record<AttentionItem["severity"], string> = {
  FAILED: "bg-red-500",
  WARNING: "bg-amber-500/70",
};

const SEVERITY_TEXT: Record<AttentionItem["severity"], string> = {
  FAILED: "text-black dark:text-zinc-50",
  WARNING: "text-zinc-600 dark:text-zinc-400",
};

// Home's "Needs your attention" now only ever receives genuine issues —
// recent failures, abandoned OAuth handoffs, broken integrations. Routine
// incomplete setup (unpublished store, no products, no payment) moved to
// BusinessJourney.tsx, framed as progress remaining rather than a warning,
// so this component no longer needs the old two-group (recentOutcomes vs.
// currentState) split — there's only ever one real kind of item left here.
export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-2.5">
          <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[item.severity]}`} />
          <div>
            <p className={`text-sm ${SEVERITY_TEXT[item.severity]}`}>{item.message}</p>
            {item.occurredAt && (
              <p className="mt-0.5 text-xs text-zinc-500">{item.occurredAt.toLocaleString()}</p>
            )}
            {item.actionHref && (
              <Link
                href={item.actionHref}
                className="mt-0.5 inline-block text-xs font-medium text-[var(--brand-accent,#2563eb)] underline"
              >
                Take a look →
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
