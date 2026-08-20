// What counts as an acceptable password (2026-08-20).
//
// Found during the production-readiness audit: there was no requirement at all.
// Signup checked `if (!email || !password)` and the reset flow checked nothing,
// so "a" was a valid password on a platform that holds merchants' connected
// Stripe accounts and takes real customer payments.
//
// The rules follow NIST SP 800-63B, which is deliberately unfashionable about
// this: length is what matters, composition rules ("one uppercase, one symbol")
// are counterproductive because they push people toward Password1! and away
// from long passphrases, and forced rotation makes things worse. So there are
// exactly three rules, and each one exists for a stated reason.

/** NIST's floor. Shorter than this is not defensible; longer is not imposed. */
export const MIN_LENGTH = 8;

/**
 * bcrypt only hashes the first 72 BYTES of input and silently ignores the rest,
 * so beyond that two different passwords become the same password. That is a
 * property of the algorithm, not a policy choice, and pretending otherwise
 * would mean quietly accepting a password that is not the one being stored.
 * Measured in bytes, not characters — an emoji is four.
 */
export const MAX_BYTES = 72;

/**
 * The handful that appear at the top of every breach corpus. Deliberately tiny:
 * a real implementation checks against a large breached-password set (Have I
 * Been Pwned's k-anonymity range API is the usual choice), and that is recorded
 * as an external dependency in COMPLIANCE.md rather than faked with a longer
 * hardcoded list that would look thorough and prove nothing.
 */
const OBVIOUS = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyui",
  "qwerty123",
  "iloveyou",
  "admin123",
  "letmein1",
  "welcome1",
  "abc12345",
  "football",
  "baseball",
  "sunshine",
  "princess",
  "trustno1",
]);

export type PasswordProblem =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Judge a candidate password — pure.
 *
 * The message is shown to a person mid-signup, so it says what to do rather
 * than what they did wrong.
 */
export function checkPassword(password: string): PasswordProblem {
  if (password.length < MIN_LENGTH) {
    return {
      ok: false,
      message: `Use at least ${MIN_LENGTH} characters. A few words together works well and is easier to remember than a short complicated one.`,
    };
  }

  // Byte length, because bcrypt counts bytes.
  if (Buffer.byteLength(password, "utf8") > MAX_BYTES) {
    return {
      ok: false,
      message: `That password is too long to be stored safely — keep it under ${MAX_BYTES} bytes (about ${MAX_BYTES} characters, fewer if you use emoji or accents).`,
    };
  }

  if (OBVIOUS.has(password.toLowerCase())) {
    return {
      ok: false,
      message: "That's one of the most commonly used passwords, so it's one of the first anyone would try. Please pick something else.",
    };
  }

  return { ok: true };
}
