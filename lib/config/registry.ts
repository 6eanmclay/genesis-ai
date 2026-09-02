// EVERY PIECE OF CONFIGURATION THIS PLATFORM READS, AND WHAT ITS ABSENCE COSTS.
//
// ============ WHAT WAS HAPPENING BEFORE (2026-08-30) ===================
//
// Fifty-one distinct environment variables, every one read through a bare
// `process.env.X` at the moment it was needed. So a missing one was discovered
// late, partially, and in the worst possible place: inside a webhook, mid-
// payment, in production.
//
// That is not hypothetical. lib/observability/webhookConfig.ts exists because
// STRIPE_WEBHOOK_SECRET went missing once and the endpoint compared a signature
// against the literal string "Bearer undefined" — a check that could never
// fail, in front of the money path.
//
// ============ WHY A REGISTRY AND NOT A SCHEMA =========================
//
// A Zod schema would answer "is this valid" and nothing else. The question that
// actually matters here is "what stops working without it", and almost nothing
// in this list is required for the platform to run — most of it disables one
// feature and leaves the rest working, deliberately, because a store with no
// TikTok credentials should still take payments.
//
// So each entry carries the CONSEQUENCE, in the words somebody reading a
// startup report needs. "Missing" is not an error; "missing, and that is why
// nobody can connect Mailchimp" is an answer.
//
// ============ AND WHY IT CANNOT DRIFT =================================
//
// scripts/verify-config-db.ts sweeps the source for every `process.env` read
// and asserts each one is declared here. A registry maintained by hand goes
// stale the first time somebody adds a variable in a hurry — this codebase's
// own mirrored-registry rule, applied to the thing that decides what a
// deployment is missing.

export type Requirement =
  /** The platform cannot serve a request without it. */
  | "essential"
  /** Production needs it; a local machine or a test harness does not. */
  | "production"
  /** One feature depends on it. Everything else works without it. */
  | "feature"
  /** A switch with a safe default. */
  | "optional";

export interface ConfigEntry {
  name: string;
  /** What it is for, in one line. */
  purpose: string;
  requirement: Requirement;
  /**
   * What stops working without it.
   *
   * The most important field. A report that lists missing names tells somebody
   * what to look up; one that names the consequence tells them whether to care.
   */
  absence: string;
  /** Never printed, never logged, never returned by a read. */
  secret: boolean;
  /**
   * Read by a library, not by this codebase.
   *
   * ============ WHY THIS FLAG EXISTS (2026-08-30) ================
   *
   * Three variables never appear anywhere in this repository: their SDKs read
   * the environment themselves. They are as required as anything here — without
   * ANTHROPIC_API_KEY J4 cannot think at all — and the sweep that keeps this
   * registry honest works by grepping for `process.env`, so without a flag it
   * would have reported them as describing something nothing reads and somebody
   * would eventually have deleted them.
   *
   * A registry describes the DEPLOYMENT, not the grep.
   */
  readBySdk?: boolean;
  /** For grouping a report somebody has to read. */
  group: "core" | "payments" | "ai" | "email" | "storage" | "shipping" | "connections" | "ops";
}

export const CONFIG: ConfigEntry[] = [
  // ---- core --------------------------------------------------------------
  { name: "DATABASE_URL", group: "core", requirement: "essential", secret: true,
    purpose: "The database every request reads and writes.",
    absence: "Nothing works at all." },
  { name: "DATABASE_URL_UNPOOLED", group: "core", requirement: "production", secret: true,
    purpose: "A direct connection for migrations, which must not go through the pooler.",
    absence: "Migrations run on the pooled connection and can strand an advisory lock, blocking every later deploy." },
  { name: "AUTH_SECRET", group: "core", requirement: "essential", secret: true,
    purpose: "Signs session tokens.",
    absence: "Nobody can sign in, and any existing session is unreadable." },
  { name: "NEXTAUTH_URL", group: "core", requirement: "optional", secret: false,
    purpose: "The canonical origin for auth callbacks.",
    absence: "Inferred from the request. Fine on Vercel; wrong behind an unusual proxy." },
  { name: "VERCEL_PROJECT_PRODUCTION_URL", group: "core", requirement: "optional", secret: false,
    purpose: "The public origin used to build absolute links.",
    absence: "Links fall back to the request's own origin." },

  // ---- payments ----------------------------------------------------------
  { name: "STRIPE_SECRET_KEY", group: "payments", requirement: "production", secret: true,
    purpose: "Calls Stripe — checkout sessions, line items, refunds.",
    absence: "No card payment can be taken or refunded." },
  { name: "STRIPE_WEBHOOK_SECRET", group: "payments", requirement: "production", secret: true,
    purpose: "Verifies that a webhook really came from Stripe.",
    absence: "Every incoming payment event is refused. Money arrives and no order is written." },
  { name: "STRIPE_PLATFORM_WEBHOOK_SECRET", group: "payments", requirement: "production", secret: true,
    purpose: "The same, for the platform-level account.",
    absence: "Platform events — subscriptions, Growth Point purchases — are refused." },
  { name: "STRIPE_CONNECT_CLIENT_ID", group: "payments", requirement: "feature", secret: false,
    purpose: "Lets a store connect its own Stripe account.",
    absence: "No store can connect Stripe." },

  // ---- ai ----------------------------------------------------------------
  { readBySdk: true, name: "ANTHROPIC_API_KEY", group: "ai", requirement: "production", secret: true,
    purpose: "Every model call J4 makes.",
    absence: "J4 cannot think. Chat, onboarding, insights and proposals all fail." },
  { name: "OPENAI_API_KEY", group: "ai", requirement: "feature", secret: true,
    purpose: "Image generation.",
    absence: "Generated product imagery is unavailable; uploads still work." },
  { name: "UNSPLASH_ACCESS_KEY", group: "ai", requirement: "feature", secret: true,
    purpose: "Stock imagery during onboarding.",
    absence: "Stock photographs are unavailable." },
  { name: "ELEVENLABS_API_KEY", group: "ai", requirement: "feature", secret: true,
    purpose: "Speech synthesis for J4's voice.",
    absence: "Voice output is unavailable. Everything J4 writes still works." },
  { name: "ELEVENLABS_VOICE_ID", group: "ai", requirement: "feature", secret: false,
    purpose: "Which voice J4 speaks in.",
    absence: "Voice output falls back to a default voice." },

  // ---- email -------------------------------------------------------------
  { name: "RESEND_API_KEY", group: "email", requirement: "production", secret: true,
    purpose: "Sends every email this platform sends.",
    absence: "No customer is ever told anything: no order confirmation, no shipping notice, no refund notice, no password reset, no security alert." },
  { name: "EMAIL_FROM_ADDRESS", group: "email", requirement: "production", secret: false,
    purpose: "The address those emails come from.",
    absence: "Sending is disabled even with an API key." },
  { name: "EMAIL_NOTIFICATIONS_START_AT", group: "email", requirement: "optional", secret: false,
    purpose:
      "The instant from which the order-notification backstop may notice an unnotified " +
      "order. An ISO timestamp. Set it to the moment email goes live, so the sweep " +
      "catches what the inline send missed minutes ago and never replays history.",
    absence:
      "The backstop sends nothing retroactively — deliberately fail-closed, and " +
      "deliberately a second switch, so turning email on cannot by itself replay every " +
      "order this platform has ever taken. Inline confirmations at purchase time are " +
      "unaffected and still send." },

  // ---- storage -----------------------------------------------------------
  { readBySdk: true, name: "BLOB_READ_WRITE_TOKEN", group: "storage", requirement: "production", secret: true,
    purpose: "Uploads and reads files in blob storage.",
    absence: "No image or asset can be uploaded." },
  { name: "STORAGE_ENFORCEMENT", group: "storage", requirement: "optional", secret: false,
    purpose: "Whether storage limits are enforced.",
    absence: "Off. Usage is recorded and nothing is refused — the current deliberate state." },
  { name: "STORAGE_RECONCILE", group: "storage", requirement: "optional", secret: false,
    purpose:
      "Whether nightly storage reconciliation runs, and whether it may write. " +
      "Three values, deliberately: unset is off, \"on\" runs it read-only so its " +
      "findings can be read before they are trusted, and \"apply\" lets it correct.",
    absence: "Off, deliberately, until the ledger write paths are deployed." },
  { name: "STORAGE_ATTRIBUTION_SWEEP", group: "storage", requirement: "optional", secret: false,
    purpose: "Whether the weekly attribution sweep runs.",
    absence: "Off, deliberately." },

  // ---- ops ---------------------------------------------------------------
  { name: "SOURCING_DISCOVERY_ENABLED", group: "ops", requirement: "optional", secret: false,
    purpose:
      "Whether the scheduler may run supplier discovery, the one task that makes " +
      "third-party calls on its own initiative.",
    absence:
      "Off, deliberately (2026-09-02). It was nominally always-on and had never once " +
      "run, because it declared the entire invocation budget and something always ran " +
      "first. Fixing that starvation would have started it as a side effect of " +
      "unrelated work, so its observed behaviour was preserved by making its state " +
      "explicit. Turning it on is its own decision." },

  // ---- shipping ----------------------------------------------------------
  { readBySdk: true, name: "EASYPOST_API_KEY", group: "shipping", requirement: "feature", secret: true,
    purpose: "Buys shipping labels and tracks parcels.",
    absence: "No label can be bought; tracking stops updating." },
  { name: "EASYPOST_WEBHOOK_SECRET", group: "shipping", requirement: "feature", secret: true,
    purpose: "Verifies carrier tracking events.",
    absence: "Tracking updates are refused, so an order never reaches Delivered." },
  { name: "USPS_CLIENT_ID", group: "shipping", requirement: "feature", secret: false,
    purpose: "USPS rate quotes.", absence: "USPS rates are unavailable." },
  { name: "USPS_CLIENT_SECRET", group: "shipping", requirement: "feature", secret: true,
    purpose: "USPS rate quotes.", absence: "USPS rates are unavailable." },
  { name: "USPS_ACCOUNT_NUMBER", group: "shipping", requirement: "feature", secret: true,
    purpose: "The USPS account rates are quoted against.", absence: "USPS rates are unavailable." },
  { name: "USPS_ACCOUNT_TYPE", group: "shipping", requirement: "feature", secret: false,
    purpose: "Which kind of USPS account.", absence: "USPS rates are unavailable." },
  { name: "USPS_ORIGIN_ZIP", group: "shipping", requirement: "feature", secret: false,
    purpose: "Where parcels ship from, for quoting.", absence: "USPS rates are unavailable." },
  { name: "USPS_USE_TEST_ENVIRONMENT", group: "shipping", requirement: "optional", secret: false,
    purpose: "Point USPS at its sandbox.", absence: "Live USPS is used." },

  // ---- ops ---------------------------------------------------------------
  { name: "CRON_SECRET", group: "ops", requirement: "production", secret: true,
    purpose: "The only thing standing in front of every scheduled task.",
    absence: "Fails CLOSED — every cron trigger answers 401, so nothing scheduled runs at all." },
  { name: "PLATFORM_ADMIN_EMAILS", group: "ops", requirement: "production", secret: false,
    purpose: "Who may reach the operator surfaces.",
    absence: "Fails CLOSED — nobody is a platform administrator and /admin is unreachable." },
  { name: "NEXT_PUBLIC_SENTRY_DSN", group: "ops", requirement: "production", secret: false,
    purpose: "Where errors and operational alerts are sent.",
    absence: "Nothing reaches a person. Failures are console lines in short-retention runtime logs." },
  { name: "INTEGRATION_ENCRYPTION_KEY", group: "ops", requirement: "production", secret: true,
    purpose: "Encrypts every stored provider credential.",
    absence: "No integration credential can be stored or read. Every connected provider stops working." },
  // Build-time, read by next.config when Sentry's marketplace integration is
  // linked. Their absence is why source maps are not uploaded — which is a
  // real, small consequence somebody should be able to look up rather than
  // rediscover.
  { name: "SENTRY_ORG", group: "ops", requirement: "optional", secret: false,
    purpose: "Which Sentry organisation source maps belong to.",
    absence: "Source maps are not uploaded, so a stack trace names bundled files rather than yours." },
  { name: "SENTRY_PROJECT", group: "ops", requirement: "optional", secret: false,
    purpose: "Which Sentry project source maps belong to.",
    absence: "Source maps are not uploaded, so a stack trace names bundled files rather than yours." },
  { name: "SENTRY_AUTH_TOKEN", group: "ops", requirement: "optional", secret: true,
    purpose: "Authorises the source-map upload at build time.",
    absence: "Source maps are not uploaded, so a stack trace names bundled files rather than yours." },
  { name: "ONBOARDING_V2_ENABLED", group: "ops", requirement: "optional", secret: false,
    purpose: "Which onboarding flow new visitors get.", absence: "The previous flow is used." },

  // ---- connections -------------------------------------------------------
  //
  // Every one of these is a provider registration. They are `feature` rather
  // than `production` on purpose: this platform is designed to run with none of
  // them connected, and a startup report that shouted about all fifteen would
  // be a report nobody reads.
  { name: "PRINTFUL_CLIENT_ID", group: "connections", requirement: "feature", secret: false,
    purpose: "Print-on-demand fulfilment.", absence: "Printful cannot be connected." },
  { name: "PRINTFUL_CLIENT_SECRET", group: "connections", requirement: "feature", secret: true,
    purpose: "Print-on-demand fulfilment.", absence: "Printful cannot be connected." },
  { name: "QUICKBOOKS_CLIENT_ID", group: "connections", requirement: "feature", secret: false,
    purpose: "Accounting sync.", absence: "QuickBooks cannot be connected." },
  { name: "QUICKBOOKS_CLIENT_SECRET", group: "connections", requirement: "feature", secret: true,
    purpose: "Accounting sync.", absence: "QuickBooks cannot be connected." },
  { name: "QUICKBOOKS_ENVIRONMENT", group: "connections", requirement: "optional", secret: false,
    purpose: "Sandbox or production QuickBooks.", absence: "Production is used." },
  { name: "GOOGLE_CALENDAR_CLIENT_ID", group: "connections", requirement: "feature", secret: false,
    purpose: "Appointments.", absence: "Google Calendar cannot be connected." },
  { name: "GOOGLE_CALENDAR_CLIENT_SECRET", group: "connections", requirement: "feature", secret: true,
    purpose: "Appointments.", absence: "Google Calendar cannot be connected." },
  { name: "MAILCHIMP_CLIENT_ID", group: "connections", requirement: "feature", secret: false,
    purpose: "Email campaigns.", absence: "Mailchimp cannot be newly connected; existing key-based connections still sync." },
  { name: "MAILCHIMP_CLIENT_SECRET", group: "connections", requirement: "feature", secret: true,
    purpose: "Email campaigns.", absence: "Mailchimp cannot be newly connected." },
  { name: "FACEBOOK_CLIENT_ID", group: "connections", requirement: "feature", secret: false,
    purpose: "Facebook and Instagram, from one app.", absence: "Neither Facebook nor Instagram can be connected." },
  { name: "FACEBOOK_CLIENT_SECRET", group: "connections", requirement: "feature", secret: true,
    purpose: "Facebook and Instagram, from one app.", absence: "Neither Facebook nor Instagram can be connected." },
  { name: "TIKTOK_CLIENT_KEY", group: "connections", requirement: "feature", secret: false,
    purpose: "Publishing to and reading from TikTok.", absence: "TikTok cannot be connected." },
  { name: "TIKTOK_CLIENT_SECRET", group: "connections", requirement: "feature", secret: true,
    purpose: "Publishing to and reading from TikTok.", absence: "TikTok cannot be connected." },
  { name: "ALIEXPRESS_APP_KEY", group: "connections", requirement: "feature", secret: false,
    purpose: "Product sourcing.", absence: "AliExpress cannot be searched; the source refuses rather than inventing products." },
  { name: "ALIEXPRESS_APP_SECRET", group: "connections", requirement: "feature", secret: true,
    purpose: "Product sourcing.", absence: "AliExpress cannot be searched." },
  { name: "SQUARE_CLIENT_ID", group: "connections", requirement: "feature", secret: false,
    purpose: "Square point of sale.", absence: "Square cannot be connected." },
  { name: "SQUARE_CLIENT_SECRET", group: "connections", requirement: "feature", secret: true,
    purpose: "Square point of sale.", absence: "Square cannot be connected." },
  { name: "SQUARE_USE_SANDBOX", group: "connections", requirement: "optional", secret: false,
    purpose: "Point Square at its sandbox.", absence: "Production Square is used." },
  { name: "XERO_CLIENT_ID", group: "connections", requirement: "feature", secret: false,
    purpose: "Accounting sync.", absence: "Xero cannot be connected." },
  { name: "XERO_CLIENT_SECRET", group: "connections", requirement: "feature", secret: true,
    purpose: "Accounting sync.", absence: "Xero cannot be connected." },
  // TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN were here and are gone: nothing in
  // this repository reads either. The Twilio connector keeps its credentials
  // encrypted per store, like every other key-based connector, so describing
  // them as deployment configuration was describing something that does not
  // exist. Caught by this registry's own reverse assertion, on its author.

  // ============ FOUND BY THE SWEEP, NOT BY ME (2026-08-30) ==========
  //
  // Five variables this codebase reads that the first draft of this registry
  // did not describe — including the Google sign-in credentials, which are not
  // a connector at all but half of how people log in. Exactly the drift the
  // sweep exists to catch, caught on its first run against its own author.
  { name: "GOOGLE_CLIENT_ID", group: "core", requirement: "feature", secret: false,
    purpose: "Signing in with Google.",
    absence: "The Google sign-in button fails; email and password still work." },
  { name: "GOOGLE_CLIENT_SECRET", group: "core", requirement: "feature", secret: true,
    purpose: "Signing in with Google.",
    absence: "The Google sign-in button fails; email and password still work." },
  { name: "ALIEXPRESS_TRACKING_ID", group: "connections", requirement: "feature", secret: false,
    purpose: "The affiliate tracking id AliExpress searches are attributed to.",
    absence: "AliExpress sourcing runs unattributed, or refuses, depending on the endpoint." },
  { name: "ALIEXPRESS_SIGN_METHOD", group: "connections", requirement: "optional", secret: false,
    purpose: "Which signing algorithm the AliExpress API expects.",
    absence: "The documented default is used." },
  { name: "ALIEXPRESS_GRANTED_CAPABILITIES", group: "connections", requirement: "optional", secret: false,
    purpose: "Which AliExpress API scopes this app has actually been granted.",
    absence: "Capabilities are treated as ungranted, so sourcing refuses rather than guessing." },
];

export function configEntry(name: string): ConfigEntry | undefined {
  return CONFIG.find((entry) => entry.name === name);
}

/**
 * Variables this registry deliberately does not describe.
 *
 * Set by the platform or by the harness rather than by an operator, so a report
 * asking somebody to go and configure them would be asking for nothing.
 */
export const NOT_CONFIGURATION = new Set([
  "NODE_ENV",
  "NEXT_RUNTIME",
  "NEXT_TELEMETRY_DISABLED",
  "CI",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "GENESIS_HARNESS_BASE_URL",
  "GENESIS_HARNESS_DATABASE_URL",
  "GENESIS_TEST_DATABASE",
  // Set by a verification suite for itself, from playwright.config.ts at the
  // repository root. Not deployment configuration — it reached this sweep only
  // because the sweep reads root-level files for the Sentry and migration
  // variables that genuinely are.
  "PLAYWRIGHT_BASE_URL",
]);
