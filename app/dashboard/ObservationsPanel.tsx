interface ObservationItem {
  dedupeKey: string;
  genesisState: string;
  summary: string;
}

// Mirrors ApprovalRequestsPanel's shape/conventions (same highlightId
// pattern, same card structure) for the one kind of item that panel can't
// show — real GenesisObservation rows (Red/Purple). Read-only by design:
// no Approve/Reject/dismiss action exists anywhere in this codebase for an
// observation (confirmed by grep) — it resolves automatically when the
// real condition stops being true (lib/dashboard/genesisObservations.ts),
// so none is invented here. Observations never get forced through the
// approval UI, and approvals never get forced through this one. Same
// red-500/purple-500 Genesis Language colors used everywhere else
// (LiveIntelligence's ticker dots, the Genesis Language legend) — not a
// new palette.
export function ObservationsPanel({
  observations,
  highlightId,
}: {
  observations: ObservationItem[];
  highlightId?: string;
}) {
  if (observations.length === 0) {
    return null;
  }

  return (
    <ul className="mt-4 flex max-w-md flex-col gap-2">
      {observations.map((obs) => {
        const isUrgent = obs.genesisState === "urgent";
        const isHighlighted = obs.dedupeKey === highlightId;
        const ringClass = isUrgent ? "border-red-500 ring-red-500" : "border-purple-500 ring-purple-500";
        const labelClass = isUrgent ? "text-red-600 dark:text-red-400" : "text-purple-600 dark:text-purple-400";

        return (
          <li
            key={obs.dedupeKey}
            className={`rounded-lg border px-3 py-2 ${
              isHighlighted ? `${ringClass} ring-1` : "border-black/[.08] dark:border-white/[.145]"
            }`}
          >
            <p className={`text-xs font-medium uppercase tracking-wide ${labelClass}`}>
              {isUrgent ? "Genesis flagged this as urgent" : "Genesis noticed an opportunity"}
            </p>
            <p className="mt-1 text-sm text-black dark:text-zinc-50">{obs.summary}</p>
          </li>
        );
      })}
    </ul>
  );
}
