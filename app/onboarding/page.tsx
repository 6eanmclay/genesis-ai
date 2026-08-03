import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getOnboardingState } from "./actions";
import { IdeaScreen } from "./IdeaScreen";

// The Genesis Experience — Idea act, entry point. Gated by
// ONBOARDING_V2_ENABLED (see ONBOARDING_V2_IMPLEMENTATION.md section 8):
// a simple env var, not a database flag, since nothing here is per-store —
// it's whether this new guided flow exists yet at all. Flip it off and
// this route simply isn't reachable.
export default async function OnboardingPage() {
  if (process.env.ONBOARDING_V2_ENABLED !== "true") {
    redirect("/dashboard");
  }

  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  // Launch-readiness fix — a real bug found via a live audit: this page
  // used to always render the Idea act, even for a returning user who had
  // already answered it and progressed into the Business act. Business
  // act's own page (app/onboarding/business/page.tsx) already resumes at
  // the right beat from real persisted state — this page just needs to
  // hand off to it once the Idea act is genuinely done, the same way
  // app/dashboard/page.tsx now hands off here in the first place.
  const { state } = await getOnboardingState();
  if (state.step !== "business_model") {
    redirect("/onboarding/business");
  }

  return <IdeaScreen />;
}
