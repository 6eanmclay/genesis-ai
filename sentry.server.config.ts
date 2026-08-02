import * as Sentry from "@sentry/nextjs";

// Server-side (Node runtime) error/performance capture — the Server
// Actions this app is almost entirely built from (see ARCHITECTURE.md's
// "Where logic lives") run here, not on the client, so this is the config
// that matters most for catching real production failures. Empty dsn
// (until the Vercel-Sentry integration is linked — see instrumentation-
// client.ts's comment) is a documented no-op.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0,
  debug: false,
});
