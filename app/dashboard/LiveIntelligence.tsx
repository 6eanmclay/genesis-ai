import Link from "next/link";
import { GenesisGreeting } from "./GenesisGreeting";
import { BusinessPulse } from "./BusinessPulse";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import {
  buildBriefing,
  type FocusableApprovalBrief,
  type LiveObservationBrief,
  type CuriosityBrief,
} from "@/lib/dashboard/genesisBriefing";

type FocusableApproval = FocusableApprovalBrief;
type LiveObservation = LiveObservationBrief;

// Center-top, lg:+ only (see DashboardShell.tsx) — a thin intelligence
// wire/ticker directly above the framed Business workspace, not a
// dashboard card: this is Genesis communicating, never larger or more
// identity-dominant than the Domicile itself. The decision/opportunity
// list (focusableApprovals/liveObservations, both computed in
// layout.tsx — the exact same real data the amber nav badges and the
// contextual notification layer already use) stays a calm one-line
// summary here; the actual proposal/observation detail is deliberately
// not echoed into this surface — it already lives on its real review page,
// reached via the same already-verified "?focus=" chain this line's link
// uses. BusinessPulse (upper-right) is a separate, real business-
// performance signal (revenue/orders/storefront status) — not another
// representation of what needs deciding.
export function LiveIntelligence({
  focusableApprovals,
  liveObservations,
  curiosityItems,
  userName,
  revenueInCents,
  orderCount,
  revenueTrend,
  newCustomerCount,
  justArrived = false,
}: {
  focusableApprovals: FocusableApproval[];
  liveObservations: LiveObservation[];
  curiosityItems: CuriosityBrief[];
  userName: string | null;
  revenueInCents: number | null;
  orderCount: number | null;
  revenueTrend: number[] | null;
  newCustomerCount: number | null;
  // Arrival Experience — true for a brief real window right after the
  // returning-user ritual's overlay clears (DashboardShell.tsx). Reframes
  // this same real line as "While you were away" rather than its
  // permanent, ambient framing — the briefing is only ever spoken once the
  // owner is genuinely inside, per Sean's explicit sequencing correction.
  justArrived?: boolean;
}) {
  const briefing = buildBriefing({ focusableApprovals, liveObservations, curiosityItems });

  // Real counts only — no fabricated categories (no abandoned-checkout or
  // payout tracking exists yet). Silently omits whichever of these isn't
  // real/nonzero rather than padding the sentence with a zero.
  const awayFacts: string[] = [];
  if (justArrived) {
    if (newCustomerCount) awayFacts.push(`${newCustomerCount} new customer${newCustomerCount === 1 ? "" : "s"}`);
    if (orderCount) awayFacts.push(`${orderCount} order${orderCount === 1 ? "" : "s"}`);
  }
  const awayPrefix = justArrived
    ? awayFacts.length > 0
      ? `While you were away: ${awayFacts.join(", ")}. `
      : "While you were away — "
    : "";

  return (
    <div className="border-b py-4" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p
            className="text-[10px] font-medium uppercase tracking-wide"
            style={{ color: GENESIS_ATMOSPHERE.textSecondary }}
          >
            Genesis Live Intelligence
          </p>
          <div className="mt-1">
            <GenesisGreeting name={userName} />
          </div>

          {briefing ? (
            <p className="mt-2 text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
              {awayPrefix}
              {briefing.lead}
              {briefing.ctaHref ? (
                <>
                  {" — "}
                  <Link
                    href={briefing.ctaHref}
                    className="underline decoration-current/30 hover:decoration-current"
                    style={{ color: GENESIS_ATMOSPHERE.text }}
                  >
                    {briefing.ctaLabel}
                  </Link>
                </>
              ) : (
                "."
              )}
            </p>
          ) : (
            <p className="mt-2 text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
              {justArrived ? "While you were away, everything ran smoothly." : "Everything's running smoothly today."}
            </p>
          )}
        </div>

        <BusinessPulse
          revenueInCents={revenueInCents}
          orderCount={orderCount}
          revenueTrend={revenueTrend}
          newCustomerCount={newCustomerCount}
        />
      </div>
    </div>
  );
}
