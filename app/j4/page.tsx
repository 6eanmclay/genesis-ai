import { J4Surface } from "./J4Surface";

// Reliability hardening — same real evidence as app/dashboard/layout.tsx
// and app/onboarding/meeting/page.tsx: Vercel's real function ceiling is
// 300s (Fluid Compute), not the old assumed 10s. sendStoreMessage calls
// real AI, same durations class as the rest of this app's chat surfaces.
export const maxDuration = 300;

// The full J4 room — a deliberate destination, and only that (2026-08-14).
//
// Sean's clarification, which changed what this route is for: "the full J4
// page is a deliberate deep work and review destination. Users go there when
// they want to read the conversation, review Tasks, Ideas, Decisions,
// Information, get a written breakdown, or enter a focused creative
// workspace. It is not required for ordinary conversation with J4."
//
// Ordinary conversation now happens in the persistent layer over whatever
// the owner is working on (app/dashboard/J4Overlay.tsx). The owner should
// never feel they have to leave their business just to talk to J4 — so this
// route stopped being the way to talk to J4 and became the place you go on
// purpose, for the record and the queue.
//
// Everything real about it is unchanged: same component, same conversation,
// same actions. It is now reached deliberately (the layer's "Everything"
// control, a shared link, a bookmark) rather than by every question, and
// leaving it steps back into the workspace the owner came from rather than
// dropping them at the top of /dashboard. See J4Workspace's leaveRoom.
export default function J4Page() {
  return <J4Surface surface="room" />;
}
