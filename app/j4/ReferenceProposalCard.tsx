"use client";

import { useState } from "react";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import type { ReferencePresentation } from "@/lib/design/referencePresentation";

// WHAT J4 SAW, AND WHAT J4 WANTS TO CHANGE — never the same line.
//
// ============ WHY THE OBSERVATION IS ON THE CARD (2026-09-10) =========
//
// Sean: "For every actionable proposal, show its cited observation alongside it
// so the owner can independently judge whether the recommendation makes sense."
//
// The first live run is the argument. A mascot logo produced four flawless
// proposals, one of which read a button style off the logo's own label. Every
// gate was green; the reading was internally honest and about the wrong thing.
// An eligibility check now stops that particular case, but the general problem
// does not go away: a recommendation can be well-formed and still wrong, and
// the only reader who can tell is the owner — who needs to see what it was
// based on.
//
// So "I saw" is rendered in the reference's own terms and "I'd change" in the
// store's, visibly separate, one above the other. An owner can reject either
// half on its own grounds.
//
// ============ AND NOTHING HERE CHANGES ANYTHING =======================
//
// Sean: "Show/Choose must be completely non-mutating... approval must not call
// refine_storefront, mutate the theme, or write an execution result."
//
// This component holds selection in local state and calls nothing. There is no
// server action imported, no fetch, no mutation of any kind — which makes the
// claim a property of the file rather than a promise about it. The confirm
// control is deliberately inert and SAYS SO, rather than looking finished: a
// button that appears to apply changes and does not is the kind of prototype
// screen this project does not ship.

export function ReferenceProposalCard({ presentation }: { presentation: ReferencePresentation }) {
  const [chosen, setChosen] = useState<number[]>(() => presentation.choices.map((c) => c.index));

  const toggle = (index: number) =>
    setChosen((current) =>
      current.includes(index) ? current.filter((i) => i !== index) : [...current, index],
    );

  return (
    <div
      data-testid="reference-proposal-card"
      className="mt-3 w-full rounded-2xl border p-4"
      style={{ borderColor: GENESIS_ATMOSPHERE.border, backgroundColor: "rgba(255,255,255,0.02)" }}
    >
      <p className="text-[13px] leading-relaxed" style={{ color: GENESIS_ATMOSPHERE.text }}>
        {presentation.inWords}
      </p>

      {presentation.nothingActionable ? (
        // THE HONEST EMPTY STATE. Not a hidden card and not an apology: J4 read
        // the reference and has nothing it can act on, and saying so is the
        // whole reason bearsOn may be null.
        <p data-testid="reference-nothing-actionable" className="mt-3 text-[12px] text-zinc-400">
          Nothing in it maps onto something I can change on your storefront yet, so I&rsquo;m not going to
          pretend otherwise.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {presentation.choices.map((choice) => {
            const selected = chosen.includes(choice.index);
            return (
              <li key={choice.index} data-testid="reference-choice">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggle(choice.index)}
                    data-testid={`reference-choice-input-${choice.index}`}
                    className="mt-1 h-4 w-4 shrink-0 accent-[#4ade3a]"
                  />
                  <span className="min-w-0 flex-1">
                    {/* WHAT J4 SAW — the reference's terms, verbatim. */}
                    <span
                      data-testid="reference-saw"
                      className="block text-[12px] leading-snug text-zinc-400"
                    >
                      I saw: {choice.saw}
                    </span>
                    {/* WHAT J4 CAN CHANGE — this store's terms, and only ever
                        a dimension label and one of its permitted values. */}
                    <span
                      data-testid="reference-change"
                      className="mt-0.5 block text-[13px] font-medium"
                      style={{ color: GENESIS_ATMOSPHERE.text }}
                    >
                      I&rsquo;d change: {choice.label} → {choice.value}
                    </span>
                    {/* WHY — the relationship between the two. */}
                    <span data-testid="reference-why" className="mt-0.5 block text-[12px] text-zinc-500">
                      {choice.why}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {presentation.seenButUnchangeable.length > 0 && (
        // SEEN, AND SAID TO BE UNCHANGEABLE. Rendered as plain text with no
        // control of any kind, so an observation J4 cannot act on is
        // structurally incapable of being chosen — not merely disabled.
        <div className="mt-4" data-testid="reference-seen-only">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            I can see these, but I can&rsquo;t change them yet
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {presentation.seenButUnchangeable.map((seen) => (
              <li key={seen} className="text-[12px] text-zinc-400">
                {seen}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!presentation.nothingActionable && (
        <div className="mt-4 border-t pt-3" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
          <button
            type="button"
            disabled
            data-testid="reference-apply"
            className="rounded-full px-4 py-1.5 text-[12px] font-medium opacity-50"
            style={{ backgroundColor: "rgba(255,255,255,0.08)", color: GENESIS_ATMOSPHERE.text }}
          >
            Apply {chosen.length} change{chosen.length === 1 ? "" : "s"}
          </button>
          {/* SAYS WHAT IT IS. An inert control that looked finished would be a
              prototype screen; one that explains itself is an honest edge. */}
          <p className="mt-2 text-[11px] text-zinc-500">
            Choosing is live — applying isn&rsquo;t connected yet, so nothing here changes your store.
          </p>
        </div>
      )}
    </div>
  );
}
