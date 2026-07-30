import { FIELD_LABELS } from "@/lib/execution/genesisActions";

// A small, honest preview of real field values — split into two columns
// (current/proposed, each one call of this component) so any flat-string
// action can render through the same VisualProposal shell as
// update_hero/update_theme. Deliberately not a themed section mock — this
// is plainly "here are the words," not a claim about layout. Promoted out
// of website/page.tsx (Phase 2 Milestone 1) once Settings/Marketing needed
// the exact same rendering for their own new approval types.
export function FieldValueList({
  fields,
  values,
}: {
  fields: string[];
  values: Record<string, unknown>;
}) {
  return (
    <dl className="flex flex-col gap-2 rounded-xl border border-black/[.06] bg-black/[.02] p-3 dark:border-white/[.08] dark:bg-white/[.03]">
      {fields.map((key) => (
        <div key={key} className="text-xs">
          <dt className="font-medium text-zinc-500">{FIELD_LABELS[key] ?? key}</dt>
          <dd className="mt-0.5 text-black dark:text-zinc-50">{String(values[key] ?? "(empty)")}</dd>
        </div>
      ))}
    </dl>
  );
}
