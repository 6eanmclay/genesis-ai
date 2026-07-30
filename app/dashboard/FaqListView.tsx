// One side (current or proposed) of the FAQ list — the one field shape in
// Phase 2 Milestone 1 complex enough to warrant its own small component.
// Just the full list, plainly rendered — never a computed per-item diff,
// which would be real over-engineering for a handful of Q&A entries.
export function FaqListView({ items }: { items: { question: string; answer: string }[] }) {
  return (
    <div className="rounded-xl border border-black/[.06] bg-black/[.02] p-3 text-xs dark:border-white/[.08] dark:bg-white/[.03]">
      <p className="font-medium text-zinc-500">FAQ</p>
      {items.length === 0 ? (
        <p className="mt-1 text-black dark:text-zinc-50">(empty)</p>
      ) : (
        <ol className="mt-1 flex list-decimal flex-col gap-2 pl-4">
          {items.map((item, i) => (
            <li key={i} className="text-black dark:text-zinc-50">
              <p className="font-medium">{item.question}</p>
              <p className="text-zinc-500">{item.answer}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
