import Link from "next/link";
import { isPaymentConnected } from "@/lib/dashboard/needsAttention";
import { deriveJourneyStage } from "@/lib/dashboard/journeyStage";

type ChecklistItem = { label: string; done: boolean; href?: string };

function ChecklistRow({ items }: { items: ChecklistItem[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
      {items.map((item) => {
        const mark = (
          <span
            className={`mr-1.5 ${item.done ? "text-emerald-500" : "text-zinc-400 dark:text-zinc-600"}`}
            aria-hidden="true"
          >
            {item.done ? "✓" : "○"}
          </span>
        );
        const label = <span className={item.done ? "text-zinc-500" : "text-black dark:text-zinc-50"}>{item.label}</span>;
        return item.href && !item.done ? (
          <Link key={item.label} href={item.href} className="flex items-center text-sm hover:underline">
            {mark}
            {label}
          </Link>
        ) : (
          <span key={item.label} className="flex items-center text-sm">
            {mark}
            {label}
          </span>
        );
      })}
    </div>
  );
}

// A merchant's real progress, not a software setup wizard — every signal
// here is business state Genesis already knows (is the store visible, does
// it have something to sell, can it take money, has it sold anything),
// never an invented metric. Deliberately state-based rather than
// order-count-tiered: order count alone doesn't represent business
// maturity, so "up and running" stays one durable state rather than a
// series of gamified tiers. A later pass can give Genesis real signals
// (revenue trend, repeat customers, best sellers, conversion) to observe
// genuine milestones from — not built here.
export function BusinessJourney({
  published,
  hasActiveProducts,
  stripeIntegration,
  paypalIntegration,
  allTimeOrderCount,
}: {
  published: boolean;
  hasActiveProducts: boolean;
  stripeIntegration: { status: string } | null;
  paypalIntegration: { status: string } | null;
  allTimeOrderCount: number;
}) {
  const stage = deriveJourneyStage({
    published,
    hasActiveProducts,
    stripeIntegration,
    paypalIntegration,
    allTimeOrderCount,
  });

  if (stage === "up-and-running") {
    return (
      <div className="mt-6 max-w-2xl">
        <p className="text-lg font-medium text-black dark:text-zinc-50">Your business is up and running.</p>
        <p className="mt-1 text-sm text-zinc-500">
          {allTimeOrderCount.toLocaleString()} orders so far.
        </p>
      </div>
    );
  }

  if (stage === "first-sale") {
    return (
      <p className="mt-6 max-w-2xl text-lg font-medium text-emerald-600 dark:text-emerald-400">
        You just made your first sale! 🎉
      </p>
    );
  }

  // Zero orders — still setting up. Same shared payment-connected
  // definition as getStateIssues (lib/dashboard/needsAttention.ts), so this
  // checklist and "Needs your attention" can never disagree about whether
  // payments are connected.
  const paymentConnected = isPaymentConnected({ stripeIntegration, paypalIntegration });
  const setupDoneCount = [published, hasActiveProducts, paymentConnected].filter(Boolean).length;

  const leadSentence =
    setupDoneCount === 3
      ? "You're all set — ready for your first sale!"
      : setupDoneCount === 2
        ? "Almost there — one more step before you're ready to sell."
        : setupDoneCount === 1
          ? "You're making progress — a couple more steps to go."
          : "Let's get your business ready for its first customer.";

  return (
    <div className="mt-6 max-w-2xl">
      <p className="text-lg font-medium text-black dark:text-zinc-50">{leadSentence}</p>
      <ChecklistRow
        items={[
          { label: "Storefront live", done: published, href: "/dashboard/website" },
          { label: "Products ready", done: hasActiveProducts, href: "/dashboard/products" },
          { label: "Payments connected", done: paymentConnected, href: "/dashboard/payments" },
          { label: "First sale", done: false },
        ]}
      />
    </div>
  );
}
