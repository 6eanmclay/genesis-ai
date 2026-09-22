// WHERE THIS APPLICATION LIVES, ANSWERED ONCE.
//
// ============ WHY THIS FILE EXISTS (2026-09-22, migration phase 1) ======
//
// Two resolvers used to answer this question independently and disagree about
// it. canonicalBaseUrl() read VERCEL_PROJECT_PRODUCTION_URL only; emailOrigin()
// read NEXTAUTH_URL first and VERCEL_PROJECT_PRODUCTION_URL second. Setting
// NEXTAUTH_URL therefore moved the links in email and left the PayPal webhook
// registration pointing somewhere else — one origin, two answers, and no way
// to configure both together.
//
// That asymmetry is a real hazard during a domain migration.
// VERCEL_PROJECT_PRODUCTION_URL is not configuration — Vercel derives it from
// the SHORTEST production custom domain attached to the project. Attaching
// app.genj4.com (13 characters) to a project whose only domain is
// genesis-ai-rho.vercel.app (25) silently changes it, with no deploy and no
// commit, and every durable URL moves with it. APP_CANONICAL_URL exists so the
// application's own origin is stated rather than inferred from a string-length
// comparison nobody chose.
//
// ============ NO next/headers HERE, DELIBERATELY ========================
//
// This module imports nothing. emailOrigin() is called from the queue, which
// has no request to read, and lib/integrations/util.ts reaches next/headers at
// module scope. Keeping this dependency-free is what lets both sides share it.

/**
 * One origin, normalised: a scheme, a host, and no trailing slash.
 *
 * A bare domain becomes https. A value that already carries a scheme keeps it,
 * so http://localhost:3000 survives local development intact.
 */
function normaliseOrigin(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * The configured canonical origin for this application, or null when nothing
 * authoritative says.
 *
 * PRECEDENCE, and the reason for each step:
 *
 *   APP_CANONICAL_URL              stated by us. The only one that is a
 *                                  decision rather than an inference, so it
 *                                  wins outright.
 *   NEXTAUTH_URL                   already has to be correct for sign-in on an
 *                                  unusual proxy, so a deployment that sets it
 *                                  has said something real about its origin.
 *   VERCEL_PROJECT_PRODUCTION_URL  Vercel's own guess. Correct today, and the
 *                                  reason this file exists: it can change
 *                                  underneath us.
 *
 * NEVER VERCEL_URL. That is the per-deployment hostname, unique to one build,
 * so anything durable built from it rots the moment the next deploy lands.
 *
 * Returns null rather than a guess. A caller that cannot proceed without an
 * origin must decide for itself whether to fall back to the request or to omit
 * the link entirely — those are different right answers and this cannot pick
 * between them.
 */
export function configuredAppOrigin(): string | null {
  const stated = process.env.APP_CANONICAL_URL;
  if (stated) {
    const normalised = normaliseOrigin(stated);
    if (normalised) return normalised;
  }

  const auth = process.env.NEXTAUTH_URL;
  if (auth) {
    const normalised = normaliseOrigin(auth);
    if (normalised) return normalised;
  }

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) {
    const normalised = normaliseOrigin(vercel);
    if (normalised) return normalised;
  }

  return null;
}
