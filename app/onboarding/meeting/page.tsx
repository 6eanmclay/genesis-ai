import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { resolveUserStore } from "@/lib/permissions";
import { generateMeetingReflection } from "./reflection";
import { MeetingScreen } from "./MeetingScreen";

// Reliability hardening — see app/dashboard/layout.tsx's own comment on
// why this lives at the page level (Next's own maxDuration route segment
// config, Server-Action-scoped) and why 90s is genuinely inert on Hobby.
// submitMeetingTurn/approveMeetingRecommendation/declineMeetingRecommendation
// all call real AI, same durations class as the dashboard's own calls.
export const maxDuration = 90;

// The First Meeting with J4 (MEETING_WITH_J4.md, frozen v1) — the missing
// act between Partnership (LaunchScreen's "live" beat, which now routes
// here instead of straight to /dashboard) and Growth. Full-screen,
// dedicated, one owner, one device — not the floating GenesisAssistant
// widget, per the frozen design's placement decision.
export default async function MeetingPage() {
  if (process.env.ONBOARDING_V2_ENABLED !== "true") {
    redirect("/dashboard");
  }

  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const resolved = await resolveUserStore(session.user.id);
  if (!resolved) {
    // No real store yet — nothing to hold a meeting about.
    redirect("/onboarding/business");
  }
  const { store } = resolved;

  if (!store.published) {
    // Hasn't actually launched yet — back to the real launch ceremony.
    redirect("/onboarding/launch");
  }

  if (store.firstMeetingCompletedAt) {
    // Already met — never re-triggered, straight to the real dashboard.
    redirect("/dashboard");
  }

  const reflection = await generateMeetingReflection(store.id);

  return <MeetingScreen reflection={reflection} />;
}
