// One side (current or proposed) of a plain string-list field — e.g.
// featuredCollections, brandKeywords. Same box styling as FieldValueList,
// called once per VisualProposal slot, matching that component's exact
// calling convention rather than rendering both sides internally.
export function StringListView({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-black/[.06] bg-black/[.02] p-3 text-xs dark:border-white/[.08] dark:bg-white/[.03]">
      <p className="font-medium text-zinc-500">{label}</p>
      {items.length === 0 ? (
        <p className="mt-1 text-black dark:text-zinc-50">(empty)</p>
      ) : (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-black dark:text-zinc-50">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
