"use client";

import { useState, useTransition } from "react";
import { applyReferenceDesign } from "@/app/dashboard/actions";
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
// Selection is local state and changes nothing. The ONE mutation is the Apply
// click, which sends the ticked INDEXES and nothing else — the server re-reads
// the stored reading, re-runs the same gate this card was built from, and
// resolves those numbers itself. So this component cannot name a dimension or
// a value, and a tampered request can only ever pick a different subset of
// what J4 actually proposed.
//
// What comes back is J4's derived report, shown verbatim: a failure says it
// failed rather than restating the request in the past tense.

export function ReferenceProposalCard({
  presentation,
  messageId,
}: {
  presentation: ReferencePresentation;
  /** The message this card was drawn from. Absent = nothing to apply against. */
  messageId?: string;
}) {
  const [chosen, setChosen] = useState<number[]>(() => presentation.choices.map((c) => c.index));
  const [pending, startTransition] = useTransition();
  const [report, setReport] = useState<{ ok: boolean; text: string } | null>(null);

  // ============ APPROVAL IS THIS CLICK AND NOTHING ELSE =============
  //
  // Not opening the card, not viewing it, not ticking a box. Those change what
  // WOULD be applied; only this says to apply it. The payload is the indexes
  // the owner ticked - the server re-runs the gate and resolves them itself,
  // so this component cannot name a dimension or a value even if it tried.
  const apply = () => {
    if (!messageId || chosen.length === 0) return;
    startTransition(async () => {
      const result = await applyReferenceDesign(messageId, chosen);
      setReport(
        result.ok
          ? { ok: result.report.succeeded, text: result.report.sentence }
          : { ok: false, text: result.error },
      );
    });
  };

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
            onClick={apply}
            disabled={!messageId || pending || chosen.length === 0 || !!report?.ok}
            data-testid="reference-apply"
            className="rounded-full px-4 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{ backgroundColor: "rgba(74,222,58,0.18)", color: GENESIS_ATMOSPHERE.text }}
          >
            {pending
              ? "Applying..."
              : `Apply ${chosen.length} change${chosen.length === 1 ? "" : "s"}`}
          </button>
          {/* WHAT ACTUALLY HAPPENED, in J4's own derived words. Never the
              request echoed back: a failure says it failed, and a change the
              live page has not been checked for says that too. */}
          {report && (
            <p
              data-testid="reference-report"
              data-ok={report.ok ? "true" : "false"}
              className="mt-2 text-[12px]"
              style={{ color: report.ok ? GENESIS_ATMOSPHERE.text : "#f87171" }}
            >
              {report.text}
            </p>
          )}
          {!report && (
            <p className="mt-2 text-[11px] text-zinc-500">
              Nothing changes until you press this.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
