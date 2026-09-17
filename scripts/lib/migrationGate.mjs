// WHETHER A BUILD IS ALLOWED TO MIGRATE PRODUCTION.
//
// ============ U7, DECIDED BY SEAN 2026-09-17 ==========================
//
// "Reinstate the review gate before production migrations. I do not want schema
// migrations reaching production automatically without a review checkpoint."
//
// ============ THE HISTORY THIS HAS TO RESPECT =========================
//
// This is the third position the project has held, and the previous two each
// failed in a different direction:
//
//   5002093 (2026-08-01) removed `prisma migrate deploy` from the build
//   entirely. Correct about the risk, and it left a second one: a push whose
//   code needs a new column BUILDS FINE and then fails at runtime, because
//   nothing notices the migration was never applied.
//
//   a2a05bf (2026-08-13) put automatic migrations back, which fixed that and
//   removed the review step. Neither commit updated DEPLOYMENT.md, so the docs
//   described a gate that was not there for a week — COMPLIANCE.md §46.
//
// So a gate that only REFUSES recreates the 5002093 hole. This one refuses AND
// FAILS THE BUILD, which is the safe direction: production keeps serving the
// previous deployment, unchanged, until a person applies the migration
// deliberately. Nothing is half-applied and nothing is silently missing.
//
// ============ THE AUTHORISATION NAMES WHAT IT AUTHORISES ==============
//
// ALLOW_PRODUCTION_MIGRATION is not a boolean. It must equal the exact set of
// migrations currently pending, so it cannot sit switched on and wave through
// whatever arrives next week — which is the failure mode of every "set a flag
// to allow it" gate. Authorising one migration authorises exactly that one.
//
// PURE, so it can be tested without a database, a build, or Vercel. The script
// that calls it supplies the three facts; every judgement is here.

/** The variable that carries a deliberate, named authorisation. */
export const ALLOW_VARIABLE = "ALLOW_PRODUCTION_MIGRATION";

/**
 * What a build should do about pending migrations.
 *
 * @param {object} input
 * @param {string|undefined} input.vercelEnv  VERCEL_ENV: production | preview | development
 * @param {string|undefined} input.allow      the raw ALLOW_PRODUCTION_MIGRATION value
 * @param {string[]} input.pending            migration names not yet applied
 * @returns {{action: "migrate"|"skip"|"refuse", why: string}}
 */
export function migrationDecision({ vercelEnv, allow, pending }) {
  const names = [...pending].sort();

  // ONLY PRODUCTION IS GATED. Preview and local builds migrate exactly as they
  // always have — the risk this exists for is real customer and order data, and
  // a throwaway preview database has none. Gating them would make the gate
  // something people learn to work around.
  if (vercelEnv !== "production") {
    return { action: "migrate", why: `VERCEL_ENV=${vercelEnv ?? "(unset)"} — not a production deploy` };
  }

  if (names.length === 0) {
    return { action: "skip", why: "no migration is pending" };
  }

  const authorised = (allow ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();

  if (authorised.length === 0) {
    return {
      action: "refuse",
      why: `${names.length} migration(s) pending and no authorisation given`,
    };
  }

  // EXACT SET EQUALITY, both directions. Authorising A while B is also pending
  // must not apply B, and an authorisation naming a migration that is not
  // pending is a stale value from a previous deploy rather than consent for
  // this one.
  const same =
    authorised.length === names.length && authorised.every((name, i) => name === names[i]);

  if (!same) {
    return {
      action: "refuse",
      why: `authorisation does not match what is pending — authorised [${authorised.join(", ")}], pending [${names.join(", ")}]`,
    };
  }

  return { action: "migrate", why: `explicitly authorised: ${names.join(", ")}` };
}

/**
 * What the build prints when it refuses. The whole value of the gate is here:
 * a refusal nobody can act on just gets the gate removed again.
 */
export function refusalMessage({ pending, why }) {
  const names = [...pending].sort();
  return [
    "",
    "======================================================================",
    "  REFUSING TO MIGRATE PRODUCTION — the review gate is in place (U7).",
    "======================================================================",
    "",
    `  ${why}`,
    "",
    "  Pending:",
    ...names.map((n) => `    - ${n}`),
    "",
    "  Production has NOT been changed and is still serving the previous",
    "  deployment. Nothing is half-applied.",
    "",
    "  To apply these deliberately, after reading the SQL:",
    "",
    "    1. Review each migration.sql above.",
    "    2. Apply them against production yourself:",
    "",
    "         npm run migrate:deploy",
    "",
    "    3. Re-deploy. With nothing pending, this build proceeds on its own.",
    "",
    `  Or authorise exactly these in Vercel and redeploy, naming them:`,
    "",
    `         ${ALLOW_VARIABLE}=${names.join(",")}`,
    "",
    "    That value authorises THESE migrations and no others — a stale flag",
    "    cannot wave through whatever is pending next time.",
    "",
    "======================================================================",
    "",
  ].join("\n");
}
