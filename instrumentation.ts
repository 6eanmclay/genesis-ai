import * as Sentry from "@sentry/nextjs";

// Next.js's own instrumentation hook — this is what actually loads
// sentry.server.config.ts / sentry.edge.config.ts for the runtime that's
// starting. Required by the current Sentry Next.js SDK setup (verified
// against Sentry's live docs, not assumed) — instrumentation-client.ts is
// loaded automatically by Next itself and needs no entry here.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");

    // ============ SAY WHAT IS MISSING, ONCE, AT STARTUP ==========
    //
    // Fifty-one environment variables were read through bare process.env at the
    // moment each was needed, so a missing one was found late and in the worst
    // place — inside a webhook, mid-payment. lib/observability/webhookConfig.ts
    // exists because exactly that happened to STRIPE_WEBHOOK_SECRET.
    //
    // Reported, never thrown. Almost nothing in the registry is needed to serve
    // a request, and a platform that refuses to start because nobody has
    // registered a TikTok app is worse than one that starts and says so.
    //
    // Node runtime only: the edge runtime has a different environment and
    // reporting a partial view of it would be worse than reporting none.
    const { logConfigReport } = await import("./lib/config/report");
    logConfigReport();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
