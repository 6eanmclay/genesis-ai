import { startTestServer } from "@/scripts/lib/testServer";
import { HARNESS_PASSWORD } from "@/scripts/lib/httpSession";
import { normalizeEmail } from "@/lib/auth/normalizeEmail";
import bcrypt from "bcryptjs";

// ONE ADDRESS, ONE ACCOUNT (E11):
//
//   npx tsx scripts/run-http-suites.ts email-normalization
//
// ============ WHY THIS BRINGS A REAL SERVER =========================
//
// Both halves of this fix live behind a request scope. Registration is a route
// handler; sign-in is NextAuth's credentials callback. Calling either as a
// function throws outside a request, which is the same wall
// verify-approval-recovery.ts and verify-approval-drift-db.ts hit — so the
// only honest way to prove an account can be signed into with capitals it was
// not created with is to actually POST the sign-in.
//
// ============ THE PROPERTY THAT MATTERS, AND ITS PRECONDITION =======
//
// Normalising the LOOKUP means a stored address is now found by its normalised
// form. That is the fix, and it is also the risk: a row stored with capitals
// would stop being reachable. The August attempt was reverted for exactly this
// reason, and reverting was right.
//
// What made it safe to do now is a measurement, not an argument. Production
// holds 40 accounts, 0 with any uppercase character and 0 case-insensitive
// collisions, so every stored row already equals its own normalised form and
// none of them changes meaning. Section 3 states the limit that measurement
// bought, rather than pretending it does not exist.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passes++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    failed.push(label);
    console.log(`  FAIL  ${label}  — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(label: string, ok: boolean, detail = ""): void {
  check(label + (detail ? `  [${detail}]` : ""), ok, true);
}

/** Sign in over real HTTP, exactly as the login form does. Returns whether it worked. */
async function canSignIn(baseUrl: string, email: string, password: string): Promise<boolean> {
  const csrfResponse = await fetch(new URL("/api/auth/csrf", baseUrl));
  const cookies = (csrfResponse.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const jar = cookies.map((c) => c.split(";")[0]).join("; ");
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const response = await fetch(new URL("/api/auth/callback/credentials", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar },
    body: new URLSearchParams({ email, password, csrfToken, callbackUrl: baseUrl, json: "true" }).toString(),
    redirect: "manual",
  });
  const setCookies = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  // A real session cookie is the only honest signal. NextAuth answers 200 with
  // a url either way, so reading the status would pass for a refused sign-in.
  return setCookies.some((c) => /authjs\.session-token|next-auth\.session-token/.test(c));
}

async function main() {
  console.log("Starting a real Next server on a real Postgres. First compile takes a while.\n");
  const server = await startTestServer();
  const prisma = server.db.prisma;
  const stamp = Date.now();

  try {
    // -------------------------------------------------------------------
    console.log("\n1. An account is reachable with capitals it was not created with\n");
    // -------------------------------------------------------------------
    //
    // THE WHOLE POINT. Stored lowercase, as every real row is; typed however
    // the person happens to type it that day. Before this change the lookup
    // was literal and the second and third of these failed.
    const lower = `norm-${stamp}@example.test`;
    await prisma.user.create({
      data: { email: lower, name: "Harness", password: await bcrypt.hash(HARNESS_PASSWORD, 10) },
    });

    assert("signing in exactly as stored works", await canSignIn(server.baseUrl, lower, HARNESS_PASSWORD));
    assert("signing in with capitals works", await canSignIn(server.baseUrl, lower.toUpperCase(), HARNESS_PASSWORD));
    assert("signing in with surrounding whitespace works",
      await canSignIn(server.baseUrl, `  ${lower}  `, HARNESS_PASSWORD));

    // THE CONTROL. A refusal has to still be possible, or every assertion
    // above passes for a sign-in that never checks anything.
    assert("a wrong password is still refused",
      (await canSignIn(server.baseUrl, lower, "not-the-password-at-all")) === false);
    assert("an address with no account is still refused",
      (await canSignIn(server.baseUrl, `nobody-${stamp}@example.test`, HARNESS_PASSWORD)) === false);

    // -------------------------------------------------------------------
    console.log("\n2. Registration stores one form, whatever is typed\n");
    // -------------------------------------------------------------------
    const typed = `Mixed-${stamp}@Example.Test`;
    const registerResponse = await fetch(new URL("/api/register", server.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Mixed Case", email: typed, password: HARNESS_PASSWORD }),
    });
    check("the registration is accepted", registerResponse.status, 201);

    const stored = await prisma.user.findFirst({
      where: { email: { contains: `mixed-${stamp}`, mode: "insensitive" } },
      select: { email: true },
    });
    check("and it is stored normalised, not as typed", stored?.email, normalizeEmail(typed));

    // AND THE ACCOUNT WORKS. Storing normalised is only half of it — the
    // person still has to be able to get in, typing it their way.
    assert("the new account signs in with the capitals its owner typed",
      await canSignIn(server.baseUrl, typed, HARNESS_PASSWORD));

    // -------------------------------------------------------------------
    console.log("\n3. The same address cannot become two accounts\n");
    // -------------------------------------------------------------------
    //
    // The defect itself, stated as behaviour. The existing @unique constraint
    // is what enforces it — no index was needed, because both registrations
    // now write the same string.
    const again = await fetch(new URL("/api/register", server.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Same Person", email: typed.toUpperCase(), password: HARNESS_PASSWORD }),
    });
    check("registering the same address in different capitals is refused", again.status, 400);

    const count = await prisma.user.count({
      where: { email: { contains: `mixed-${stamp}`, mode: "insensitive" } },
    });
    check("and exactly one account exists for it", count, 1);

    // -------------------------------------------------------------------
    console.log("\n4. What this deliberately does NOT do\n");
    // -------------------------------------------------------------------
    //
    // Provider-specific folding would silently merge addresses their owner
    // keeps separate. A plus-tag is how a real person routes their own mail.
    check("a plus-tag survives", normalizeEmail("a+work@x.com"), "a+work@x.com");
    check("gmail dots survive", normalizeEmail("first.last@gmail.com"), "first.last@gmail.com");

    // AND THE LIMIT THE MEASUREMENT BOUGHT, asserted rather than implied: a
    // row stored WITH capitals is not reachable by the normalised lookup.
    // Production has none — that is why this shipped — and if one ever
    // appears, this is the behaviour it will have.
    const mixedStored = `Legacy-${stamp}@Example.Test`;
    await prisma.user.create({
      data: { email: mixedStored, name: "Legacy", password: await bcrypt.hash(HARNESS_PASSWORD, 10) },
    });
    assert("a row stored with capitals is NOT reachable — the known limit",
      (await canSignIn(server.baseUrl, mixedStored, HARNESS_PASSWORD)) === false,
      "production held 0 such rows when this shipped");
  } finally {
    await server.close();
  }

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ${f}`);
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
