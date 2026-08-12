import J4Page from "@/app/j4/page";
import { J4SummonSheet } from "./J4SummonSheet";

// Same real ceiling as the route this intercepts (app/j4/page.tsx) — this is
// its own route segment, so it needs its own config; inheriting is not a
// thing. sendStoreMessage calls real AI from inside here exactly as it does
// on the full page.
export const maxDuration = 300;

// The intercepted /j4 route (2026-08-12). Navigating to /j4 from anywhere
// inside the dashboard lands here instead of on the full page, and J4 opens
// as a sheet over whatever the owner was already looking at.
//
// The one thing that matters architecturally: this renders the REAL J4Page
// server component, not a copy of it. Same auth, same store resolution, same
// server actions (sendStoreMessage, uploadBusinessAssetFromChat,
// uploadPhotoBatchFromChat, uploadVoiceMemo), same J4Workspace, same
// Request → Execute → Verify → Record → Display path. There is no second J4
// chat state to keep in sync with the first, because there is no second J4.
//
// A hard load of /j4 — a shared link, a refresh, or arriving from outside the
// dashboard — never reaches this file and renders the full page as before.
// That's the correct behavior: /j4 is a real URL, not a modal that pretends
// to be one.
export default function InterceptedJ4Page() {
  return (
    <J4SummonSheet>
      <J4Page />
    </J4SummonSheet>
  );
}
