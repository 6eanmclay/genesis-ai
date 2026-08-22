import Anthropic from "@anthropic-ai/sdk";
import {
  classifyAnthropicError,
  ceilingFor,
  genesisModelFailureMessage,
  type GenesisModelErrorKind,
  type GenesisModelScope,
} from "@/lib/genesisModel";
import { USAGE_CEILING_MESSAGE, ANONYMOUS_USAGE_CEILING_MESSAGE } from "@/lib/dashboard/genesisModelMessages";

// WHAT AN OWNER READS WHEN GENESIS CANNOT ANSWER:
//
//   npx tsx scripts/verify-genesis-model.ts
//
// EXTERNALLY BLOCKED, and recorded rather than substituted: callGenesisModel
// itself needs a real ANTHROPIC_API_KEY, and there is none in this environment.
// No mock stands in for the call — a mocked provider asserts that the mock
// works. What IS reachable is everything that decides how a failure is handled,
// and that is the part an owner actually experiences.
//
// TWO DECISIONS PER FAILURE, and each is a different kind of harm when wrong:
//
//   WHICH SENTENCE. Genesis Experience Principle 1 is "spoken, not logged" — a
//   raw provider error is never shown verbatim. Every message here also has to
//   say that nothing was lost, because the owner has just watched their message
//   apparently vanish.
//
//   WHETHER TO KEEP TRYING. retryable drives real retry behaviour. Retrying a
//   billing or auth failure is a loop against a wall — it cannot succeed, it
//   spends real money on connection attempts, and it delays telling the owner
//   the one thing that would let them fix it.
//
// The classifier's ORDERING is load bearing too, and not obvious from reading
// it: the raw-text checks for overloaded_error and rate_limit_error run BEFORE
// the instanceof chain, and resolveErrorText walks err.cause. That is what makes
// a provider error survive being wrapped in something else on the way up.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const ALL_KINDS: GenesisModelErrorKind[] = [
  "billing", "auth", "permission", "rate_limit",
  "overloaded", "invalid_request", "network", "unknown", "usage_ceiling",
];

/** A real SDK error of the given class, built the way the SDK builds them. */
const apiError = (Cls: new (...args: never[]) => Error, status: number, message: string) =>
  // The SDK's error classes take (status, error, message, headers).
  new (Cls as unknown as new (s: number, e: unknown, m: string, h: unknown) => Error)(
    status, { error: { message } }, message, undefined
  );

// ============================================================================
console.log("\n=== 1. Genesis keeps trying only when trying can work ===\n");
// ============================================================================
const RETRYABLE: Record<string, boolean> = {
  overloaded: true,
  rate_limit: true,
  network: true,
  auth: false,
  permission: false,
  billing: false,
  invalid_request: false,
  unknown: false,
};

const cases: { name: string; err: unknown; kind: GenesisModelErrorKind }[] = [
  { name: "a connection failure", err: new Anthropic.APIConnectionError({ message: "socket hang up" }), kind: "network" },
  { name: "a 429", err: apiError(Anthropic.RateLimitError, 429, "rate limited"), kind: "rate_limit" },
  { name: "a 401", err: apiError(Anthropic.AuthenticationError, 401, "bad key"), kind: "auth" },
  { name: "a 403", err: apiError(Anthropic.PermissionDeniedError, 403, "not allowed"), kind: "permission" },
  { name: "a 500", err: apiError(Anthropic.InternalServerError, 500, "server error"), kind: "overloaded" },
  { name: "a plain 400", err: apiError(Anthropic.BadRequestError, 400, "max_tokens is too large"), kind: "invalid_request" },
  { name: "an unrecognised error", err: new Error("something else entirely"), kind: "unknown" },
];

for (const { name, err, kind } of cases) {
  const classified = classifyAnthropicError(err);
  check(`${name} is ${kind}`, classified.kind, kind);
  check(`and is ${RETRYABLE[kind] ? "" : "not "}retried`, classified.retryable, RETRYABLE[kind]);
}

assert(
  "so Genesis never retries a failure that cannot succeed",
  (["auth", "permission", "billing", "invalid_request"] as const).every((k) => RETRYABLE[k] === false),
  "a retry loop against a wall spends money and delays the one thing the owner could act on"
);

// ============================================================================
console.log("\n=== 2. Out of credit is not a bad request ===\n");
// ============================================================================
// Both arrive as a 400. They are entirely different situations: one is
// Genesis's own account needing attention, the other is a call that was
// malformed. Discriminated on the provider's own wording.
const billing = classifyAnthropicError(
  apiError(Anthropic.BadRequestError, 400, "Your credit balance is too low to access the Anthropic API")
);
check("a credit-balance 400 is billing", billing.kind, "billing");
check("and still not retried", billing.retryable, false);
const malformed = classifyAnthropicError(apiError(Anthropic.BadRequestError, 400, "messages: at least one message is required"));
check("while an ordinary 400 stays invalid_request", malformed.kind, "invalid_request");
assert("so the two 400s do not read as the same problem",
  billing.kind !== malformed.kind,
  "one needs somebody to top up an account; the other is a bug");

// ============================================================================
console.log("\n=== 3. A provider error survives being wrapped ===\n");
// ============================================================================
// The ordering that is not obvious from reading: the raw-text checks run BEFORE
// the instanceof chain, and resolveErrorText walks err.cause. Without both, an
// overload arriving inside a stream wrapper would be classified "unknown" —
// reported as an unexpected problem and never retried, when it is the most
// retryable failure there is.
const wrappedOverload = classifyAnthropicError(
  new Error('stream failed: {"type":"overloaded_error","message":"Overloaded"}')
);
check("an overloaded_error in the text is overloaded", wrappedOverload.kind, "overloaded");
check("and is retried", wrappedOverload.retryable, true);

const causedOverload = classifyAnthropicError(
  Object.assign(new Error("stream failed"), {
    cause: new Error('{"type":"overloaded_error","message":"Overloaded"}'),
  })
);
check("an overloaded_error in the CAUSE is found too", causedOverload.kind, "overloaded");
assert("so a wrapped overload is never reported as an unexpected problem",
  causedOverload.kind === "overloaded",
  "classified unknown, it would be shown as a bug and never retried — the opposite of both truths");

const wrappedRateLimit = classifyAnthropicError(new Error('{"type":"rate_limit_error"}'));
check("a wrapped rate_limit_error too", wrappedRateLimit.kind, "rate_limit");

// A non-Error is still classified rather than crashing the classifier.
check("a thrown string is unknown", classifyAnthropicError("just a string").kind, "unknown");
check("and a thrown null", classifyAnthropicError(null).kind, "unknown");

// ============================================================================
console.log("\n=== 4. Spoken, not logged ===\n");
// ============================================================================
for (const kind of ALL_KINDS) {
  const message = genesisModelFailureMessage(kind);
  assert(`${kind} has a real sentence`, message.trim().length > 20, message);
  assert(`${kind} names no provider`, !/anthropic|claude|openai|elevenlabs/i.test(message), message);
  assert(`${kind} shows no status code`, !/\b(400|401|403|429|5\d\d)\b/.test(message), message);
  assert(`${kind} shows no stack or JSON`,
    !message.includes("Error:") && !message.includes('{"') && !message.includes("at "),
    message);
}

// Every failure has to say the owner's work survived, because they have just
// watched their message apparently disappear.
const reassuring = ALL_KINDS.filter((k) => {
  const m = genesisModelFailureMessage(k);
  return /saved|nothing is lost|still here|kept/i.test(m);
});
check("every failure says the owner's message was kept", ALL_KINDS.filter((k) => !reassuring.includes(k)), []);

// The three that deliberately share the generic message, and the ones that
// deliberately do not.
const GENERIC: GenesisModelErrorKind[] = ["permission", "invalid_request", "unknown"];
check("permission, invalid_request and unknown share the generic message",
  new Set(GENERIC.map((k) => genesisModelFailureMessage(k))).size, 1);
assert("while billing says something an owner could act on",
  genesisModelFailureMessage("billing").includes("out of credit"),
  genesisModelFailureMessage("billing"));
assert("and rate_limit says to wait rather than that something broke",
  /moment|shortly|again/i.test(genesisModelFailureMessage("rate_limit")),
  genesisModelFailureMessage("rate_limit"));

// usage_ceiling is matched on EXACTLY this string by GenesisAssistant to build
// its confirm-and-continue UI, "imported from the same shared constant, not
// duplicated" — so the two must not drift.
check("the ceiling message is the shared constant",
  genesisModelFailureMessage("usage_ceiling"), USAGE_CEILING_MESSAGE);
assert("which deliberately does not mention confirming",
  !/confirm/i.test(USAGE_CEILING_MESSAGE),
  "most call sites show this as-is; only one builds the richer UI");
// Compared as plain strings: both are string literals, so TypeScript can prove
// the inequality statically and rejects the comparison outright.
assert("and the anonymous one is a different message",
  String(ANONYMOUS_USAGE_CEILING_MESSAGE) !== String(USAGE_CEILING_MESSAGE),
  "a visitor with no account cannot be told their message was saved to it");
assert("which speaks to somebody who has no account yet",
  /account/i.test(ANONYMOUS_USAGE_CEILING_MESSAGE),
  ANONYMOUS_USAGE_CEILING_MESSAGE);

// ============================================================================
console.log("\n=== 5. A visitor cannot spend an owner's budget ===\n");
// ============================================================================
const ownerScope = { storeId: "s1" } as unknown as GenesisModelScope;
const anonScope = { anonymousSessionToken: "tok" } as unknown as GenesisModelScope;

const ownerCeiling = ceilingFor(ownerScope);
const anonCeiling = ceilingFor(anonScope);
assert(`an account gets the full daily ceiling (${ownerCeiling.toLocaleString()})`, ownerCeiling === 2_000_000, String(ownerCeiling));
assert(`an anonymous session gets a much tighter one (${anonCeiling.toLocaleString()})`, anonCeiling === 50_000, String(anonCeiling));
assert("which is far tighter, not merely smaller",
  ownerCeiling / anonCeiling >= 10,
  `${ownerCeiling / anonCeiling}x — sized to stop a scripted loop within minutes rather than running all day`);
assert("and both are real positive integers",
  Number.isInteger(ownerCeiling) && ownerCeiling > 0 && Number.isInteger(anonCeiling) && anonCeiling > 0);

console.log(`\n${failures === 0 ? "All genesis-model assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
