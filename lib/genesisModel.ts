import Anthropic from "@anthropic-ai/sdk";
import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/prisma";
import { USAGE_CEILING_MESSAGE } from "@/lib/dashboard/genesisModelMessages";
import type { AiFeature } from "@/lib/aiFeatures";
import { computeAnthropicCost } from "@/lib/aiPricing";
import { businessIntentFor } from "@/lib/businessIntent";
import { growthCreditValueFor } from "@/lib/growthCreditCatalog";

// Reliability architecture (v21, Phase 1) — the one Anthropic client and the
// one call path every AI-calling function in this codebase goes through.
// Before this, 4 files each instantiated their own `new Anthropic()` and
// called `.stream(...).finalMessage()` directly with zero error handling —
// confirmed via a real production incident (2026-07-28: Anthropic credit
// exhaustion produced 40 unhandled 500s, because nothing anywhere classified
// or caught a provider error before it reached Next's default error page).
// callGenesisModel() never throws — every caller gets a typed result and is
// forced to consciously handle the failure branch, the same way this
// codebase's execute()/ExecutionResult already treats SUCCESS/FAILED as
// values rather than exceptions.
export const anthropic = new Anthropic();

// Track 0 (Operational Foundations) — AI cost governance, an emergency
// circuit breaker, not a billing system (Sean's explicit framing). One
// starting number, deliberately generous and clearly adjustable, not a
// researched figure: high enough that no real, even heavily-active owner
// should ever see it, tight enough to stop a genuine runaway loop within an
// hour or two rather than letting it run all day.
const DAILY_TOKEN_CEILING = 2_000_000;

// Experience-First Onboarding, Milestone 5 — anonymous sessions have no
// account to attribute real usage to, so they get their own, deliberately
// tighter ceiling instead of sharing the real per-account budget above.
// Same "starting number, deliberately generous within its own tier, not a
// researched figure" status as DAILY_TOKEN_CEILING — sized to comfortably
// cover a real visitor trying a handful of ideas (one confident-generation
// call is ~2,500-3,000 tokens; the bounded clarifying-question cap in
// lib/onboarding/experienceFlow.ts means a single session is at most two
// such calls), while stopping a scripted/automated loop within minutes
// instead of running all day on one anonymous identity.
const ANONYMOUS_DAILY_TOKEN_CEILING = 50_000;

function ceilingFor(scope: GenesisModelScope): number {
  return "anonymousSessionToken" in scope ? ANONYMOUS_DAILY_TOKEN_CEILING : DAILY_TOKEN_CEILING;
}

// Not every AI call has a real Store yet — store-draft generation and
// draft-phase chat (generateStoreDraftCore/applyGenesisMessage in
// ai-actions.ts) run before a Store row exists, with only a userId
// available. Exactly one of these is ever set; AiUsageEvent.storeId/userId
// are both nullable for the same reason (see that model's own comment in
// schema.prisma). Each identifier gets its own independent daily ceiling
// bucket — a real, accepted simplification for a Track 0 item, not a
// unified per-owner total across the draft-to-live boundary.
//
// Experience-First Onboarding — a third scope, anonymousSessionToken, for
// AI calls made before any real account exists (lib/onboarding/
// anonymousSession.ts). Same "exactly one of the three is ever set"
// convention. The anonymous case still runs through this same daily
// ceiling today; a real, deliberately tighter anonymous-specific limit is
// EXPERIENCE_FIRST_ONBOARDING.md's own scoped fast-follow, not yet built.
export type GenesisModelScope =
  | { storeId: string; userId?: never; anonymousSessionToken?: never }
  | { userId: string; storeId?: never; anonymousSessionToken?: never }
  | { anonymousSessionToken: string; storeId?: never; userId?: never };

// Real usage for the current UTC day, summed from AiUsageEvent — a query
// over an append-only log, not a separately-maintained counter, so it
// can't drift out of sync and the same table can grow into rolling
// windows/analytics later without a schema change (see the model's own
// comment in schema.prisma).
async function getTodayTokenUsage(scope: GenesisModelScope): Promise<number> {
  const todayStartUtc = new Date();
  todayStartUtc.setUTCHours(0, 0, 0, 0);
  const result = await prisma.aiUsageEvent.aggregate({
    where: { ...scope, occurredAt: { gte: todayStartUtc } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  return (result._sum.inputTokens ?? 0) + (result._sum.outputTokens ?? 0);
}

export type GenesisModelErrorKind =
  | "billing"
  | "auth"
  | "permission"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "network"
  | "unknown"
  | "usage_ceiling";

export interface GenesisModelFailure {
  ok: false;
  kind: GenesisModelErrorKind;
  status: number | null;
  message: string;
  retryable: boolean;
  durationMs: number;
  // True only for kind: "usage_ceiling" on an owner-initiated call — the
  // one case where a caller can retry with confirmedOverride: true instead
  // of just waiting. Every other failure (including a background-work
  // usage_ceiling block, which has no human to confirm anything) leaves
  // this false, so every existing call site's generic failure handling
  // keeps working unchanged — only a caller that wants to build a
  // confirm-and-continue UI needs to look at this field at all.
  confirmable: boolean;
}

export interface GenesisModelSuccess<T> {
  ok: true;
  message: T;
  durationMs: number;
}

export type GenesisModelResult<T> = GenesisModelSuccess<T> | GenesisModelFailure;

// Anthropic's SDK exposes a typed exception per HTTP status (see
// node_modules/@anthropic-ai/sdk/core/error.d.ts) plus a real `.type` field
// carrying the API's own error-type string (e.g. "invalid_request_error").
// There is no dedicated status/type for "out of credit" — the real incident
// above surfaced it as a plain 400 BadRequestError whose message happens to
// mention "credit balance". That's the one place this classifier matches on
// message content instead of a typed field; everywhere else it's a clean
// instanceof chain, most-specific first, per the SDK's own documented
// pattern.
// confirmable is deliberately not this function's concern — it's set
// explicitly to false wherever this result is used, since a real provider
// error is never something a caller can "confirm past."
function classifyAnthropicError(err: unknown): Omit<GenesisModelFailure, "ok" | "durationMs" | "confirmable"> {
  if (err instanceof Anthropic.APIConnectionError) {
    return { kind: "network", status: null, message: err.message, retryable: true };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { kind: "rate_limit", status: 429, message: err.message, retryable: true };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return { kind: "auth", status: 401, message: err.message, retryable: false };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { kind: "permission", status: 403, message: err.message, retryable: false };
  }
  if (err instanceof Anthropic.BadRequestError) {
    const isBilling = /credit balance/i.test(err.message);
    return {
      kind: isBilling ? "billing" : "invalid_request",
      status: 400,
      message: err.message,
      retryable: false,
    };
  }
  if (err instanceof Anthropic.InternalServerError) {
    // Covers every >=500 the SDK maps to this class, including 529
    // (overloaded_error) — the SDK's own retry has already been exhausted
    // by the time this reaches us (see the note on retry behavior below).
    return { kind: "overloaded", status: err.status ?? null, message: err.message, retryable: true };
  }
  if (err instanceof Anthropic.APIError) {
    return { kind: "unknown", status: err.status ?? null, message: err.message, retryable: false };
  }
  return {
    kind: "unknown",
    status: null,
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}

export type GenesisModelContext = GenesisModelScope & {
  // Set only by the one genuinely autonomous call site today
  // (lib/intelligence/cognitiveLayer.ts's runCognitiveReview, invoked from
  // both an opportunistic after() on dashboard page loads and the daily
  // cron scheduler — confirmed by tracing every real call site, not
  // assumed). A ceiling breach on background work stops immediately, no
  // confirmation possible — there's no human present to confirm anything.
  background?: boolean;
  // Set only by a caller re-issuing a call the owner has explicitly
  // confirmed past a "usage_ceiling" block (see GenesisModelFailure's
  // confirmable field). Skips the ceiling check entirely for this one
  // call. Never set automatically.
  confirmedOverride?: boolean;
  // AI Cost & Usage Infrastructure — what this call is actually for (see
  // lib/aiFeatures.ts). Required, not optional: a call site with no
  // feature tag is exactly the silent gap this system exists to close,
  // so it's a compile error rather than an easy thing to forget.
  feature: AiFeature;
};

// AI Cost & Usage Infrastructure — records real per-call usage from the
// provider's own response, never estimated, same discipline this function
// already had before this pass just extended what it captures. Awaited
// (not fire-and-forget) so the row is reliably written before the request
// completes, since a serverless function can exit immediately after
// responding — but its own failure is caught here and never allowed to
// turn a real successful AI response into a reported failure.
//
// businessIntent/growthCreditValue are derived from `feature`, not passed
// in separately — a call site only ever specifies one identifier, and
// everything else about "what kind of business activity is this" and
// "what should it cost in Growth Credits" follows automatically from that
// single source of truth (lib/businessIntent.ts, lib/growthCreditCatalog.ts).
async function recordUsage(
  scope: GenesisModelScope,
  feature: AiFeature,
  model: string,
  durationMs: number,
  usage: { input_tokens: number; output_tokens: number }
): Promise<void> {
  try {
    await prisma.aiUsageEvent.create({
      data: {
        ...scope,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        feature,
        provider: "anthropic",
        model,
        durationMs,
        costUsd: computeAnthropicCost({ model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }),
        businessIntent: businessIntentFor(feature),
        growthCreditValue: growthCreditValueFor(feature),
      },
    });
  } catch (err) {
    Sentry.captureException(err);
  }
}

// Retry behavior — a deliberate decision, not an omission: the Anthropic
// SDK already retries 429/5xx/connection errors internally before ever
// throwing to this wrapper (default max_retries: 2, with backoff — confirmed
// via the real incident's own log line, which carried
// `x-should-retry: 'false'` on the one error class, billing, that correctly
// isn't retried). Adding a second automatic retry loop on top of that would
// only compound latency on every multi-thousand-token PRIMARY/CONTROL/
// CONTENT call for a case the SDK already covers, and would multiply failed
// requests during exactly the kind of incident this wrapper exists to
// survive (an outage or exhausted quota). So: classify and report the
// terminal outcome; let the human decide to retry, same as any other
// consciously-taken action in this app.
export async function callGenesisModel<Params extends Parameters<typeof anthropic.messages.stream>[0]>(
  params: Params,
  context: GenesisModelContext
): Promise<
  GenesisModelResult<Awaited<ReturnType<ReturnType<typeof anthropic.messages.stream<Params>>["finalMessage"]>>>
> {
  const startedAt = Date.now();
  const { background = false, confirmedOverride = false, feature, ...scope } = context;
  const scopeLabel =
    "storeId" in scope
      ? `storeId=${scope.storeId}`
      : "userId" in scope
        ? `userId=${scope.userId}`
        : `anonymousSessionToken=${scope.anonymousSessionToken}`;

  // Track 0 — AI cost governance. Checked before spending anything on a
  // real provider call. Fails open on its own error (an outage in this
  // check must never become a second, unrelated way for Genesis to stop
  // working) — that failure is itself reported, since a broken usage query
  // is a real bug worth knowing about, just not one that should block a
  // real request.
  if (!confirmedOverride) {
    let usedTokensToday: number;
    try {
      usedTokensToday = await getTodayTokenUsage(scope);
    } catch (err) {
      Sentry.captureException(err);
      usedTokensToday = 0;
    }

    const ceiling = ceilingFor(scope);
    if (usedTokensToday >= ceiling) {
      const durationMs = Date.now() - startedAt;
      const summary = `[ai-usage-ceiling] ${scopeLabel} background=${background} usedTokensToday=${usedTokensToday} ceiling=${ceiling}`;
      console.error(summary);
      Sentry.captureMessage(summary, "warning");
      return {
        ok: false,
        kind: "usage_ceiling",
        status: null,
        message: `Daily AI usage ceiling reached (${usedTokensToday.toLocaleString()}/${ceiling.toLocaleString()} tokens).`,
        retryable: !background,
        confirmable: !background,
        durationMs,
      };
    }
  }

  try {
    const message = await anthropic.messages.stream(params).finalMessage();
    const durationMs = Date.now() - startedAt;
    await recordUsage(scope, feature, params.model, durationMs, message.usage);
    return { ok: true, message, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const classified = classifyAnthropicError(err);
    // Standardized logging — one consistent, greppable shape for every
    // provider failure in the app, replacing what would otherwise be 13
    // independent (and, before this, nonexistent) error logs. This is what
    // let the 2026-07-28 incident be diagnosed at all — it was only visible
    // via raw Vercel function logs, not through any of this app's own
    // telemetry.
    console.error(
      `[genesis-ai-error] kind=${classified.kind} status=${classified.status ?? "n/a"} durationMs=${durationMs} retryable=${classified.retryable}`,
      classified.message
    );
    return { ok: false, ...classified, confirmable: false, durationMs };
  }
}

// The one place user-facing copy for a provider failure lives — every call
// site reuses this instead of composing its own message, so wording stays
// consistent and a future tweak doesn't need 13 edits. Deliberately never
// exposes the raw provider error text to the merchant (matches this
// codebase's standing rule that Genesis never surfaces implementation
// details) — the real message is only in the server log via the
// classifier's console.error above.
export function genesisModelFailureMessage(kind: GenesisModelErrorKind): string {
  switch (kind) {
    case "billing":
      return "Genesis's AI provider is temporarily unavailable — the account is out of credit. Your message has been saved, so nothing is lost. Please try again once this is resolved.";
    case "auth":
      return "Genesis can't authenticate with its AI provider right now. Your message has been saved — please try again shortly.";
    case "rate_limit":
      return "Genesis is handling a lot of requests right now. Your message has been saved — please try again in a moment.";
    case "overloaded":
      return "Genesis's AI provider is temporarily overloaded. Your message has been saved — please try again shortly.";
    case "network":
      return "Genesis couldn't reach its AI provider just now. Your message has been saved — please try again.";
    case "usage_ceiling":
      // Deliberately doesn't mention "confirm" — this generic string is
      // what most call sites show as-is; only GenesisAssistant.tsx builds
      // the richer confirm-and-continue UI, matching on this exact string
      // (imported from the same shared constant, not duplicated) since
      // StoreMessage/StoreDraftMessage have no field to carry structured
      // metadata about which failure produced a given assistant message.
      return USAGE_CEILING_MESSAGE;
    case "permission":
    case "invalid_request":
    case "unknown":
    default:
      return "Genesis ran into an unexpected problem generating a response. Your message has been saved — please try again, and let us know if this keeps happening.";
  }
}
