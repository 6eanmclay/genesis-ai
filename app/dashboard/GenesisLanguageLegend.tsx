import { GENESIS_STATE_META, type GenesisState } from "@/lib/dashboard/genesisState";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";

// Matches the reference composition's ordering (Available, Working,
// Opportunity, Decision, Important), not deriveGenesisState's priority
// order — this is a teaching legend, read top-to-bottom once, not a
// ranked list.
const LEGEND_ORDER: GenesisState[] = ["idle", "working", "opportunity", "needs_decision", "urgent"];

// Right rail, xl:+ only (see DashboardShell.tsx) — a static, isolated
// explanation of the state colors the owner already sees elsewhere
// (GenesisAssistant's pill, the Domicile, the amber nav badges), sourced
// from the one shared GENESIS_STATE_META map so these colors can never
// drift out of sync with what's actually rendered. Deliberately built as
// its own standalone component with no dependency on the grid/shell around
// it, so it can be hidden or replaced later without touching anything
// else — no dismiss/persistence mechanic is being built yet, only the
// isolation that makes adding one later cheap.
export function GenesisLanguageLegend() {
  return (
    <div>
      <p
        className="text-[10px] font-medium uppercase tracking-wide"
        style={{ color: GENESIS_ATMOSPHERE.textSecondary }}
      >
        The Genesis Language
      </p>
      <ul className="mt-3 flex flex-col gap-2.5">
        {LEGEND_ORDER.map((state) => {
          const meta = GENESIS_STATE_META[state];
          return (
            <li
              key={state}
              className="flex items-center gap-2.5 text-sm"
              style={{ color: GENESIS_ATMOSPHERE.text }}
            >
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${meta.dotClassName.replace("animate-pulse ", "")}`}
                aria-hidden="true"
              />
              {meta.label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
