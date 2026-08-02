import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getOnboardingState } from "./actions";
import { IdeaScreen } from "./IdeaScreen";

// The Genesis Experience — Idea act, entry point. Gated by
// ONBOARDING_V2_ENABLED (see ONBOARDING_V2_IMPLEMENTATION.md section 8):
// a simple env var, not a database flag, since nothing here is per-store —
// it's whether this new guided flow exists yet at all. Flip it off and
// this route simply isn't reachable.
//
// Renders only the reference screen (GENESIS_EXPERIENCE.md's "The
// reference screen") — the rest of the guided flow's UI (brand
// positioning, product discovery, pricing, Partnership) isn't designed
// yet, so this page deliberately doesn't attempt to route further along
// the state machine than this one confirmed screen.
export default async function OnboardingPage() {
  if (process.env.ONBOARDING_V2_ENABLED !== "true") {
    redirect("/dashboard");
  }

  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  // Real side effect worth keeping even though the result isn't branched
  // on yet: ensures a StoreDraft exists for this user before the form
  // renders, so the first real submit has something to persist against.
  await getOnboardingState();

  return <IdeaScreen />;
}
