// ONE ADDRESS, ONE ACCOUNT.
//
// ============ THE DEFECT THIS CLOSES (E11) ==========================
//
// `User.email` is `@unique` and nothing normalised it on either side, so
// `Sean@example.com` and `sean@example.com` were two separate accounts — each
// signable into only with the capitalisation its owner originally typed.
// Nobody was locked out, because both sides were equally literal, which is
// exactly why it had gone unnoticed.
//
// ============ WHY IT IS SAFE TO DO NOW, AND WAS NOT BEFORE ==========
//
// The register route's own comment records the earlier attempt and why it was
// reverted: lowercasing on write alone would have locked out every existing
// mixed-case user, because the sign-in lookup stayed literal. That reasoning
// was right. What was missing was the measurement.
//
// Measured against the production database 2026-09-02, read-only, which is
// step 1 of the plan EXTERNAL_BLOCKERS.md E11 laid out:
//
//   40 accounts
//    0 stored with any uppercase character
//    0 case-insensitive collisions
//    0 with leading or trailing whitespace
//
// So there is no collision to decide about — E11's step 2 has nothing in it —
// and no existing row changes meaning under normalisation, because every
// stored address already equals its own normalised form. Both sides can
// therefore change in the same deploy, which is what that entry required.
//
// ============ NO MIGRATION, AND NONE NEEDED =========================
//
// The plan also called for a case-insensitive unique index. It is not needed
// for correctness once writes normalise: two registrations differing only by
// case now write the SAME string, and the existing `@unique` constraint
// refuses the second. An expression index would only defend against a future
// caller that forgets to normalise — which is what
// verify-email-normalization.ts asserts instead, against source, so the
// guarantee lives somewhere a schema change cannot silently drift from.

/**
 * The one form of an address this platform stores and searches by.
 *
 * TRIM THEN LOWERCASE, and nothing else. Deliberately NOT "smart": no
 * stripping of Gmail dots, no cutting `+tags`. Those are provider-specific
 * policies, they are not universally true, and treating `a+work@x.com` as
 * `a@x.com` would silently merge two addresses their owner considers separate.
 * Case-insensitivity is different — the domain half is case-insensitive by
 * RFC 1035, and no real mail provider treats the local half as case-sensitive.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
