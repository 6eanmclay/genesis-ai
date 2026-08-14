import { approveGenesisAction, rejectGenesisAction } from "@/app/dashboard/ai-actions";
import { ProposalComparison } from "@/app/dashboard/ProposalComparison";
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
// WHAT IT DELIBERATELY DOES NOT HAVE: a "discuss" or "refine" button. The
// rebuttal is the composer directly underneath it. The owner types "I don't
// like that, keep the handmade feel" the same way they said anything else,
// and J4 revises the same proposal. Putting a button on it would turn a
// conversation back into a form.

export function J4Proposal({
  proposal,
  storefrontUrl,
  storeName,
}: {
  proposal: Proposal;
  storefrontUrl: string;
  storeName: string;
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

  const separator = storefrontUrl.includes("?") ? "&" : "?";
  const proposedUrl = `${storefrontUrl}${separator}previewProposal=${encodeURIComponent(proposal.proposalId)}`;

  // Everything before the newest revision. Shown because "here's what I
  // proposed, here's what you said, here's what I changed" is the product,
  // and an owner who says "go back to your first idea" needs it to still
  // exist on screen.
  const earlier = proposal.revisions.slice(0, -1);

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

      <ProposalComparison
        currentUrl={storefrontUrl}
        proposedUrl={proposedUrl}
        scope={scope}
        storeName={storeName}
      />

      {earlier.length > 0 && (
        <details className="mt-2">
          <summary
            className="cursor-pointer text-[11px] font-medium"
            style={{ color: GENESIS_ATMOSPHERE.textSecondary }}
          >
            How we got here ({earlier.length} earlier {earlier.length === 1 ? "version" : "versions"})
          </summary>
          <ol className="mt-1.5 space-y-1.5">
            {earlier.map((r) => (
              <li key={r.id} className="text-[12px] leading-snug" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                <span className="font-medium">v{r.revision}</span> {r.summary}
              </li>
            ))}
          </ol>
        </details>
      )}

      {/* Approve and reject only. The third option, "argue with it", is the
          composer below this — see the component comment. */}
      <div className="mt-3 flex items-center gap-2">
        {/* Plain forms bound to the real Server Actions, the same shape
            VisualProposal already uses for these exact two actions. */}
        <form action={approveGenesisAction.bind(null, current.id)}>
          <button
            type="submit"
            className="rounded-full bg-[#2563eb] px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            Apply this
          </button>
        </form>
        <form action={rejectGenesisAction.bind(null, current.id)}>
          <button
            type="submit"
            className="rounded-full px-4 py-2 text-xs font-medium transition-colors hover:bg-white/[.06]"
            style={{ color: GENESIS_ATMOSPHERE.textSecondary }}
          >
            Not this
          </button>
        </form>
        <p className="ml-1 text-[11px]" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
          or tell J4 what to change
        </p>
      </div>
    </div>
  );
}
