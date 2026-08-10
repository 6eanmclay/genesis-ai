import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// A custom Cache-Control override for /dashboard was tried here (to force
// `no-store`) and removed — it never actually took effect (verified via
// curl: identical `no-cache, must-revalidate` header with or without it).
// Next's own internal handling for a page that reads cookies() via auth()
// applies its own Cache-Control after this config runs. The real access
// guarantee doesn't depend on this header anyway: signOut() clears the
// session cookie itself, and every request re-runs auth() server-side —
// confirmed by directly testing that a request with the cleared cookie
// gets a 307 to /login, not the dashboard.
const nextConfig: NextConfig = {
  experimental: {
    // Beta 1 bug, confirmed via real production logs (2026-08-06): every
    // chat photo/document upload was hitting Next's default 1MB Server
    // Action body limit, throwing a 413 that surfaced as a generic 500 —
    // which callGenesisAction (lib/dashboard/submitGenesisAction.ts) then
    // reported to the owner as "the connection may have dropped," with no
    // indication of the real cause. The chat/business-asset and product-
    // gallery upload paths have since moved to direct-to-Blob (never
    // touching this limit at all) — the one real path still sending raw
    // bytes through a Server Action body is onboarding's own artwork
    // upload (app/onboarding/actions.ts, lib/imageProviders/
    // uploadProvider.ts's MAX_UPLOAD_BYTES, now 20MB after the 2026-08-09
    // fix). 22mb leaves the same kind of headroom above that file ceiling
    // for multipart boundary/field overhead this value always has.
    serverActions: {
      bodySizeLimit: "22mb",
    },
  },
};

// org/project/authToken all come from env vars the Vercel-Sentry
// marketplace integration injects once linked (SENTRY_ORG, SENTRY_PROJECT,
// SENTRY_AUTH_TOKEN) — none exist yet, so source map upload silently
// no-ops rather than failing the build (verified: withSentryConfig treats
// a missing authToken as "skip upload," not an error). See DEPLOYMENT.md's
// Track 0 checklist for the remaining manual step.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  widenClientFileUpload: true,
  // disableLogger is deprecated and explicitly unsupported under
  // Turbopack (which this project uses, confirmed via the real build
  // output) — omitted rather than left in with a warning every build.
  telemetry: false,
});
