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
}: {
  focusableApprovals: FocusableApproval[];
  liveObservations: LiveObservation[];
  curiosityItems: CuriosityBrief[];
  userName: string | null;
  revenueInCents: number | null;
  orderCount: number | null;
  revenueTrend: number[] | null;
  newCustomerCount: number | null;
}) {
  const briefing = buildBriefing({ focusableApprovals, liveObservations, curiosityItems });

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
              Everything&apos;s running smoothly today.
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
