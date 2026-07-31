import Link from "next/link";
import { GenesisGreeting } from "./GenesisGreeting";
import { BusinessPulse } from "./BusinessPulse";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";

interface FocusableApproval {
  id: string;
  section: string;
  href: string;
  summary: string;
  noticedSummary: string | null;
}

interface LiveObservation {
  dedupeKey: string;
  genesisState: string;
  summary: string;
  actionHref: string | null;
}

type MergedItem =
  | { kind: "approval"; key: string; summary: string; href: string }
  | { kind: "observation"; key: string; summary: string; href: string | null; genesisState: string };

// Real priority, not list order — an urgent observation outranks a pending
// decision, which outranks an opportunity. GenesisObservation rows are only
// ever "urgent" or "opportunity" (see lib/dashboard/genesisState.ts), so
// these three buckets are exhaustive.
function priorityRank(item: MergedItem): number {
  if (item.kind === "observation" && item.genesisState === "urgent") return 0;
  if (item.kind === "approval") return 1;
  return 2;
}

// A short, count-based briefing line rather than echoing the real
// proposal/observation text into this ambient surface — the full detail
// already lives on its real, appropriate review page (Website/Brand/
// Products, via the existing "?focus=" chain the link below points at).
// Returns null when there's nothing pending, letting the caller render the
// calm idle line instead.
function leadCopy(topItem: MergedItem, count: number): { lead: string; cta: string } {
  const plural = count > 1;
  const cta = plural ? "start here" : "review it";
  if (topItem.kind === "approval") {
    return { lead: `Genesis needs your decision on ${plural ? `${count} things` : "one thing"} today`, cta };
  }
  if (topItem.genesisState === "urgent") {
    return { lead: `Genesis needs your attention on ${plural ? `${count} things` : "one thing"} today`, cta };
  }
  return {
    lead: `Genesis found ${plural ? `${count} things` : "something"} worth considering today`,
    cta: plural ? "start here" : "take a look",
  };
}

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
  userName,
  revenueInCents,
  orderCount,
  revenueTrend,
  newCustomerCount,
}: {
  focusableApprovals: FocusableApproval[];
  liveObservations: LiveObservation[];
  userName: string | null;
  revenueInCents: number | null;
  orderCount: number | null;
  revenueTrend: number[] | null;
  newCustomerCount: number | null;
}) {
  const merged: MergedItem[] = [
    ...focusableApprovals.map(
      (a): MergedItem => ({ kind: "approval", key: a.id, summary: a.summary, href: `${a.href}?focus=${a.id}` })
    ),
    ...liveObservations.map(
      (o): MergedItem => ({
        kind: "observation",
        key: o.dedupeKey,
        summary: o.summary,
        href: o.actionHref,
        genesisState: o.genesisState,
      })
    ),
  ].sort((a, b) => priorityRank(a) - priorityRank(b));

  const [topItem] = merged;
  const copy = topItem ? leadCopy(topItem, merged.length) : null;

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

          {copy ? (
            <p className="mt-2 text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
              {copy.lead}
              {topItem.href ? (
                <>
                  {" — "}
                  <Link
                    href={topItem.href}
                    className="underline decoration-current/30 hover:decoration-current"
                    style={{ color: GENESIS_ATMOSPHERE.text }}
                  >
                    {copy.cta}
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
