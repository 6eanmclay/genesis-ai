import { createHash, createHmac } from "crypto";

// TALKING TO ALIEXPRESS.
//
// The signature and the request shaping are PURE and are the whole of what can
// be proven from here: AliExpress issues app credentials only after an
// application, a signed Open Platform Agreement, company details, a 1–2 day
// review and an audit of the finished app. There are no credentials yet, so not
// one live call has been made — and a signature that is subtly wrong fails with
// an opaque error at the gateway rather than anywhere useful. Making it pure is
// what lets it be checked against a known vector before that day arrives.
//
// ============ THE SIGNATURE ==============================================
//
// The basestring is the same for both methods:
//
//   1. sort every parameter by KEY
//   2. concatenate key and value in that order, with NO separators at all
//
// What differs is what happens to it -- see the AliexpressSignMethod comment
// below. Each step is a place to get it wrong quietly: sorting by value,
// joining with "&", wrapping on one side, or lowercase hex all produce a
// well-formed signature that the gateway simply rejects, with an error that
// says nothing about which step was wrong.
//
// SOURCE AND ITS LIMIT. AliExpress's own API reference sits behind a developer
// login this project does not have, so this is verified against its public
// getting-started material and the maintained client SDKs rather than the
// vendor's reference page. The first live call is what settles it, and
// check-aliexpress-live.ts exists to be that call.

/** The AliExpress/Taobao gateway. All methods are routed through the one URL. */
export const ALIEXPRESS_GATEWAY = "https://api-sg.aliexpress.com/sync";

/** Everything AliExpress requires on every call, whatever the method. */
export interface AliexpressSystemParams {
  app_key: string;
  method: string;
  /** "yyyy-MM-dd HH:mm:ss" in UTC. */
  timestamp: string;
  sign_method: AliexpressSignMethod;
  format: "json";
  v: "2.0";
}

/**
 * ============ TWO SIGNING METHODS, AND THE DEFAULT MOVED ==================
 *
 * The first version of this file implemented MD5 only, and MD5 is real — it is
 * the algorithm Taobao's TOP gateway has always documented, and AliExpress
 * inherited that gateway. But it is the LEGACY half of the story, and shipping
 * only it would have been a coin flip on the first live call.
 *
 * The maintained AliExpress SDK signs with HMAC-SHA256, and the two are not
 * variations on a theme — they differ in what the secret even is:
 *
 *   md5     the secret WRAPS the basestring on both sides, and the whole
 *           thing is hashed.        MD5(secret + basestring + secret)
 *
 *   sha256  the secret is the HMAC KEY and wraps nothing.
 *           HMAC-SHA256(key = secret, data = basestring)
 *
 * Both then uppercase the hex. Feeding one's basestring to the other's
 * algorithm produces a perfectly well-formed signature that the gateway
 * refuses, with an error that says nothing about which of them was wrong.
 *
 * So both are implemented, the default is HMAC-SHA256 because that is what the
 * current SDK does for AliExpress specifically, and switching is one
 * environment variable rather than a rewrite. The first live call settles it,
 * and settling it costs a redeploy instead of a debugging session.
 */
export type AliexpressSignMethod = "md5" | "sha256";

/** Overridable, so the first live call can settle it without a code change. */
export function configuredSignMethod(): AliexpressSignMethod {
  return process.env.ALIEXPRESS_SIGN_METHOD?.trim().toLowerCase() === "md5" ? "md5" : "sha256";
}

/** Sorted by KEY, concatenated `keyvaluekeyvalue`, with no delimiter at all. */
function basestring(params: Record<string, string>): string {
  const sorted = Object.keys(params).sort();
  let concatenated = "";
  for (const key of sorted) concatenated += key + params[key];
  return concatenated;
}

/**
 * The signature for a set of parameters.
 *
 * PURE, and deliberately takes the secret before the method so a call site
 * cannot pass the arguments the wrong way round without the types complaining.
 */
export function signRequest(
  params: Record<string, string>,
  appSecret: string,
  signMethod: AliexpressSignMethod = "md5",
): string {
  if (signMethod === "sha256") return signHmacSha256(params, appSecret);
  return signMd5(params, appSecret);
}

/** HMAC-SHA256 with the secret as the KEY. Nothing is wrapped. */
export function signHmacSha256(params: Record<string, string>, appSecret: string): string {
  return createHmac("sha256", appSecret).update(basestring(params), "utf8").digest("hex").toUpperCase();
}

/** The legacy TOP algorithm: the secret WRAPS the basestring on both sides. */
export function signMd5(params: Record<string, string>, appSecret: string): string {
  // Wrapped on BOTH sides by the secret. This is the whole difference from
  // HMAC-SHA256, where the secret is the key and wraps nothing.
  const wrapped = `${appSecret}${basestring(params)}${appSecret}`;
  return createHash("md5").update(wrapped, "utf8").digest("hex").toUpperCase();
}

/** AliExpress wants "2026-08-27 14:03:22" in UTC, not an ISO string. */
export function aliexpressTimestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ` +
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`
  );
}

/**
 * A complete, signed parameter set for one call.
 *
 * The signature is computed over the system parameters AND the method's own
 * arguments together — signing only one half is another way to produce a
 * string that looks right and is refused.
 */
export function buildSignedParams(params: {
  method: string;
  appKey: string;
  appSecret: string;
  args?: Record<string, string | number | undefined>;
  now?: Date;
  /** Defaults to whatever the environment says, so one variable moves it. */
  signMethod?: AliexpressSignMethod;
}): Record<string, string> {
  // THE DECLARED METHOD AND THE ONE ACTUALLY USED MUST BE THE SAME ONE.
  // Sending sign_method=md5 alongside an HMAC-SHA256 signature is a refusal
  // that looks exactly like bad credentials.
  const signMethod = params.signMethod ?? configuredSignMethod();
  const system: AliexpressSystemParams = {
    app_key: params.appKey,
    method: params.method,
    timestamp: aliexpressTimestamp(params.now ?? new Date()),
    sign_method: signMethod,
    format: "json",
    v: "2.0",
  };

  const all: Record<string, string> = { ...system };
  for (const [key, value] of Object.entries(params.args ?? {})) {
    // Absent is absent. Sending `undefined` as the string "undefined" is a real
    // way to sign a value the caller never meant to send.
    if (value === undefined || value === null || value === "") continue;
    all[key] = String(value);
  }

  return { ...all, sign: signRequest(all, params.appSecret, signMethod) };
}

// ============ WHAT COMES BACK ============================================
//
// AliExpress answers HTTP 200 for almost everything, including failures, and
// puts the real outcome in the body. A client that trusted the status code
// would read an authentication failure as a successful search with no results —
// which is exactly the confusion between "nothing matched" and "I could not
// look" that this whole sourcing layer exists to avoid.

export type AliexpressFailure =
  /** The credentials are wrong, expired, or for a different app. */
  | { kind: "auth"; detail: string }
  /** Too many calls. Real, and worth telling apart: it will work later. */
  | { kind: "rate_limit"; detail: string }
  /** The app is not approved for this method yet. */
  | { kind: "not_permitted"; detail: string }
  /** Anything else the gateway said. */
  | { kind: "provider"; detail: string };

export interface AliexpressErrorBody {
  error_response?: {
    code?: string | number;
    msg?: string;
    sub_code?: string;
    sub_msg?: string;
  };
}

/**
 * The failure in a response body, or null when there is none.
 *
 * The codes below are the documented families. An unrecognised one is
 * "provider" with the gateway's own words attached, never swallowed — a message
 * nobody can read is still better than a message nobody was given.
 */
export function readFailure(body: unknown): AliexpressFailure | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as AliexpressErrorBody).error_response;
  if (!error) return null;

  const code = String(error.code ?? "").trim();
  const sub = String(error.sub_code ?? "").trim();
  const detail = [error.msg, error.sub_msg].filter(Boolean).join(": ") || `AliExpress error ${code || sub}`;

  // ============ CODES MATCH EXACTLY, NOT BY SUBSTRING ======================
  //
  // The obvious implementation tests one regex against code and sub_code joined
  // together, and it is wrong in a way that is easy to miss: a bare `7` for the
  // call-limit code also matches 7 inside 27 and 17, so "invalid session" — an
  // authentication failure — would be reported to the owner as throttling and
  // "try again shortly". Wrong advice, delivered confidently, about the one
  // thing they could have fixed.
  //
  // So numeric codes are compared as numbers and sub_codes by name.
  const numeric = Number(code);

  // Authentication: the key, the secret, the signature, or the session.
  if (numeric === 27 || /IllegalAppKey|InvalidSignature|MissingAppKey|InvalidSession|invalid-signature|MissingParameter/i.test(sub)) {
    return { kind: "auth", detail };
  }
  // Throttling. Real, and worth telling apart: it will work later.
  if (numeric === 7 || /AppCallLimit|AppInvokeLimited|ServiceCallLimited|flow.?limit/i.test(sub)) {
    return { kind: "rate_limit", detail };
  }
  // The app exists and is authenticated, but is not approved for this method.
  if (/InsufficientIsvPermissions|IsvNotAuthorized|permission/i.test(sub)) {
    return { kind: "not_permitted", detail };
  }
  return { kind: "provider", detail };
}

/** One product as AliExpress returns it from the affiliate product query. */
export interface AliexpressProduct {
  product_id?: string | number;
  product_title?: string;
  product_main_image_url?: string;
  /** A price string in the requested currency, e.g. "12.34". */
  target_sale_price?: string;
  target_sale_price_currency?: string;
  original_price?: string;
  product_detail_url?: string;
  evaluate_rate?: string;
  lastest_volume?: number;
}

/**
 * The products in a response, or an empty list.
 *
 * NEVER THROWS on shape. AliExpress nests results several levels deep and has
 * changed the nesting between method versions; a client that indexed blindly
 * would crash on a response that merely had no results.
 */
export function readProducts(body: unknown): AliexpressProduct[] {
  const root = body as Record<string, unknown> | null;
  if (!root || typeof root !== "object") return [];

  // The response key is the method name with dots replaced by underscores and
  // "_response" appended, which is why this looks for it rather than naming it.
  const responseKey = Object.keys(root).find((k) => k.endsWith("_response"));
  const response = responseKey ? (root[responseKey] as Record<string, unknown>) : root;
  if (!response || typeof response !== "object") return [];

  const result = (response.resp_result ?? response.result) as Record<string, unknown> | undefined;
  const inner = (result?.result ?? result) as Record<string, unknown> | undefined;
  const products = (inner?.products ?? inner?.product) as Record<string, unknown> | undefined;
  const list = (products?.product ?? products) as unknown;

  if (Array.isArray(list)) return list as AliexpressProduct[];
  return [];
}

/** Cents from AliExpress's decimal price string, or null when unreadable. */
export function priceInCents(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}
