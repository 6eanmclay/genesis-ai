// THE THREE VERIFICATION STATES.
//
// Decided 2026-08-24, VERIFICATION_HARDENING_CONTRACT.md §3. Verification state
// is SEPARATE from ExecutionStatus and there is deliberately no fourth status:
// "we could not check" does not belong in the same field as "it did not work".
//
//   Verified                  execution succeeded and verification confirmed
//                             the expected state.
//   Verification failed       execution succeeded far enough to attempt
//                             verification, and it did not confirm.
//   Verification unavailable  execution succeeded, but meaningful verification
//                             could not be performed because the mechanism or
//                             provider it would need is unavailable.
//
// THE LINE THAT MAKES THIS WORTH HAVING. "Unavailable" describes the MECHANISM,
// never the developer. An executable nobody wrote a check for is not
// unavailable — it is a defect, and `verify` is a REQUIRED member of Executable
// so that omission cannot compile. If omission could present as unavailable,
// this state would just be the old `verified: false` wearing a better name: one
// label covering both "we checked and can't" and "we never looked".
//
// HOW THE THREE ARE PERSISTED, without a new column. ExecutionLog already
// carries `status` and `verified`, and once omission is impossible the pair is
// unambiguous:
//
//   SUCCESS + verified true    Verified
//   WARNING + verified false   Verification failed
//   SUCCESS + verified false   Verification unavailable
//
// The reason travels in metadata rather than in a second label, because
// permanent unavailability (a provider with no read-back API) and transient
// unavailability (a credential absent today) are different facts for us and the
// same fact for the owner.

/** What a `verify()` returns. */
export type VerificationOutcome =
  | { state: "verified" }
  /**
   * Verification ran and did not confirm.
   *
   * `mismatches` names WHICH fields did not land, never a bare boolean —
   * `refineStorefront` set that pattern, and it is what lets a WARNING tell the
   * owner something specific instead of "something went wrong".
   */
  | { state: "failed"; mismatches: string[] }
  /**
   * Verification could not be performed. The reason is recorded, and must
   * describe the mechanism — "EasyPost exposes no read-back for a purchased
   * label", not "not implemented yet".
   */
  | { state: "unavailable"; reason: string };

export const verified = (): VerificationOutcome => ({ state: "verified" });

/** Confirmed when nothing failed to land, and specific about it when something did. */
export function verifiedUnless(mismatches: string[]): VerificationOutcome {
  return mismatches.length === 0 ? { state: "verified" } : { state: "failed", mismatches };
}

export function unavailable(reason: string): VerificationOutcome {
  return { state: "unavailable", reason };
}

/**
 * One field's worth of read-back.
 *
 * Returns a mismatch description, or null when the stored value is what was
 * asked for. Deliberately compares with JSON equality: these are scalars and
 * plain JSON blueprints, and reference equality would report every object as a
 * mismatch.
 */
export function mismatch(field: string, expected: unknown, actual: unknown): string | null {
  if (stable(expected ?? null) === stable(actual ?? null)) return null;
  return `${field}: expected ${short(expected)}, stored ${short(actual)}`;
}

/**
 * JSON with its object keys sorted, at every depth.
 *
 * KEY ORDER IS NOT MEANING, AND POSTGRES AGREES LOUDLY. jsonb does not preserve
 * insertion order — it stores keys sorted by length and then bytewise — so a
 * theme written as {colors, typography} comes back in whatever order jsonb
 * chose. A plain JSON.stringify comparison therefore reported a perfectly good
 * write as a mismatch.
 *
 * Found by the read-back suite failing on updateTheme, which is what that suite
 * is for: the first version of this function was wrong in exactly the way a
 * source-level assertion could never have noticed.
 */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

/**
 * Only the keys the input actually named.
 *
 * THE CLASS B RULE, and the one most likely to be got wrong. A merge write
 * updates a blueprint or a theme by folding the input into what is already
 * there, so comparing the whole stored object against the input would report
 * every untouched key as a mismatch and fail a write that did exactly what it
 * promised. `undefined` means "not named"; `null` is a real value a caller may
 * legitimately be setting.
 */
export function namedKeyMismatches(
  // `object`, not Record<string, unknown>: every executable input is a declared
  // interface, and an interface has no index signature, so the narrower type
  // would have forced a cast at every call site rather than here once.
  input: object,
  stored: Record<string, unknown> | null | undefined,
  prefix = ""
): string[] {
  const out: string[] = [];
  for (const [key, expected] of Object.entries(input as Record<string, unknown>)) {
    if (expected === undefined) continue;
    const m = mismatch(`${prefix}${key}`, expected, stored?.[key]);
    if (m) out.push(m);
  }
  return out;
}

function short(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return s === undefined ? "undefined" : s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/**
 * What the owner reads, from what was actually recorded.
 *
 * The three states are carried by the (status, verified) pair rather than a new
 * column, and this is the one place that decodes them — so the wording cannot
 * drift between surfaces.
 *
 * "Verification unavailable" is deliberately not phrased as a problem. A
 * shipping label that was genuinely bought is not broken because this platform
 * cannot re-read the carrier's copy of it, and language implying otherwise
 * would be its own kind of dishonesty.
 */
export function verificationLabel(status: string, isVerified: boolean): string | null {
  if (status === "WARNING") return "Verification failed";
  if (status !== "SUCCESS") return null;
  return isVerified ? "Verified" : "Verification unavailable";
}
