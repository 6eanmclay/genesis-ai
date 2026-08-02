import * as Sentry from "@sentry/nextjs";

// Edge runtime (middleware, edge routes) error capture. This app has no
// middleware.ts today, but Next.js still loads this config whenever the
// edge runtime is available, and NextAuth's edge-compatible pieces run
// here — cheap to have in place now rather than a gap discovered later.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0,
  debug: false,
});
