import { startTestServer } from "@/scripts/lib/testServer";
import { signIn, anonymous, patientFetch, HARNESS_PASSWORD } from "@/scripts/lib/httpSession";
import bcrypt from "bcryptjs";

// THE BOUNDARIES, OVER REAL HTTP:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-http-suites.ts" -OutFile out.txt
//
// ============ WHAT THIS ADDS THAT NOTHING ELSE HAD (2026-08-30) ========
//
// Fifteen suites already drive a real Next server, and between them they cover
// the money path thoroughly: verify-order-webhook-live posts genuinely signed
// Stripe events and proves an unsigned, wrong-secret or tampered one is refused
// with a 400, and verify-checkout-e2e walks bag to order. None of that is
// repeated here.
//
// What none of them touch is everything built since: the per-store
// authorization boundary, the platform-admin boundary, the public-API
// validation and rate limits, the upload-token routes and the cron triggers.
// All of those were proven by calling functions, and calling a function proves
// the function — not the route, the middleware, the session, or the redirect
// that a browser will actually receive.
//
// ============ AND IT USES REAL SESSIONS ==============================
//
// Signed in through NextAuth's own credentials callback, cookies kept, nothing
// forged. A minted JWT would walk past the password check, the throttle, the
// two-factor state and the password-changed-at claim — four things the sign-in
// path does and a forged cookie does not.
//
// ============ WHAT IT DELIBERATELY CANNOT DO =========================
//
// Invoke a SERVER ACTION over HTTP. An action is addressed by a build-specific
// id carried in a Next-Action header, and reconstructing that would couple this
// suite to a private detail that changes between versions. The actions'
// guards are proven at the function layer (verify-store-scope-db) and their
// PAGES are proven here — which is the same guard, reached the way a person
// reaches it. Recorded rather than papered over.

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main(): Promise<void> {
  const server = await startTestServer();
  const { baseUrl, db } = server;
  const stamp = Date.now();

  try {
    // Two owners, two businesses, neither a member of the other. The same shape
    // the cross-store defect was found in.
    const alice = await signIn({ baseUrl, db, email: `alice-${stamp}@example.test` });
    const bob = await signIn({ baseUrl, db, email: `bob-${stamp}@example.test` });
    const nobody = anonymous(baseUrl);

    const aliceStore = await db.prisma.store.create({
      data: { userId: alice.userId, name: "Alice Co", slug: `alice-${stamp}`, tagline: "t", description: "d" },
    });
    const bobStore = await db.prisma.store.create({
      data: { userId: bob.userId, name: "Bob Co", slug: `bob-${stamp}`, tagline: "t", description: "d" },
    });

    console.log("\n--- signing in is real, and it worked ---\n");
    {
      // If this is wrong, every assertion below passes anonymously and proves
      // nothing — so it is checked first and explicitly.
      const session = await alice.fetch("/api/auth/session");
      eq("a signed-in session is readable", session.status, 200);
      const body = (await session.json()) as { user?: { email?: string } };
      eq("and it is the right person", body.user?.email, alice.email);

      const anonSession = await nobody.fetch("/api/auth/session");
      // NextAuth answers a bare JSON `null` for no session, not an empty
      // object — so this is read defensively rather than destructured.
      const anonBody = (await anonSession.json().catch(() => null)) as { user?: unknown } | null;
      assert("an anonymous caller has no user", !anonBody?.user, JSON.stringify(anonBody));
    }

    console.log("\n--- the per-store boundary, over HTTP ---\n");
    {
      // ============ THE DEFECT RANK 1 CLOSED, FROM OUTSIDE ======
      //
      // Proven at the function layer already. This is the same rule reached the
      // way a person reaches it: a URL, a session, a response.
      const own = await alice.fetch(`/b/${aliceStore.slug}/products`);
      assert("an owner reaches their own business", own.status === 200, `${own.status}`);

      const theirs = await alice.fetch(`/b/${bobStore.slug}/products`);
      // notFound(), deliberately — telling somebody a business exists but is
      // not theirs is an answer they did not have.
      assert("and cannot reach somebody else's", theirs.status === 404, `${theirs.status}`);

      const madeUp = await alice.fetch(`/b/not-a-real-business-${stamp}/products`);
      eq("a business that does not exist answers the same way", madeUp.status, theirs.status);

      const anon = await nobody.fetch(`/b/${aliceStore.slug}/products`);
      assert("an anonymous caller is sent to sign in",
        anon.status === 307 || anon.status === 302, `${anon.status}`);
      assert("to the login page",
        (anon.headers.get("location") ?? "").includes("/login"), anon.headers.get("location") ?? "");

      // Several other sections of the same business, so the guard is proven
      // where it is applied rather than at one lucky route.
      for (const section of ["orders", "settings", "customers", "analytics"]) {
        const crossed = await alice.fetch(`/b/${bobStore.slug}/${section}`);
        assert(`${section} refuses the wrong owner`, crossed.status === 404, `${crossed.status}`);
      }
    }

    console.log("\n--- the platform-admin boundary, over HTTP ---\n");
    {
      // ============ NOBODY IS AN ADMIN HERE ====================
      //
      // The harness sets no PLATFORM_ADMIN_EMAILS, so the allowlist is empty
      // and fails closed. That is the production-safe default and it is what a
      // real deployment has until somebody sets one.
      const asOwner = await alice.fetch("/admin/operations");
      assert("a signed-in owner is refused the operator surface",
        asOwner.status === 307 || asOwner.status === 302, `${asOwner.status}`);
      assert("and sent to their dashboard rather than shown it",
        (asOwner.headers.get("location") ?? "").includes("/dashboard"),
        asOwner.headers.get("location") ?? "");

      const anon = await nobody.fetch("/admin/operations");
      assert("an anonymous caller is sent to sign in",
        (anon.headers.get("location") ?? "").includes("/login"), anon.headers.get("location") ?? "");

      for (const page of ["/admin", "/admin/security"]) {
        const refused = await alice.fetch(page);
        assert(`${page} refuses a non-admin too`,
          refused.status === 307 || refused.status === 302, `${refused.status}`);
      }
    }

    console.log("\n--- the public API boundary, over HTTP ---\n");
    {
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        patientFetch(new URL(path, baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: typeof body === "string" ? body : JSON.stringify(body),
          redirect: "manual",
        });

      // Shape.
      eq("a registration with no email is refused",
        (await post("/api/register", { password: HARNESS_PASSWORD })).status, 400);
      eq("a malformed email is refused",
        (await post("/api/register", { email: "nope", password: HARNESS_PASSWORD })).status, 400);
      eq("an object where an email belongs is refused",
        (await post("/api/register", { email: { contains: "@" }, password: HARNESS_PASSWORD })).status, 400);
      eq("a body that is not JSON is refused",
        (await post("/api/register", "{not json")).status, 400);

      // ============ AND THE REJECTION SAYS NOTHING BACK =========
      const leaky = await post("/api/register", { email: "nope", password: `pw-${stamp}-secret` });
      const text = await leaky.text();
      assert("the refusal never echoes the password", !text.includes(`pw-${stamp}-secret`), text.slice(0, 200));

      // Size, over a real connection with a real Content-Length.
      const huge = await post("/api/register", { email: `big-${stamp}@example.test`, password: "x".repeat(200_000) });
      assert("an enormous body is refused", huge.status === 413 || huge.status === 400, `${huge.status}`);

      // A real registration still works.
      const good = await post("/api/register", {
        email: `newuser-${stamp}@example.test`, password: HARNESS_PASSWORD, name: "New",
      });
      eq("a valid registration succeeds", good.status, 201);

      // ============ THE RATE LIMIT, FOR REAL ==================
      //
      // Ten per address per fifteen minutes. Everything above came from the
      // same address, so the window is already part-used — which is the point:
      // the limiter counts every attempt, not only the successful ones.
      let refused = 0;
      for (let i = 0; i < 16; i++) {
        const res = await post("/api/register", {
          email: `flood-${i}-${stamp}@example.test`, password: HARNESS_PASSWORD,
        });
        if (res.status === 429) {
          refused++;
          if (refused === 1) {
            assert("and says how long to wait", !!res.headers.get("retry-after"),
              JSON.stringify([...res.headers]));
          }
        }
      }
      assert("a registration flood is refused over HTTP", refused > 0, `${refused} refusals`);

      const created = await db.prisma.user.count({ where: { email: { contains: `flood-` } } });
      assert("and fewer accounts exist than were attempted", created < 16, `${created}`);
    }

    console.log("\n--- the upload-token routes, over HTTP ---\n");
    {
      // These mint a token authorising a billed write. The authorization is
      // inside the handler, so this proves the route as deployed rather than
      // the function as called.
      for (const path of ["/api/blob/product-image-upload", "/api/blob/business-asset-upload"]) {
        const anon = await patientFetch(new URL(path, baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "blob.generate-client-token", payload: { pathname: "x.png" } }),
          redirect: "manual",
        });
        assert(`${path} refuses an anonymous caller`,
          anon.status === 401 || anon.status >= 400, `${anon.status}`);
      }
    }

    console.log("\n--- the scheduler triggers, over HTTP ---\n");
    {
      // ============ THE SECRET IS THE WHOLE CONTROL ============
      //
      // These run every scheduled task on the platform. A wrong answer here is
      // an unauthenticated stranger triggering connector syncs, sourcing runs
      // and the job queue.
      for (const path of ["/api/cron/sync", "/api/cron/tick", "/api/cron/status"]) {
        const none = await patientFetch(new URL(path, baseUrl), { redirect: "manual" });
        eq(`${path} refuses a request with no secret`, none.status, 401);

        const wrong = await patientFetch(new URL(path, baseUrl), {
          headers: { authorization: "Bearer definitely-not-the-secret" },
          redirect: "manual",
        });
        eq(`${path} refuses a wrong secret`, wrong.status, 401);

        // A signed-in owner is not an operator either — the session is
        // irrelevant here, and proving that stops somebody "fixing" it later by
        // adding a session check instead of the secret.
        const asOwner = await alice.fetch(path);
        eq(`${path} refuses a signed-in owner`, asOwner.status, 401);
      }

      // And the right secret works — the harness sets its own, which is only
      // ever valid for this server.
      const authorized = await patientFetch(new URL("/api/cron/status", baseUrl), {
        headers: { authorization: "Bearer harness-cron-secret-not-a-real-one" },
        redirect: "manual",
      });
      eq("the right secret is accepted", authorized.status, 200);
    }

    console.log("\n--- the PayPal return boundary, as far as it goes locally ---\n");
    {
      // ============ WHAT CAN BE PROVEN WITHOUT PAYPAL ==========
      //
      // Not the capture: that is a live API call against a merchant's
      // credentials, and nothing here fakes one. What CAN be proven is the
      // boundary in front of it — the query validation added in Item 3 — and
      // that a malformed return never reaches a database lookup.
      const bad = await patientFetch(
        new URL(`/api/checkout/paypal/return?token=ok&slug=${encodeURIComponent("../../etc/passwd")}`, baseUrl),
        { redirect: "manual" },
      );
      assert("a malformed PayPal return redirects rather than querying",
        bad.status === 307 || bad.status === 302, `${bad.status}`);
      const location = bad.headers.get("location") ?? "";
      assert("and never builds a URL from the bad slug", !location.includes("etc/passwd"), location);

      const missing = await patientFetch(new URL("/api/checkout/paypal/return", baseUrl), { redirect: "manual" });
      assert("a return with no parameters is refused the same way",
        missing.status === 307 || missing.status === 302, `${missing.status}`);
    }

    console.log("\n--- the storefront is public, and stays scoped ---\n");
    {
      // The other side of the authorization boundary: a storefront is meant to
      // be readable by anybody, and an assertion suite that only proves refusal
      // could pass on a platform that refused everything.
      await db.prisma.store.update({ where: { id: aliceStore.id }, data: { published: true } });
      const shop = await nobody.fetch(`/store/${aliceStore.slug}`);
      assert("an anonymous visitor can read a published storefront",
        shop.status === 200, `${shop.status}`);
    }

    console.log("\n--- a real session cannot be forged by guessing ---\n");
    {
      // A cookie that looks right and is not signed must not authenticate.
      const forged = await patientFetch(new URL("/api/auth/session", baseUrl), {
        headers: { cookie: "authjs.session-token=not-a-real-token; __Secure-authjs.session-token=nope" },
      });
      const body = (await forged.json().catch(() => null)) as { user?: unknown } | null;
      assert("a forged session cookie authenticates nobody", !body?.user, JSON.stringify(body));

      // And the wrong password does not sign in.
      const email = `wrongpw-${stamp}@example.test`;
      await db.prisma.user.create({
        data: { email, password: await bcrypt.hash(HARNESS_PASSWORD, 10) },
      });
      let signedIn = true;
      await signIn({ baseUrl, db, email, password: "definitely-the-wrong-password", userId: "x" })
        .catch(() => { signedIn = false; });
      assert("the wrong password does not produce a session", !signedIn);
    }
  } finally {
    await server.close();
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
