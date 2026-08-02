import * as Sentry from "@sentry/nextjs";

// Client-side error/performance capture. Reads NEXT_PUBLIC_SENTRY_DSN,
// which doesn't exist yet — the Vercel-Sentry marketplace integration
// injects it automatically once linked to a real Sentry project (see
// DEPLOYMENT.md's Track 0 checklist for the exact remaining step). Until
// then Sentry.init with an empty dsn is a documented no-op: nothing sends,
// nothing breaks, no placeholder/fake DSN needed.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Low by default — this is an early-stage product with no real traffic
  // volume yet where sampling matters; revisit once there's a reason to
  // control cost/volume rather than guessing at a number now.
  tracesSampleRate: 1.0,
  // Session Replay is a real cost/PII surface (this app renders private
  // dashboard revenue/customer data) and wasn't asked for — off, not
  // defaulted on.
  debug: false,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
