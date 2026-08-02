import * as Sentry from "@sentry/nextjs";

// Next.js's own instrumentation hook — this is what actually loads
// sentry.server.config.ts / sentry.edge.config.ts for the runtime that's
// starting. Required by the current Sentry Next.js SDK setup (verified
// against Sentry's live docs, not assumed) — instrumentation-client.ts is
// loaded automatically by Next itself and needs no entry here.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
