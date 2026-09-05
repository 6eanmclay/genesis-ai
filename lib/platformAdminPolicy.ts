// WHO IS A PLATFORM ADMINISTRATOR — THE DECISION, WITH NOTHING AROUND IT.
//
// ============ WHY IT IS ITS OWN FILE (2026-08-30) ======================
//
// This is the entire platform-level authorization rule, and it was private,
// untested, and inside a module that begins `import "server-only"` — which
// cannot resolve under tsx, so nothing in the verification harness could reach
// it. An untestable authorization decision is exactly the one worth testing:
// a bug here is not a page rendering wrongly, it is who counts as an operator.
//
// So the rule moved to a file with no server dependency at all. lib/platformAdmin
// keeps the session-reading wrappers and re-exports this, so there is still one
// implementation and callers need not know it moved.
//
// ============ IT FAILS CLOSED, AND THAT IS THE POINT ==================
//
// Every uncertain case returns false: no email, a blank email, an unset
// variable, a list of empty entries. An unconfigured deployment therefore has
// NO platform administrator, rather than every signed-in user being one — which
// is the direction this has to fail.

/**
 * Whether an email is on a platform-admin allowlist.
 *
 * Case- and whitespace-insensitive on both sides, because real allowlists are
 * typed by hand into an environment variable and a stray space must not decide
 * who operates the platform. Matching is EXACT after that normalisation: a
 * prefix or a lookalike domain is not a match.
 */
export function isAllowedPlatformAdmin(
  email: string | null | undefined,
  allowlist: string,
): boolean {
  const normalised = email?.trim().toLowerCase();
  if (!normalised) return false;

  const allowed = new Set(
    allowlist.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean),
  );

  // ============ TWO OF THESE THREE LINES ARE REDUNDANT ================
  //
  // Sabotage found it, and it is recorded rather than papered over. Removing
  // `.filter(Boolean)` alone, or `if (allowed.size === 0)` alone, changes no
  // result — because the empty-email return above already refuses the only
  // input a blank entry could ever match, and `Set.has` on an empty set is
  // already false.
  //
  // They are kept as belt-and-braces: removing BOTH the empty-email return and
  // the filter admits anybody through a trailing comma, which is a real and
  // very quiet hole. But no test can prove either line alone, so this comment
  // is the honest record instead of an assertion that would pass regardless.
  //
  // THE LINE THAT CARRIES THE RULE is the exact match below. Loosen it to a
  // substring and `ops@genesis.test.evil.com` becomes an operator — that break
  // is caught by the suite, and it is the one that matters.
  if (allowed.size === 0) return false;

  return allowed.has(normalised);
}

/**
 * Whether an email belongs to a platform operator, ACCORDING TO THIS
 * DEPLOYMENT'S CONFIGURED ALLOWLIST.
 *
 * ============ WHY THE ENVIRONMENT READ MOVED HERE (2026-09-05) =========
 *
 * The allowlist had exactly one reader, lib/platformAdmin.ts, and an invariant
 * in verify-authorization-family-db holding it that way: two implementations of
 * one authorization decision agree until the day they do not, and the drifted
 * one is the copy nobody is reading.
 *
 * Then the Growth Points ledger needed the same answer about a STORE OWNER
 * rather than about whoever is signed in, and could not get it. Not for want of
 * trying: lib/platformAdmin begins `import "server-only"`, which does not
 * resolve under tsx, and the ledger is exercised by several verification suites
 * that run there. So the ledger read the variable itself, and the invariant
 * caught it — correctly. The check was right and the second reader was wrong.
 *
 * The fix is not a second reader with a comment promising to keep it in step.
 * The question "is this email an operator?" is one question, so it gets one
 * answer, in the module that already holds the rule and that anything can
 * import. lib/platformAdmin keeps what is genuinely its own: reading the
 * session, redirecting, and recording refusals.
 *
 * TAKES THE EMAIL RATHER THAN FINDING ONE. The ledger's caller may be a cron
 * run, a webhook, or a queued job, where there is no session at all — and those
 * execute real work that costs real points. An entitlement that only held while
 * somebody was looking at a screen would fail exactly when it matters.
 */
export function isPlatformAdminEmail(email: string | null | undefined): boolean {
  return isAllowedPlatformAdmin(email, process.env.PLATFORM_ADMIN_EMAILS ?? "");
}
