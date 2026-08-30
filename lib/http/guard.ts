import { NextResponse } from "next/server";
import { z, type ZodType } from "zod";
import { recordSignal, SIGNAL_KINDS } from "@/lib/security/signals";
import { checkRateLimit, type RateLimitRule } from "./rateLimit";
import { clientIp, addressLabel } from "./clientIp";

// THE PUBLIC BOUNDARY: HOW BIG, WHAT SHAPE, HOW OFTEN.
//
// ============ WHAT WAS AT THE EDGE BEFORE THIS (2026-08-30) ============
//
// Two of twenty-six route handlers validated anything. The rest read
// `request.json()` or `formData()` and trusted the result — including
// /api/register, which is unauthenticated, creates a row, and runs a bcrypt
// hash per call, so a script could both fill the user table and spend a
// hundred milliseconds of CPU per request for free.
//
// Signature verification on the webhook routes is a different guarantee and was
// never this one: a correctly signed payload of the wrong shape still reaches a
// handler.
//
// ============ THE ORDER IS THE DESIGN =================================
//
// size → read → parse → shape → rate
//
// Each step is cheap enough to run before the one after it, and each refuses
// the requests that would make the next one expensive:
//
//   size   before reading, so a caller cannot make the server hold a hundred
//          megabytes in memory to discover it is not JSON.
//   parse  before shape, because a body that is not JSON has no shape.
//   shape  before rate, because a rate limit is often keyed on a field of the
//          body — an email, a store — and keying on an unvalidated value means
//          the caller chooses their own bucket.
//   rate   last, and counted even when it refuses.
//
// The last one is the subtle one. A limiter keyed on caller-supplied input that
// was never validated is a limiter with an unlimited number of buckets.
//
// ============ WHAT A REJECTION MAY SAY, AND MAY NOT ===================
//
// Every rejection leaves a trail. NONE of it contains the body, a header, a
// token, a password or the value being limited. The signal carries the surface,
// which rule refused and by how much — enough to see an attack and nothing that
// creates one.
//
// The RESPONSE says less again: a shape rejection names the fields that were
// wrong, never their values, because "password must be at least 12 characters"
// is help and echoing what somebody typed is a log entry waiting to leak.

export type GuardOutcome<T> =
  | { ok: true; body: T }
  | { ok: false; response: NextResponse };

export interface GuardOptions<T> {
  /** Names this endpoint in signals. Never a path with an id in it. */
  surface: string;
  /** The largest body this endpoint will read. */
  maxBytes?: number;
  /** The shape the body must have. Omit for endpoints that take no body. */
  schema?: ZodType<T>;
  /**
   * Limits to apply, given the validated body.
   *
   * A function rather than a list so a rule can be keyed on the body — and
   * because it runs AFTER validation, the key is a value the schema has already
   * vouched for.
   */
  limits?: (body: T, address: string) => RateLimitRule[];
  /** Who is asking, when the caller already knows. Recorded on refusals. */
  actorId?: string | null;
}

/** A body larger than this is refused unless an endpoint says otherwise. */
export const DEFAULT_MAX_BYTES = 64 * 1024;

/**
 * Run the public-boundary checks for one request.
 *
 * Returns either a validated body or the response to send. The caller never
 * sees an invalid body, which is the point: validation that returns a warning
 * is validation somebody forgets to act on.
 */
export async function guard<T>(request: Request, options: GuardOptions<T>): Promise<GuardOutcome<T>> {
  const { surface, schema, limits, actorId } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const address = addressLabel(clientIp(request.headers));

  // ---- size, before anything is read ------------------------------------
  //
  // Content-Length is a claim, not a fact, so the read below is bounded too.
  // Checking the header first refuses the honest-but-huge request without
  // reading a byte of it.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await refusalSignal(surface, "payload too large", actorId, { declaredBytes: declared, maxBytes });
    return { ok: false, response: problem(413, "That request is too large.") };
  }

  let body: unknown = undefined;
  if (schema) {
    const raw = await readBounded(request, maxBytes);
    if (raw === TOO_LARGE) {
      // A lying Content-Length, or none at all. Same answer.
      await refusalSignal(surface, "payload too large", actorId, { maxBytes });
      return { ok: false, response: problem(413, "That request is too large.") };
    }

    try {
      body = raw.length === 0 ? undefined : JSON.parse(raw);
    } catch {
      await refusalSignal(surface, "not json", actorId, {});
      return { ok: false, response: problem(400, "That request could not be read.") };
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      // ============ FIELDS, NEVER VALUES =========================
      //
      // The paths that failed and the rule they broke. Not what was sent — a
      // rejected registration body holds a password, and echoing it into a
      // response or a signal is how a security feature becomes a leak.
      const fields = parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "(body)",
        problem: issue.message,
      }));
      await refusalSignal(surface, "failed validation", actorId, {
        fields: fields.map((f) => f.field),
      });
      return {
        ok: false,
        response: NextResponse.json({ error: "That request was not valid.", fields }, { status: 400 }),
      };
    }
    body = parsed.data;
  }

  // ---- rate, keyed on values the schema has vouched for -----------------
  if (limits) {
    const verdict = await checkRateLimit(limits(body as T, address), { surface, actorId });
    if (!verdict.allowed) {
      const response = problem(429, "That is too many requests for now. Try again shortly.");
      if (verdict.retryAfterSeconds) {
        response.headers.set("retry-after", String(verdict.retryAfterSeconds));
      }
      return { ok: false, response };
    }
  }

  return { ok: true, body: body as T };
}

const TOO_LARGE = Symbol("too large");

/**
 * Read at most `maxBytes`, whatever the headers claimed.
 *
 * Streamed rather than `request.text()`, because text() reads everything before
 * anyone can object — which is exactly the request a size limit exists to
 * refuse. A caller who lies about Content-Length is stopped by the counter
 * here rather than by the header above.
 */
async function readBounded(request: Request, maxBytes: number): Promise<string | typeof TOO_LARGE> {
  const reader = request.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling. Nothing further is read into memory.
        await reader.cancel().catch(() => {});
        return TOO_LARGE;
      }
      chunks.push(value);
    }
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** The refusal, in the caller's terms, carrying nothing about what they sent. */
function problem(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

async function refusalSignal(
  surface: string,
  reason: string,
  actorId: string | null | undefined,
  detail: Record<string, unknown>,
): Promise<void> {
  await recordSignal({
    // Its own kind. Recording these as rate limiting would make
    // ratelimit.tripped useless for the thing it names — a hundred malformed
    // requests and a hundred throttled ones are different facts.
    kind: SIGNAL_KINDS.boundaryRejected,
    severity: "info",
    actorKind: actorId ? "user" : "anonymous",
    actorId: actorId ?? null,
    surface: `http:${surface}`,
    detail: { reason, ...detail },
  });
}

// ============ QUERY STRINGS, FOR ROUTES THAT REDIRECT =================
//
// The three OAuth-shaped callbacks — the two provider returns and PayPal's —
// cannot use `guard` above, and forcing them to would have been a redesign of
// exactly the flows Sean said not to touch. They answer a failure by REDIRECTING
// a person back where they came from with a flash parameter, not by returning
// JSON, and that behaviour is load-bearing: a customer mid-purchase must land
// somewhere that explains itself.
//
// So this validates and reports, and hands the route back its own decision. It
// returns no Response at all.
//
// ============ WHAT VALIDATION ADDS WHERE STATE IS ALREADY SIGNED ======
//
// Not authorization. `completeOAuthHandoff` verifies the signature, nonce,
// provider, expiry and session user, and that is a far stronger control than
// any shape check — nothing here weakens or duplicates it.
//
// What it adds is BOUNDS. `code` is handed to a provider's token exchange and
// `state` to a signature check, and neither had a length. A megabyte of query
// string reaching a crypto routine or an outbound HTTP call is work somebody
// else chose for us, and the callbacks are the one place on this platform where
// an unauthenticated stranger can put text into a URL a signed-in owner will
// click.

export type QueryOutcome<T> =
  | { ok: true; value: T }
  /** The field names that were wrong. Never their values. */
  | { ok: false; fields: string[] };

/**
 * Validate a query string without deciding what to do about it.
 *
 * Records the refusal on the same signal stream as `guard`, so a burst of
 * malformed callbacks is visible next to every other boundary rejection.
 */
export async function validateQuery<T>(
  request: Request,
  options: { surface: string; schema: ZodType<T>; actorId?: string | null },
): Promise<QueryOutcome<T>> {
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const parsed = options.schema.safeParse(params);
  if (parsed.success) return { ok: true, value: parsed.data };

  const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "(query)");
  await refusalSignal(options.surface, "invalid query", options.actorId, { fields });
  return { ok: false, fields };
}

/**
 * A query parameter that is present, bounded, and free of anything a URL should
 * not be carrying.
 *
 * Deliberately an allow-list. OAuth codes and signed state tokens are
 * base64url-ish with punctuation, so the class is wide enough for every real
 * one and narrow enough that a script tag or a newline is not a parameter.
 */
export function queryToken(max: number) {
  return z.string().min(1).max(max).regex(/^[\w\-.:~+/=%|]+$/, "unexpected characters");
}
