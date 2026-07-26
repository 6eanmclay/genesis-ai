import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, requireStorePageAccess } from "@/lib/permissions";
import { getOrderSummary, getRecentActivity } from "@/lib/dashboard/whatHappened";
import { getAttentionItems } from "@/lib/dashboard/needsAttention";
import { getRecommendations } from "@/lib/dashboard/recommendations";
import { getCustomerSummaries } from "@/lib/dashboard/customers";
import { getInventorySnapshot } from "@/lib/dashboard/inventory";
import { explainRecommendation, reviewBusinessWithGenesis } from "../ai-actions";
import { RecommendationsPanel } from "../RecommendationsPanel";
import { SubmitButton } from "../SubmitButton";
import type { BlueprintContextSubset } from "@/lib/execution/genesisActions";

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// The dedicated, deeper view of the same recommendation engine Home shows a
// promoted slice of — same underlying data and producers, just the page
// worth bookmarking for a full review rather than a dashboard glance.
export default async function AnalyticsPage() {
  const { store, role } = await requireStorePageAccess(PERMISSIONS.ANALYTICS_VIEW);
  const canViewRevenue = hasPermission(role, PERMISSIONS.REVENUE_VIEW);

  const [products, stripeIntegration, paypalIntegration] = await Promise.all([
    prisma.product.findMany({
      where: { storeId: store.id },
      select: { name: true, description: true, priceInCents: true, active: true },
    }),
    prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId: store.id, provider: "STRIPE" } },
      select: { status: true },
    }),
    prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId: store.id, provider: "PAYPAL" } },
      select: { status: true },
    }),
  ]);

  const [orderSummary, customerSummaries, activityItems, attention, latestGenesisRecommendation] =
    await Promise.all([
      getOrderSummary(store.id, { includeRevenue: canViewRevenue }),
      getCustomerSummaries(store.id, { includeRevenue: canViewRevenue }),
      getRecentActivity(store.id),
      getAttentionItems(store.id, {
        store: { published: store.published },
        products: products.map((p) => ({ active: p.active })),
        stripeIntegration,
        paypalIntegration,
      }),
      prisma.generatedRecommendation.findFirst({
        where: { storeId: store.id },
        orderBy: { generatedAt: "desc" },
        select: { generatedAt: true },
      }),
    ]);

  const inventorySnapshot = getInventorySnapshot(products);
  const blueprint = store.blueprint as BlueprintContextSubset | null;

  const recommendations = await getRecommendations({
    storeId: store.id,
    storeName: store.name,
    store: { published: store.published },
    products,
    stripeIntegration,
    attentionItems: [...attention.recentOutcomes, ...attention.currentState],
    orderSummary,
    customerSummaries,
    inventorySnapshot,
    recentActivity: activityItems,
    blueprint: blueprint?.brandIdentity
      ? {
          brandPersonality: blueprint.brandIdentity.brandPersonality ?? "",
          brandVoiceAndTone: blueprint.brandIdentity.brandVoiceAndTone ?? "",
          targetAudience: blueprint.brandIdentity.targetAudience ?? "",
          uniqueSellingProposition: blueprint.brandIdentity.uniqueSellingProposition ?? "",
          heroHeadline: blueprint.homepageContent?.heroHeadline ?? "",
          aboutUs: blueprint.homepageContent?.aboutUs ?? "",
        }
      : null,
  });

  return (
    <div className="min-h-screen p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Analytics</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">
            {latestGenesisRecommendation
              ? `Generated ${formatTimeAgo(latestGenesisRecommendation.generatedAt)}`
              : "Genesis hasn't reviewed this business yet"}
          </span>
          <form action={reviewBusinessWithGenesis}>
            <SubmitButton
              pendingText="Reviewing..."
              className="rounded-full bg-[var(--brand-accent,var(--foreground))] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              ✨ Ask Genesis to Review My Business
            </SubmitButton>
          </form>
        </div>
      </div>
      <RecommendationsPanel recommendations={recommendations} explainAction={explainRecommendation} />
    </div>
  );
}
