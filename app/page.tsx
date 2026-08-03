import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getExperienceState } from "@/app/onboarding/actions";
import { ExperienceScreen } from "./ExperienceScreen";

// Experience-First Onboarding (EXPERIENCE_FIRST_ONBOARDING.md) — the first
// thing any first-time visitor (or beta invite link) lands on. No signup
// wall: a brand-new visitor enters straight into the real experience flow
// (ExperienceScreen), the same first thing on any future surface (see that
// document's platform principle). A logged-in visitor is sent straight to
// their dashboard rather than being shown this again — new vs. returning is
// the only fork here.
export default async function Home() {
  const session = await auth();
  if (session?.user) {
    redirect("/dashboard");
  }

  const state = await getExperienceState();
  return <ExperienceScreen initialState={state} />;
}
