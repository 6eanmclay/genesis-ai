import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { formatMoney } from "@/lib/money";

const SPARKLINE_WIDTH = 56;
const SPARKLINE_HEIGHT = 20;

// Real daily revenue only (see getRevenueTrend, lib/dashboard/whatHappened.ts)
// — a plain SVG polyline, normalized to the trend's own max so it always
// fits the compact viewBox. A genuinely all-zero window renders as a flat
// baseline, honestly, rather than being hidden or faked.
function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * SPARKLINE_WIDTH;
      const y = SPARKLINE_HEIGHT - (v / max) * SPARKLINE_HEIGHT;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
      width={SPARKLINE_WIDTH}
      height={SPARKLINE_HEIGHT}
      className="shrink-0"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={GENESIS_ATMOSPHERE.violet}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Compact business-performance widget, upper-right of Live Intelligence
// (lg:+ only — see DashboardShell.tsx/LiveIntelligence.tsx) — supports the
// greeting, doesn't compete with it. Only real numbers already computed
// from the Order table (getOrderSummary/getRevenueTrend/getNewCustomerCount
// in lib/dashboard/whatHappened.ts + customers.ts) — no invented trend
// percentage, growth indicator, or comparison. `revenueInCents`/
// `revenueTrend` share REVENUE_VIEW gating (a trend is meaningless without
// the number it's trending); `orderCount`/`newCustomerCount` share
// ORDERS_VIEW gating — each checked independently here even though in
// practice today's role model means they arrive/depart in these two pairs.
// Storefront status intentionally isn't here — it's communicated elsewhere
// in the dashboard, and dropping it gives these real performance numbers
// room to breathe. Colors are inline `style` (not Tailwind lg:-prefixed
// arbitrary classes) since this only ever renders inside the already
// lg:+-gated Live Intelligence area — see the dynamic-bracket-
// interpolation bug documented in GenesisAssistant.tsx/DashboardShell.tsx
// for why that distinction matters.
export function BusinessPulse({
  currency,
  revenueInCents,
  orderCount,
  revenueTrend,
  newCustomerCount,
}: {
  /** The store's own — this headline is the owner's money, not a default. */
  currency: string;
  revenueInCents: number | null;
  orderCount: number | null;
  revenueTrend: number[] | null;
  newCustomerCount: number | null;
}) {
  return (
    <div
      className="flex shrink-0 flex-col gap-2 rounded-xl border px-3 py-2.5"
      style={{
        borderColor: GENESIS_ATMOSPHERE.border,
        backgroundColor: GENESIS_ATMOSPHERE.bgElevated,
        boxShadow: `0 0 28px -10px ${GENESIS_ATMOSPHERE.violetSoft}`,
      }}
    >
      {revenueInCents !== null && (
        <div>
          <div className="flex items-center gap-2">
            <p className="text-base font-semibold" style={{ color: GENESIS_ATMOSPHERE.text }}>
              {formatMoney(revenueInCents, currency)}
            </p>
            {revenueTrend && <Sparkline values={revenueTrend} />}
          </div>
          <p className="text-[10px]" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            Last 30 days
          </p>
        </div>
      )}

      {orderCount !== null && (
        <div
          className="flex items-center gap-4 border-t pt-2"
          style={{ borderColor: GENESIS_ATMOSPHERE.border }}
        >
          <div>
            <p className="text-sm font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
              {orderCount}
            </p>
            <p className="text-[10px]" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
              Order{orderCount === 1 ? "" : "s"}
            </p>
          </div>
          {newCustomerCount !== null && (
            <div>
              <p className="text-sm font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
                {newCustomerCount}
              </p>
              <p className="text-[10px]" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                New customer{newCustomerCount === 1 ? "" : "s"}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
