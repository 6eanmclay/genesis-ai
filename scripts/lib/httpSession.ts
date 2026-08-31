import bcrypt from "bcryptjs";
import type { RealPostgres } from "./realPostgres";

// A REAL SIGNED-IN SESSION, OVER HTTP.
//
// ============ WHAT WAS MISSING (2026-08-30) ============================
//
// Fifteen suites already drive a real Next server, and every one that needed a
// session got it by driving a BROWSER — Playwright, a login form, a click. That
// is the right tool for testing a screen and the wrong one for testing an
// authorization boundary: starting Chromium to find out whether a route answers
// 404 to the wrong account is slow, flaky, and tests the form as much as the
// rule.
//
// So this signs in the way the browser does and stops there: it posts real
// credentials to NextAuth's own credentials callback and keeps the cookies it
// gets back. Everything after that is ordinary fetch with a cookie jar.
//
// ============ NOTHING HERE FORGES A SESSION ===========================
//
// It would have been easy to mint a JWT with AUTH_SECRET and skip the round
// trip. That would test a token this codebase's own sign-in never produced,
// and the thing under test IS the sign-in path — the credentials provider
// checks the password, the throttle, the two-factor state and the
// password-changed-at claim. A forged cookie walks past all four.
//
// The one concession is the password: it is written directly as a bcrypt hash
// when the user is created, because the alternative is going through
// /api/register, which is rate limited by design and would make a suite that
// creates twelve users fail on its eleventh.

export interface HttpSession {
  /** Fetch with this session's cookies attached. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  userId: string;
  email: string;
  /** The raw cookie header, for a caller that needs to build its own request. */
  cookieHeader(): string;
}

// ============ A DEV SERVER COMPILES ON DEMAND (2026-08-30) =============
//
// `next dev` builds each route the first time it is asked for, and a heavy
// dashboard section can take a long while. Node's fetch gives up on headers
// before that finishes, which surfaced as `HeadersTimeoutError` on the sixth
// page of a suite whose first five had passed — a failure with nothing to do
// with the code under test.
//
// So requests get a generous ceiling and one retry. This changes no assertion:
// a route that answers 404 still answers 404, and a route that never answers at
// all still fails the suite. It only stops the harness reporting a compiler as
// a defect.
const REQUEST_TIMEOUT_MS = 120_000;

export async function patientFetch(url: URL | string, init: RequestInit = {}): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      lastError = error;
      // Only a transport failure is retried. A response — any response — is an
      // answer and is returned above.
    }
  }
  throw new Error(
    `no answer from ${String(url)} after two attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** An anonymous caller, for the other half of every authorization assertion. */
export function anonymous(baseUrl: string): HttpSession {
  return {
    userId: "",
    email: "",
    cookieHeader: () => "",
    fetch: (path, init) => patientFetch(new URL(path, baseUrl), { ...init, redirect: "manual" }),
  };
}

/** A cookie jar that survives the redirects a sign-in performs. */
class Jar {
  private cookies = new Map<string, string>();

  absorb(response: Response): void {
    // getSetCookie is the only correct way to read multiple Set-Cookie headers;
    // `get` collapses them into one string and NextAuth sends several.
    const raw = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  has(nameFragment: string): boolean {
    return [...this.cookies.keys()].some((k) => k.includes(nameFragment));
  }
}

export interface SignInOptions {
  baseUrl: string;
  db: RealPostgres;
  email: string;
  password?: string;
  name?: string;
  /** Reuse an existing user rather than creating one. */
  userId?: string;
}

/** A password every harness user shares. Long enough for the real policy. */
export const HARNESS_PASSWORD = "harness-password-long-enough-1";

/**
 * Create a user and sign them in, returning a session that carries its cookies.
 *
 * Throws rather than returning a broken session: a suite that silently
 * continued unauthenticated would assert "the route refused me" and pass for
 * entirely the wrong reason, which is the failure mode this whole lane exists
 * to remove.
 */
export async function signIn(options: SignInOptions): Promise<HttpSession> {
  const { baseUrl, db, email } = options;
  const password = options.password ?? HARNESS_PASSWORD;

  const userId =
    options.userId ??
    (
      await db.prisma.user.create({
        data: { email, name: options.name ?? "Harness User", password: await bcrypt.hash(password, 10) },
      })
    ).id;

  const jar = new Jar();

  // NextAuth wants its CSRF token first, and the token is half a pair: the
  // cookie and the form field must match. Fetching it also seeds the jar.
  const csrfResponse = await fetch(new URL("/api/auth/csrf", baseUrl));
  jar.absorb(csrfResponse);
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const form = new URLSearchParams({ email, password, csrfToken, callbackUrl: baseUrl, json: "true" });
  const signInResponse = await fetch(new URL("/api/auth/callback/credentials", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: form.toString(),
    // Manual, so the Set-Cookie on the redirect is read rather than followed.
    redirect: "manual",
  });
  jar.absorb(signInResponse);

  if (!jar.has("session-token")) {
    throw new Error(
      `signIn(${email}) did not produce a session cookie (status ${signInResponse.status}). ` +
        "A suite continuing here would prove nothing: every authorization assertion would pass anonymously.",
    );
  }

  return {
    userId,
    email,
    cookieHeader: () => jar.header(),
    fetch: (path, init = {}) =>
      patientFetch(new URL(path, baseUrl), {
        ...init,
        headers: { ...(init.headers ?? {}), cookie: jar.header() },
        // Manual throughout: a redirect IS the answer for most of the
        // authorization boundaries here, and following it would replace the
        // fact under test with whatever the destination happens to say.
        redirect: "manual",
      }),
  };
}
