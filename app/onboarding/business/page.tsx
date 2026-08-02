import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getOnboardingState } from "../actions";
import { BusinessScreen } from "./BusinessScreen";

// The Genesis Experience — Business act. Same gating as /onboarding (the
// Idea act): ONBOARDING_V2_ENABLED, a real session. Additionally requires
// the Idea act to have actually been completed — this route has nothing
// honest to show someone who hasn't answered "what's the business you've
// been meaning to start" yet.
export default async function BusinessPage() {
  if (process.env.ONBOARDING_V2_ENABLED !== "true") {
    redirect("/dashboard");
  }

  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const { state } = await getOnboardingState();
  if (state.step === "business_model" || state.step === "not_ecommerce") {
    redirect("/onboarding");
  }

  return <BusinessScreen initialStep={state.step} />;
}
