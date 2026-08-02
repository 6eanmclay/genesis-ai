import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { resolveUserStore } from "@/lib/permissions";
import { getBaseUrl } from "@/lib/integrations/util";
import { LaunchScreen, type LaunchData } from "./LaunchScreen";
import type { OnboardingState } from "@/lib/onboarding/types";

// The Genesis Experience — Partnership/Launch act (Implementation roadmap
// Milestone 2). Unlike BusinessScreen's own client-side beat state (driven
// off a single `initialStep` at mount), this page re-derives which beat to
// show from real, current database state on every load — not a client-only
// assumption of a fixed forward path. That's what makes "Not yet" (the
// commitment beat's decline) genuinely safe: the store stays built but
// unpublished, and returning to this exact URL later — including after
// Stripe's OAuth round-trip lands the browser on /dashboard/payments
// instead of back here — always shows the correct next beat, never a stale
// or wrong one.
export default async function LaunchPage() {
  if (process.env.ONBOARDING_V2_ENABLED !== "true") {
    redirect("/dashboard");
  }

  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  const userId = session.user.id;

  const resolved = await resolveUserStore(userId);

  if (!resolved) {
    // No real Store yet — this screen has nothing honest to show unless
    // the guided discovery flow actually reached the end (a selected,
    // priced product). Anything earlier belongs back in the Business act.
    const draft = await prisma.storeDraft.findUnique({ where: { userId } });
    const state = (draft?.onboardingState as OnboardingState | null) ?? null;
    if (!draft || state?.step !== "ready_to_publish" || !state.selectedCandidate || !state.pricing) {
      redirect("/onboarding/business");
    }

    const data: LaunchData = {
      phase: "commitment",
      storeName: draft.name,
      recap: {
        costInCents: state.pricing.retailPriceInCents - state.pricing.profitInCents,
        priceInCents: state.pricing.retailPriceInCents,
        profitInCents: state.pricing.profitInCents,
      },
    };
    return <LaunchScreen data={data} />;
  }

  const { store } = resolved;

  if (store.published) {
    const baseUrl = await getBaseUrl();
    const storeUrl = `${baseUrl}/store/${store.slug}`;
    return <LaunchScreen data={{ phase: "live", storeName: store.name, storeUrl }} />;
  }

  const [stripeIntegration, paypalIntegration] = await Promise.all([
    prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId: store.id, provider: "STRIPE" } },
      select: { status: true },
    }),
    prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId: store.id, provider: "PAYPAL" } },
      select: { status: true },
    }),
  ]);
  const paymentConnected =
    stripeIntegration?.status === "CONNECTED" || paypalIntegration?.status === "CONNECTED";

  const data: LaunchData = paymentConnected
    ? { phase: "ready", storeName: store.name }
    : { phase: "payment", storeName: store.name };

  return <LaunchScreen data={data} />;
}
