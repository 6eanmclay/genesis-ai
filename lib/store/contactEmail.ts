import { reservedTldOf } from "@/lib/email/sendEmail";

// ============ THE ADDRESS A CUSTOMER MAY WRITE TO ====================
//
// THE DEFECT THIS EXISTS FOR (2026-09-24). A customer bought twelve items,
// received nothing, and could find no way to contact the shop. The storefront
// tells her to make contact in three separate places — the pending-payment
// notice, the unavailable-payments notice, and the payment-taken-unconfirmed
// screen, which is the worst possible place to have no channel — and every one
// of them names no address, because none existed. Store had no contact column
// at all, across all sixteen businesses.
//
// WHY THIS IS NOT THE OWNER'S LOGIN EMAIL. `Store.user.email` exists on every
// store and would have been the easy answer. It is the address the owner signs
// in with, and publishing it on a storefront is a disclosure they never agreed
// to. So this is a SEPARATE field, and its absence is never filled in from the
// account:
//
//   NEVER INFERRED     no model, no upload, no connector may supply it
//   NEVER BACKFILLED   the migration writes nothing to existing rows
//   NEVER FALLEN BACK  null means "the owner has not chosen one", and the
//                      storefront shows no contact at all rather than an
//                      address the owner did not publish
//
// It is therefore not a BusinessRecord either. That table is graded evidence,
// including facts a model concluded from a document — exactly the provenance a
// published contact address must never have. A deliberate publishing decision
// by a human belongs in a column, chosen, or nowhere.

/** Why an address was refused, in words an owner can act on. */
export type ContactEmailProblem =
  | "empty"
  | "no_at"
  | "no_local"
  | "no_domain"
  | "no_dot"
  | "unsafe_characters"
  | "reserved_domain"
  | "too_long";

export interface ContactEmailResult {
  /** The value to store. Null means "not configured", never a fallback. */
  value: string | null;
  problem: ContactEmailProblem | null;
}

/** RFC 5321 caps a path at 256; this is comfortably inside any real address. */
const MAX_LENGTH = 254;

/**
 * Normalise and validate an owner-supplied contact address.
 *
 * AN EMPTY BOX IS NOT AN ERROR. Clearing the field is how an owner withdraws a
 * published address, so "" returns { value: null } with no problem — that is a
 * deliberate choice, not a failed one.
 *
 * DELIBERATELY NOT A FULL RFC PARSER. Address syntax is notoriously permissive
 * and a strict regex rejects real addresses. What this refuses is the set that
 * cannot work or must not be sent: anything that could inject a mail header,
 * anything with no domain to deliver to, and the reserved TLDs
 * (.test/.invalid/.example/.localhost) whose bounces are charged to our
 * sending reputation. Everything else is the owner's business.
 *
 * PURE. No database, no environment, no clock — so every rule below is
 * provable on its own.
 */
export function normalizeContactEmail(raw: string | null | undefined): ContactEmailResult {
  if (raw == null) return { value: null, problem: null };

  const trimmed = raw.trim();
  if (trimmed.length === 0) return { value: null, problem: null };

  // ============ HEADER INJECTION, FIRST ==============================
  //
  // This value becomes a Reply-To header. A newline in it could append
  // headers of its own — a Bcc to somewhere, a second Reply-To — and the fact
  // the author is our own customer rather than an anonymous attacker does not
  // make it safe. Control characters are REFUSED rather than stripped: an
  // address containing one is not an address with a typo, and silently
  // repairing it would store something the owner never typed.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    return { value: null, problem: "unsafe_characters" };
  }
  // Whitespace inside an address is equally not a typo worth guessing at.
  if (/\s/.test(trimmed)) {
    return { value: null, problem: "unsafe_characters" };
  }
  // Commas and semicolons separate addresses. One box means one address.
  if (/[,;<>]/.test(trimmed)) {
    return { value: null, problem: "unsafe_characters" };
  }

  if (trimmed.length > MAX_LENGTH) return { value: null, problem: "too_long" };

  const at = trimmed.lastIndexOf("@");
  if (at < 0) return { value: null, problem: "no_at" };
  if (at === 0) return { value: null, problem: "no_local" };

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (domain.length === 0) return { value: null, problem: "no_domain" };
  // A second @ in the local part is not something to guess the meaning of.
  if (local.includes("@")) return { value: null, problem: "unsafe_characters" };
  if (!domain.includes(".")) return { value: null, problem: "no_dot" };
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) {
    return { value: null, problem: "no_domain" };
  }

  // THE DOMAIN LOWERCASES, THE LOCAL PART DOES NOT. Domains are
  // case-insensitive by specification; local parts are not, and quietly
  // lowercasing one can address a different mailbox on a strict server.
  const normalized = `${local}@${domain.toLowerCase()}`;

  // Reserved TLDs can never receive mail. Caught here so an owner is told
  // while they are looking at the box, rather than at send time when the
  // bounce is already ours.
  if (reservedTldOf(normalized)) {
    return { value: null, problem: "reserved_domain" };
  }

  return { value: normalized, problem: null };
}

/** What to show the owner. Plain, and never blames them for an empty box. */
export function contactEmailProblemMessage(problem: ContactEmailProblem): string {
  switch (problem) {
    case "no_at":
      return "That doesn't look like an email address — it needs an @.";
    case "no_local":
      return "That address is missing the part before the @.";
    case "no_domain":
    case "no_dot":
      return "That address is missing a valid domain after the @.";
    case "unsafe_characters":
      return "That address contains characters an email address cannot have.";
    case "reserved_domain":
      return "That domain can never receive mail, so customers could not reach you there.";
    case "too_long":
      return "That address is too long to be a real one.";
    case "empty":
      return "Enter an address, or leave it blank to remove it.";
  }
}
