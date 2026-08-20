// Rate limiting, handled once (2026-08-20).
//
// The audit found no explicit 429 handling in the hand-written fetch
// connectors: a rate limit surfaced as a generic failure and was retried on the
// next scheduled pass, ignoring the moment the provider actually said to come
// back. Sean's instruction was to check whether this belongs at the connector
// layer rather than being sprinkled per provider — and whether each provider
// even needs it, "rather than adding unnecessary complexity".
//
// It belongs here, and NOT every provider needs it. What each one actually
// does, checked against its own documentation rather than assumed:
//
//   Mailchimp   429 "exceeded the limit of 10 simultaneous connections"
//   TikTok      429 + error code `rate_limit_exceeded` (600/min)
//   Google      403 usageLimits OR 429 usageLimits — and Google explicitly
//               recommends exponential backoff WITH JITTER, not Retry-After
//   QuickBooks  429 when throttled
//   Printful    120 calls/min; the status code is undocumented, so this treats
//               429 defensively rather than claiming to know
//
//   Stripe      NOTHING TO DO. stripe-node retries 429s itself, and its default
//               maxNetworkRetries is 2 in the version installed here. Wrapping
//               it would add a second retry loop around one that already works.
//   EasyPost    NOTHING TO DO — official SDK, same reasoning.
//   Meta        NOTHING TO DO, and adding it would be WRONG. The Graph API does
//               not return 429. It returns 200/400 with an error CODE in the
//               body (4 app-level, 17 user-level, 32/80001 page-level) and puts
//               the wait in X-Business-Use-Case-Usage's
//               `estimated_time_to_regain_access`, in minutes. A 429 handler
//               would never fire, and would read as protection that isn't there.
//
// The single most valuable part is not the retry — it is RateLimitedError
// reaching the scheduler, so a throttled connector waits the length of time the
// provider asked for instead of the generic exponential backoff guessing.

/** Thrown when retries are exhausted, carrying the provider's own timing. */
export class RateLimitedError extends Error {
  readonly retryAfterMs: number | null;
  readonly status: number;

  constructor(message: string, params: { retryAfterMs: number | null; status: number }) {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterMs = params.retryAfterMs;
    this.status = params.status;
  }
}

/**
 * `Retry-After` in milliseconds — pure.
 *
 * The header is legally either delta-seconds or an HTTP-date (RFC 9110), and
 * providers use both. `now` is injected so the date form is testable.
 */
export function parseRetryAfter(header: string | null | undefined, now: Date = new Date()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;

  // delta-seconds. Deliberately strict: "12abc" is not 12 seconds, it is a
  // header we do not understand, and guessing at it is worse than backing off.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  // A date already in the past means "now" — never a negative wait.
  return Math.max(0, when - now.getTime());
}

export const MAX_BACKOFF_MS = 8_000;

/**
 * How long to wait before attempt N — pure.
 *
 * The provider's own instruction wins when it gave one. Otherwise exponential
 * with jitter, which is what Google documents and asks for by name: without the
 * random component, every client that hit the limit together retries together
 * and hits it again.
 *
 * `random` is injected because a test asserting jitter cannot be at the mercy
 * of Math.random.
 */
export function nextDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  random: () => number = Math.random
): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const exponential = Math.min(2 ** attempt * 250, MAX_BACKOFF_MS);
  return exponential + Math.floor(random() * 1000);
}

export interface IntegrationFetchOptions {
  /** Attempts INCLUDING the first. 3 keeps the worst case inside a serverless budget. */
  maxAttempts?: number;
  /**
   * Google returns 403 for rate limiting as well as for genuine permission
   * failures, and retrying a permission failure is wrong. A connector that
   * needs the 403 case supplies a predicate that reads the body and decides.
   */
  isRateLimited?: (response: Response, bodyText: string) => boolean;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  random?: () => number;
  fetchImpl?: typeof fetch;
  /** Named in the error a human eventually reads. */
  label?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * fetch(), with the provider's rate limiting respected.
 *
 * Non-429 responses — including ordinary 4xx/5xx failures — are returned
 * untouched. This retries rate limiting, not everything: a 400 means the
 * request was wrong and repeating it is just a slower 400.
 */
export async function integrationFetch(
  url: string,
  init: RequestInit = {},
  options: IntegrationFetchOptions = {}
): Promise<Response> {
  const {
    maxAttempts = 3,
    isRateLimited,
    sleep = defaultSleep,
    now = () => new Date(),
    random = Math.random,
    fetchImpl = fetch,
    label = "provider",
  } = options;

  let lastRetryAfterMs: number | null = null;
  let lastStatus = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetchImpl(url, init);

    let limited = response.status === 429;
    if (!limited && isRateLimited) {
      // Read through a clone so the caller still gets an unconsumed body.
      const bodyText = await response.clone().text().catch(() => "");
      limited = isRateLimited(response, bodyText);
    }
    if (!limited) return response;

    lastStatus = response.status;
    lastRetryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now());

    // Out of attempts — surface the provider's own timing rather than burning
    // the last wait for nothing.
    if (attempt === maxAttempts - 1) break;

    await sleep(nextDelayMs(attempt, lastRetryAfterMs, random));
  }

  throw new RateLimitedError(
    lastRetryAfterMs !== null
      ? `${label} is rate limiting us and asked to wait ${Math.round(lastRetryAfterMs / 1000)}s.`
      : `${label} is rate limiting us.`,
    { retryAfterMs: lastRetryAfterMs, status: lastStatus }
  );
}

/** Google's own documented rate-limit reasons, which arrive as a 403. */
export function isGoogleRateLimit(response: Response, bodyText: string): boolean {
  if (response.status !== 403) return false;
  return /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(bodyText);
}
