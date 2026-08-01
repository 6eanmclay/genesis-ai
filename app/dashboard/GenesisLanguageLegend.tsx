import { GENESIS_STATE_META, type GenesisState } from "@/lib/dashboard/genesisState";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";

// Genesis Language v2 (memory project_genesis_language_model.md) — the five
// real assessment states, in semantic order (Peace, Curiosity, Optimism,
// Responsibility, Concern), not deriveAssessmentState's priority order —
// this is a teaching legend, read top-to-bottom once, not a ranked list.
// "Working" is deliberately not one of these five (see the note below the
// list) — it's a process signal, not a business assessment.
const LEGEND_ORDER: GenesisState[] = ["idle", "curiosity", "opportunity", "needs_decision", "urgent"];

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
      {/* Working is not a sixth color — a real request in flight is a
          process signal, not a business assessment, so it never suppresses
          or replaces one of the five colors above. Explained honestly here
          rather than misrepresented as a peer state. */}
      <p className="mt-3 text-xs leading-relaxed" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
        A pulsing ring means Genesis is actively working on your last
        request — layered on top of whichever color is already showing.
      </p>
    </div>
  );
}
