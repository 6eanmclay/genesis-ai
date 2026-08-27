// TALKING TO TWILIO — the half that can be proven without an account.
//
// Verified against Twilio's own documentation on 2026-08-27, not from memory.
// Every non-obvious claim below names where it came from, because two of them
// contradict what this codebase would otherwise have assumed.
//
// ============ WHAT THE DOCS ACTUALLY SAY ==================================
//
// BASE URL IS STILL /2010-04-01/. It looks like a typo and it is not; Twilio
// has never versioned the core Messages and Accounts resources past it.
//   https://www.twilio.com/docs/usage/requests-to-twilio
//
// FORM-ENCODED, NOT JSON. "Using an unsupported content type might cause
// unexpected behavior or errors." A JSON request body is refused outright —
// which is the sort of thing that reads as a credentials problem for an hour.
//   https://www.twilio.com/docs/usage/requests-to-twilio
//
// THE RESPONSE IS JSON EVEN THOUGH THE REQUEST IS NOT, and errors carry a
// Twilio `code` distinct from the HTTP `status`. The code is the useful one:
// a 400 can be a malformed number or an unupgraded account, and those are
// different conversations with the owner.
//   https://www.twilio.com/docs/usage/twilios-response

export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

/** Where a message is sent. */
export function messagesUrl(accountSid: string): string {
  return `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
}

/**
 * The cheapest honest proof a set of credentials is real.
 *
 * Chosen over "send a message and see" for the obvious reason, and over any
 * list endpoint because this one ALSO returns `type` and `status` — so one call
 * answers "are these valid", "is this a trial account", and "is it suspended".
 * All three matter, and the second is the one that would otherwise be found out
 * at the worst possible moment.
 *   https://www.twilio.com/docs/iam/api/account
 */
export function accountUrl(accountSid: string): string {
  return `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}.json`;
}

// ============ NUMBERS =====================================================

/**
 * Is this E.164, the only format Twilio accepts for `To`?
 *
 * PURE AND STRICT. Twilio rejects anything else with error 21211, and a
 * rejection that arrives as a failed notification hours later is far more
 * expensive than one that arrives as a form error. `+` then a non-zero digit
 * then up to 14 more.
 *   https://www.twilio.com/docs/api/errors/21211
 */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{1,14}$/.test(value);
}

/**
 * E.164 from what a person actually typed, or null.
 *
 * DELIBERATELY DOES NOT GUESS A COUNTRY. "5551234567" is a valid national
 * number in dozens of countries, and assuming +1 would send an order
 * notification to a stranger somewhere. A number without a country code is
 * refused, not repaired.
 */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // A leading "00" is the international prefix in most of the world and means
  // exactly what "+" means. This is a notation difference, not a guess.
  const normalized = trimmed.startsWith("00") ? `+${trimmed.slice(2)}` : trimmed;
  if (!normalized.startsWith("+")) return null;

  // Spaces, dashes, brackets and dots are how humans write numbers.
  const stripped = "+" + normalized.slice(1).replace(/[\s\-().]/g, "");
  return isE164(stripped) ? stripped : null;
}

// ============ WHAT COMES BACK =============================================

export type TwilioFailure =
  /** The credentials are wrong, revoked, or for another account. */
  | { kind: "auth"; detail: string; code: number | null }
  /** Too many requests. Twilio says these are safe to retry after backing off. */
  | { kind: "rate_limit"; detail: string; code: number | null }
  /** The destination number is not one Twilio will accept. */
  | { kind: "bad_recipient"; detail: string; code: number | null }
  /**
   * The account is real but not allowed to send this.
   *
   * THE ONE THAT WOULD OTHERWISE LOOK LIKE A BUG. A trial account authenticates
   * perfectly and then refuses to message any number the owner has not verified
   * (21608), and an unverified toll-free number is blocked outright (30032).
   * Both are account state, not code, and neither is fixable from here.
   */
  | { kind: "not_permitted"; detail: string; code: number | null }
  /** Anything else Twilio said. */
  | { kind: "provider"; detail: string; code: number | null };

export interface TwilioErrorBody {
  status?: number;
  message?: string;
  code?: number;
  more_info?: string;
}

/**
 * Twilio's own error codes, mapped to what they mean for an owner.
 *
 * MATCHED ON THE TWILIO CODE, NOT THE HTTP STATUS. 21211 (a malformed phone
 * number) and 21608 (an account that has not been upgraded) are both HTTP 400
 * and have nothing to do with each other — one is a data problem the owner can
 * fix in a form, the other is a billing decision at Twilio.
 *
 * Every code here is quoted from Twilio's own error reference:
 *   20003 https://www.twilio.com/docs/api/errors/20003
 *   20429 https://www.twilio.com/docs/api/errors/20429
 *   21211 https://www.twilio.com/docs/api/errors/21211
 *   21608 https://www.twilio.com/docs/api/errors/21608
 *   30032 https://www.twilio.com/docs/api/errors/30032
 */
export function classifyFailure(httpStatus: number, body: unknown): TwilioFailure {
  const error = (typeof body === "object" && body !== null ? body : {}) as TwilioErrorBody;
  const code = typeof error.code === "number" ? error.code : null;
  const detail = error.message?.trim() || `Twilio returned HTTP ${httpStatus}`;

  switch (code) {
    case 20003:
      return { kind: "auth", detail, code };
    case 20429:
      return { kind: "rate_limit", detail, code };
    case 21211:
    case 21214:
      return { kind: "bad_recipient", detail, code };
    case 21608:
    case 30032:
    case 30007:
      return { kind: "not_permitted", detail, code };
    case 20404:
      // A wrong Account SID with an otherwise-valid key lands here. That is a
      // credentials problem from where the owner is standing, whatever Twilio
      // calls it.
      return { kind: "auth", detail, code };
  }

  // No recognisable code. The HTTP status is the fallback, and 401/429 are
  // unambiguous even without one.
  if (httpStatus === 401 || httpStatus === 403) return { kind: "auth", detail, code };
  if (httpStatus === 429) return { kind: "rate_limit", detail, code };
  return { kind: "provider", detail, code };
}

// ============ THE ACCOUNT =================================================

export interface TwilioAccountView {
  sid: string;
  friendlyName: string | null;
  /** "Trial" or "Full". The difference is whether it can message real people. */
  type: string | null;
  /** "active", "suspended", or "closed". */
  status: string | null;
}

export function readAccount(body: unknown): TwilioAccountView | null {
  if (typeof body !== "object" || body === null) return null;
  const account = body as Record<string, unknown>;
  const sid = typeof account.sid === "string" ? account.sid : null;
  if (!sid) return null;
  return {
    sid,
    friendlyName: typeof account.friendly_name === "string" ? account.friendly_name : null,
    type: typeof account.type === "string" ? account.type : null,
    status: typeof account.status === "string" ? account.status : null,
  };
}

/**
 * What this account can actually do, said plainly.
 *
 * ============ WHY THIS IS NOT JUST `ok: true` =============================
 *
 * A trial account passes authentication and every credential check, and then
 * cannot send an order notification to a customer — Twilio permits trial
 * accounts to message only numbers the owner has personally verified, at most
 * five of them, and as of 2026 only with Twilio's own templates rather than a
 * custom body. So "the credentials work" and "this connection will notify your
 * customers" are different claims, and reporting the first as if it were the
 * second is the exact kind of quiet lie the connection-truthfulness work exists
 * to prevent.
 *
 *   https://www.twilio.com/docs/usage/trials
 */
export function accountReadiness(account: TwilioAccountView): {
  canSendToCustomers: boolean;
  summary: string;
} {
  if (account.status === "suspended") {
    return {
      canSendToCustomers: false,
      summary: "This Twilio account is suspended, so it can't send anything. Twilio suspends for billing or policy reasons — their console will say which.",
    };
  }
  if (account.status === "closed") {
    return { canSendToCustomers: false, summary: "This Twilio account is closed." };
  }
  if (account.type === "Trial") {
    return {
      canSendToCustomers: false,
      summary:
        "These credentials work, but this is a Twilio trial account — it can only message numbers you've personally verified (up to five), " +
        "and only using Twilio's own templates. It can't notify a customer. Upgrading the account in Twilio's console lifts both limits.",
    };
  }
  return {
    canSendToCustomers: true,
    summary: `Connected to Twilio account ${account.friendlyName ?? account.sid}.`,
  };
}

// ============ THE MESSAGE =================================================

export interface SendMessageParams {
  accountSid: string;
  to: string;
  /** A Twilio number in E.164, or a Messaging Service SID. Exactly one. */
  from: string;
  body: string;
}

/**
 * The form-encoded body for a send.
 *
 * `From` OR `MessagingServiceSid`, never both — Twilio accepts either, and a
 * Messaging Service SID always starts MG. Choosing between them by prefix keeps
 * the caller from having to know which kind of thing it was handed.
 *   https://www.twilio.com/docs/messaging/api/message-resource
 */
export function messageForm(params: Omit<SendMessageParams, "accountSid">): URLSearchParams {
  const form = new URLSearchParams();
  form.set("To", params.to);
  if (params.from.startsWith("MG")) form.set("MessagingServiceSid", params.from);
  else form.set("From", params.from);
  form.set("Body", params.body);
  return form;
}

export interface SentMessage {
  sid: string;
  status: string | null;
  /** Twilio charges per SEGMENT, not per message. */
  segments: number | null;
}

export function readSentMessage(body: unknown): SentMessage | null {
  if (typeof body !== "object" || body === null) return null;
  const message = body as Record<string, unknown>;
  const sid = typeof message.sid === "string" ? message.sid : null;
  if (!sid) return null;
  return {
    sid,
    status: typeof message.status === "string" ? message.status : null,
    // Twilio returns this as a STRING, which is the sort of thing that turns
    // into "2" + 1 = "21" somewhere downstream.
    segments: message.num_segments != null ? Number(message.num_segments) || null : null,
  };
}

// ============ THE GSM 03.38 CHARACTER TABLES ==============================
//
// Written as escapes rather than literal characters on purpose: this decides
// what a message COSTS, and a table that silently mangled itself in an encoding
// round trip would misreport money with nothing visible to show for it. Escapes
// survive any editor, any transfer, and any tool that rewrites this file.
//
// Anything outside BOTH tables forces the entire message to UCS-2, which drops
// the per-segment limit from 160 characters to 70.
const GSM_BASIC_SET = new Set("@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u00c6\u00e6\u00df\u00c9 !\"#\u00a4%&'()*+,-./0123456789:;<=>?\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0");

// Present in GSM only behind an escape prefix, so each of these costs TWO of
// the 160 rather than one.
const GSM_EXTENDED_SET = new Set("^{}\\[~]|\u20ac");

/**
 * How many SMS segments a body costs.
 *
 * MONEY, NOT TRIVIA. A body that tips over a boundary costs double, and one
 * non-GSM character — a curly apostrophe pasted from a word processor, an
 * emoji — switches the whole message to UCS-2 and drops the limit from 160 to
 * 70. That is why generated copy must be measured rather than eyeballed.
 */
export function segmentsFor(body: string): number {
  if (body.length === 0) return 0;

  // ============ THE REAL GSM 03.38 TABLE, NOT AN APPROXIMATION ============
  //
  // The first version of this tested "is it Latin-1" as a stand-in for "is it
  // GSM", and it was wrong in BOTH directions. é, ñ and ü are Latin-1 AND
  // GSM, so it counted ordinary Spanish or French copy as UCS-2 and reported
  // double the real cost. ÿ and þ are Latin-1 and NOT GSM, so it counted
  // those as GSM and would have reported half of it.
  //
  // The set is finite and published, so there is no reason to approximate it.
  // Found by a test asserting 71 accented characters cost two segments -- they
  // cost one, and the assertion was right to disagree with the implementation.
  const GSM_BASIC = GSM_BASIC_SET;
  // These exist in GSM only behind an escape prefix, so each costs TWO.
  const GSM_EXTENDED = GSM_EXTENDED_SET;

  let gsmLength = 0;
  let gsmOnly = true;
  for (const ch of body) {
    if (GSM_BASIC.has(ch)) gsmLength += 1;
    else if (GSM_EXTENDED.has(ch)) gsmLength += 2;
    else {
      gsmOnly = false;
      break;
    }
  }

  if (gsmOnly) {
    // Concatenated messages spend header space in every segment: 153, not 160.
    return gsmLength <= 160 ? 1 : Math.ceil(gsmLength / 153);
  }

  // UCS-2. Count UTF-16 code units, because an emoji outside the BMP is a
  // surrogate pair and genuinely occupies two of the 70.
  const units = [...body].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return units <= 70 ? 1 : Math.ceil(units / 67);
}
