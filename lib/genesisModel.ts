import Anthropic from "@anthropic-ai/sdk";

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

export type GenesisModelErrorKind =
  | "billing"
  | "auth"
  | "permission"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "network"
  | "unknown";

export interface GenesisModelFailure {
  ok: false;
  kind: GenesisModelErrorKind;
  status: number | null;
  message: string;
  retryable: boolean;
  durationMs: number;
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
function classifyAnthropicError(err: unknown): Omit<GenesisModelFailure, "ok" | "durationMs"> {
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
  params: Params
): Promise<
  GenesisModelResult<Awaited<ReturnType<ReturnType<typeof anthropic.messages.stream<Params>>["finalMessage"]>>>
> {
  const startedAt = Date.now();
  try {
    const message = await anthropic.messages.stream(params).finalMessage();
    return { ok: true, message, durationMs: Date.now() - startedAt };
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
    return { ok: false, ...classified, durationMs };
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
    case "permission":
    case "invalid_request":
    case "unknown":
    default:
      return "Genesis ran into an unexpected problem generating a response. Your message has been saved — please try again, and let us know if this keeps happening.";
  }
}
