import * as Sentry from "@sentry/nextjs";
import { redactSecrets } from "@/lib/integrations/providerError";

// Making the failures this audit found actually reachable by a human
// (2026-08-20).
//
// THE GAP. Sentry is wired and its DSN is set in production, but nineteen error
// paths across the webhooks, the checkout return, the scheduler and the
// execution engine were `console.error` and nothing else. Not one of them
// reached Sentry.
//
// Those are not incidental paths. They are the ones this audit added or
// hardened precisely because they matter: a completed Stripe payment that
// produced no order, a Growth Point purchase that could not be credited, a
// PayPal capture that took money and could not be recorded, a connector whose
// grant could not be revoked, one store's failure inside a cross-tenant cron.
//
// On Vercel a console line goes to runtime logs, which are retained briefly and
// only found by someone who already suspects a problem. "Money arrived and
// produced nothing" cannot depend on somebody thinking to look.
//
// The owner-facing half already exists — these paths write a durable
// ExecutionLog the store owner sees. This is the OPERATOR half.

export type Subsystem =
  | "payments"
  | "billing"
  | "integrations"
  | "scheduler"
  | "execution"
  | "email"
  // Product sourcing and progression (2026-08-20). Its own subsystem rather than
  // borrowing "integrations": a supplier being unreachable and a progression
  // snapshot failing to parse are different problems for different people.
  | "sourcing"
  // Account security (2026-08-22, Security & Trust). Its own subsystem rather
  // than borrowing "execution": a sign-in being throttled and a Genesis action
  // failing are different problems, read by different people, and a security
  // failure that hid inside execution noise is one nobody would go looking for.
  | "security";

export interface IssueContext {
  /** Which part of the system, for routing and alerting. */
  subsystem: Subsystem;
  /** What was being attempted, e.g. "stripe.checkout.unresolved". */
  stage: string;
  /** The tenant, when there is one. Absent is a real answer, not a gap. */
  storeId?: string | null;
  /** Anything else worth having at 3am. Values are redacted before sending. */
  extra?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * Where a report goes. Injectable so the behaviour can be asserted — Sentry's
 * module exports are getter-only and cannot be stubbed, and the properties
 * worth proving here (never throws, never leaks a token) are exactly the ones
 * that cannot be checked by reading. Same shape as ExecutionEventSink.
 */
export type IssueSink = (error: Error, options: {
  tags: Record<string, string>;
  extra: Record<string, unknown>;
}) => void;

const sentrySink: IssueSink = (error, options) => {
  Sentry.captureException(error, options);
};

/**
 * Report a real problem to the operator, and to the console.
 *
 * NEVER THROWS. Every call site is already inside a catch, handling something
 * that has gone wrong — a reporting failure there must not become the thing
 * that breaks a payment, a sync, or a checkout redirect.
 */
export function reportIssue(
  message: string,
  error: unknown,
  context: IssueContext,
  sink: IssueSink = sentrySink
): void {
  // Redacted on the way out. These messages carry provider responses, and
  // lib/integrations/providerError.ts exists because those can contain tokens.
  const safeMessage = redactSecrets(message);

  // The console line stays. It is what someone tailing `vercel logs` during an
  // incident actually sees, and it costs nothing.
  console.error(`[${context.subsystem}/${context.stage}] ${safeMessage}`, error);

  try {
    sink(error instanceof Error ? error : new Error(safeMessage), {
      tags: {
        subsystem: context.subsystem,
        stage: context.stage,
        // Tagged rather than buried in extra, so "which store is this?" is a
        // filter rather than a search.
        ...(context.storeId ? { storeId: context.storeId } : {}),
      },
      extra: {
        message: safeMessage,
        ...redactExtra(context.extra),
      },
    });
  } catch {
    // Sentry unconfigured, offline, or rate-limited. The console line above is
    // the fallback, and the operation carries on either way.
  }
}

function redactExtra(
  extra: IssueContext["extra"]
): Record<string, string | number | boolean | null | undefined> {
  if (!extra) return {};
  const out: Record<string, string | number | boolean | null | undefined> = {};
  for (const [key, value] of Object.entries(extra)) {
    out[key] = typeof value === "string" ? redactSecrets(value) : value;
  }
  return out;
}
