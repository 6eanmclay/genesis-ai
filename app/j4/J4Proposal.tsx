import {
  approveProposalInConversation,
  rejectProposalInConversation,
  chooseDirectionInConversation,
} from "./proposal-actions";
import { ProposalComparison, type ComparisonSide } from "@/app/dashboard/ProposalComparison";
import { ActionDiffRows } from "@/lib/execution/ActionDiff";
import { TellJ4Button } from "./TellJ4Button";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { resolveProposalScope, type ProposalScope } from "@/lib/storefront/proposalScope";
import type { Proposal } from "@/lib/storefront/proposals";

// A proposal, inside the conversation that produced it (2026-08-14).
//
// Decision 4 of GENESIS_SURFACES.md, and the architectural fork it settled:
// "a proposal belongs to J4 first, not a disconnected page... when the owner
// is looking at the thing being discussed, J4 should be able to say 'here's
// what I'm proposing' and visually show it without taking the owner away from
// what they're looking at."
//
// So this renders in the persistent layer, over whatever page the owner is on.
// It is not a link to the Website tab, and approving it does not move them.
//
// THE PROPOSAL IS NOT A CHAT. IT IS A VISUAL TOOL INSIDE THE CHAT.
// Sean's own sentence, and the rule this file is built to. There is exactly
// one J4 conversation; this card is a view into it, never a second thread.
// So it deliberately has no message list, no composer, and no history of its
// own — an earlier version of this card kept a "how we got here" list of
// revisions, which was a second telling of events the conversation directly
// above it already contains. The version number is all that remains, because
// "version 2" is a label, not a history.
//
// WHAT IT DELIBERATELY DOES NOT HAVE: a "discuss" or "refine" button. The
// rebuttal is the composer directly underneath it. The owner types "I don't
// like that, keep the handmade feel" the same way they said anything else,
// and J4 revises the same proposal. Putting a button on it would turn a
// conversation back into a form.

export function J4Proposal({
  proposal,
  storefrontUrl,
  storeName,
  otherPendingCount = 0,
}: {
  proposal: Proposal;
  storefrontUrl: string;
  storeName: string;
  /** Other proposals still waiting. Named, never rendered as rival threads. */
  otherPendingCount?: number;
}) {
  const current = proposal.current;

  // Stored scope wins; a proposal written before scope existed is measured
  // now rather than shown at some arbitrary default size.
  const scope: ProposalScope =
    current.scope ??
    resolveProposalScope({
      target: current.target,
      mutationCount:
        typeof current.input === "object" && current.input !== null
          ? Object.keys(current.input as Record<string, unknown>).length
          : 1,
    });

  // Which proposals can honestly be shown as a storefront, and how.
  //
  // Sean: "a textual description like 'I changed the font' is not enough. J4
  // needs to show the owner what changed." Where a real storefront preview is
  // possible, that is what appears. Where it is not, a field-level comparison
  // appears instead — never an iframe of the unchanged shop dressed up as a
  // proposal, which would be a preview that lies about having previewed
  // anything.
  const separator = storefrontUrl.includes("?") ? "&" : "?";
  const actionType = current.actionType;

  const previewBase = `${storefrontUrl}${separator}previewProposal=${encodeURIComponent(proposal.proposalId)}`;

  const sides: ComparisonSide[] = [];
  if (actionType === "refine_storefront" || actionType === "update_theme") {
    // Both end in a theme; resolvePreviewTheme renders the real storefront
    // with it applied. When the revision offers directions, each becomes its
    // own side of the same toggle rather than its own proposal.
    sides.push({ id: "current", label: "Current", url: storefrontUrl });
    if (current.directions.length > 0) {
      for (const d of current.directions) {
        sides.push({
          id: d.id,
          label: d.label,
          url: `${previewBase}&previewDirection=${encodeURIComponent(d.id)}`,
        });
      }
    } else {
      sides.push({ id: "proposed", label: "J4's proposal", url: previewBase });
    }
  } else if (actionType === "update_section_order") {
    // The longstanding previewOrder parameter, reused rather than replaced.
    const order = (current.input as { sectionOrder?: unknown })?.sectionOrder;
    if (Array.isArray(order) && order.length > 0) {
      sides.push({ id: "current", label: "Current", url: storefrontUrl });
      sides.push({
        id: "proposed",
        label: "J4's proposal",
        url: `${storefrontUrl}${separator}previewOrder=${encodeURIComponent(order.join(","))}`,
      });
    }
  }

  return (
    <div
      className="mt-3 rounded-2xl border p-4"
      style={{ borderColor: GENESIS_ATMOSPHERE.violet, backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-[#f4f2fb]">{current.summary}</p>
        {current.revision > 1 && (
          <span className="shrink-0 text-[11px]" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            version {current.revision}
          </span>
        )}
      </div>

      {/* J4's reasoning, kept distinct from what changes. This is the thing
          the owner argues with. */}
      {current.rationale && (
        <p className="mt-1.5 text-[13px] leading-snug" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
          {current.rationale}
        </p>
      )}

      {sides.length > 1 ? (
        <ProposalComparison sides={sides} scope={scope} storeName={storeName} />
      ) : (
        // No storefront preview exists for this kind of change, so the owner
        // gets the real field values instead — the same honest Current ->
        // Proposed diff the dashboard already uses, moved into the
        // conversation rather than left on a page to be found.
        <div className="mt-3">
          <ActionDiffRows input={current.input as Record<string, unknown>} previousValues={current.previousValues as Record<string, unknown>} />
        </div>
      )}

      {current.directions.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {current.directions.map((d) => (
            <form key={d.id} action={chooseDirectionInConversation.bind(null, current.id, d.id)}>
              <button
                type="submit"
                className="rounded-full border px-3 py-1.5 text-xs font-medium text-[#f4f2fb] transition-opacity hover:opacity-90"
                style={{ borderColor: GENESIS_ATMOSPHERE.violet }}
              >
                Go with {d.label}
              </button>
            </form>
          ))}
          <TellJ4Button className="rounded-full px-3 py-1.5 text-xs font-medium underline underline-offset-2 transition-colors hover:bg-white/[.06]" />
        </div>
      )}

      {/* All three decisions, together: apply it, turn it down, or argue with
          it. The third used to be a sentence rather than a control, which
          quietly made the most important one the least available. */}
      <div className="mt-3 flex flex-wrap items-center gap-2" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
        {/* Plain forms bound to the real Server Actions, the same shape
            VisualProposal already uses for these exact two actions. */}
        <form action={approveProposalInConversation.bind(null, current.id)}>
          <button
            type="submit"
            className="rounded-full bg-[#2563eb] px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            Apply this
          </button>
        </form>
        <form action={rejectProposalInConversation.bind(null, current.id)}>
          <button
            type="submit"
            className="rounded-full px-4 py-2 text-xs font-medium transition-colors hover:bg-white/[.06]"
            style={{ color: GENESIS_ATMOSPHERE.textSecondary }}
          >
            Not this
          </button>
        </form>
        <TellJ4Button className="rounded-full px-3 py-2 text-xs font-medium underline underline-offset-2 transition-colors hover:bg-white/[.06]" />
      </div>

      {otherPendingCount > 0 && (
        <p className="mt-2 text-[11px]" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
          {otherPendingCount} other {otherPendingCount === 1 ? "idea is" : "ideas are"} waiting. Ask me about
          {otherPendingCount === 1 ? " it" : " them"} whenever you want.
        </p>
      )}
    </div>
  );
}
