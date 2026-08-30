import "@/scripts/lib/allowServerOnly";

import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { guard, DEFAULT_MAX_BYTES } from "@/lib/http/guard";
import { checkRateLimit, bucketFor } from "@/lib/http/rateLimit";
import { clientIp, addressLabel } from "@/lib/http/clientIp";
import { SIGNAL_KINDS } from "@/lib/security/signals";
import { z } from "zod";

// THE PUBLIC BOUNDARY:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts http-boundary-db
//
// ============ REAL REQUESTS, NOT SOURCE INSPECTION (2026-08-30) ========
//
// Sean: "I want the audit to prove that removing each important protection
// actually allows the bad request through, rather than tests that merely
// inspect source text."
//
// So every assertion here builds a real Request and calls the real handler or
// the real guard, and the sabotage pass removes each protection and watches the
// bad request succeed. Nothing here greps a file for the word "zod".
//
// ============ WHAT THE BOUNDARY IS FOR ================================
//
// Not correctness — the handlers were already careful about what they did with
// what they got. It is about what it COSTS to be asked: a bcrypt hash on an
// unauthenticated endpoint, a model call, a paid synthesis, an upload token, a
// supplier fetch. Every one of those was free to trigger at any rate.
//
// ============ AND WHAT MUST NEVER BE RECORDED ========================
//
// The last section is the one that matters most in a breach. A boundary that
// writes rejected passwords into a signal stream has created the leak it was
// built to prevent, so this asserts the negative directly: send a body full of
// secrets, be rejected, and prove none of it reached the database.

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

/** A real request, as one arrives. */
function post(body: unknown, headers: Record<string, string> = {}): Request {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://example.test/api/thing", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: payload,
  });
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  console.log("\n--- the caller's address, read the way proxies write it ---\n");
  {
    const h = (v: Record<string, string>) => new Headers(v);
    // The bug the old single call site had: taking the header whole, so two
    // requests through different proxy paths counted as different callers.
    eq("the leftmost entry is the client",
      clientIp(h({ "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2" })), "203.0.113.9");
    eq("a single value works too", clientIp(h({ "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
    // The platform header cannot be supplied by the caller, so it wins.
    eq("Vercel's own header is preferred",
      clientIp(h({ "x-vercel-forwarded-for": "198.51.100.4", "x-forwarded-for": "1.2.3.4" })), "198.51.100.4");
    eq("nothing claiming to know is null", clientIp(h({})), null);

    // The stored label is one-way and never the address.
    const label = addressLabel("203.0.113.9");
    assert("an address is never stored as itself", !label.includes("203.0.113.9"), label);
    eq("and the same address gives the same label", label, addressLabel("203.0.113.9"));
    assert("a different one differs", label !== addressLabel("203.0.113.10"));
    eq("an unknown address still has a label", addressLabel(null), "unknown");
  }

  console.log("\n--- size is refused before the body is read ---\n");
  {
    const schema = z.object({ ok: z.boolean() });

    // An honest Content-Length, refused without reading anything.
    const declared = new Request("https://example.test/x", {
      method: "POST",
      headers: { "content-length": String(10 * 1024 * 1024) },
      body: JSON.stringify({ ok: true }),
    });
    const big = await guard(declared, { surface: `t-size-${stamp}`, maxBytes: 1024, schema });
    assert("a declared oversize body is refused", !big.ok);
    if (!big.ok) eq("with 413", big.response.status, 413);

    // ============ AND A LYING CONTENT-LENGTH ===================
    //
    // The header is a claim. A caller who omits it, or lies, must still be
    // stopped — which is why the read is bounded rather than trusting the
    // number. This is the case a Content-Length check alone would miss.
    const lying = new Request("https://example.test/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, padding: "x".repeat(50_000) }),
    });
    const sneaky = await guard(lying, { surface: `t-size2-${stamp}`, maxBytes: 1024, schema });
    assert("an undeclared oversize body is refused too", !sneaky.ok);
    if (!sneaky.ok) eq("also with 413", sneaky.response.status, 413);

    // And a normal body passes.
    const fine = await guard(post({ ok: true }), { surface: `t-size3-${stamp}`, maxBytes: 1024, schema });
    assert("a small valid body passes", fine.ok);
    eq("there is a default ceiling", DEFAULT_MAX_BYTES, 64 * 1024);
  }

  console.log("\n--- shape is enforced, and the values never escape ---\n");
  {
    const schema = z.object({ email: z.string().email(), age: z.number().int().min(0) });

    const bad = await guard(post({ email: "not-an-email", age: -3 }), { surface: `t-shape-${stamp}`, schema });
    assert("an invalid body is refused", !bad.ok);
    if (!bad.ok) {
      eq("with 400", bad.response.status, 400);
      const payload = await bad.response.json() as { error: string; fields: { field: string }[] };
      eq("naming the fields that were wrong",
        payload.fields.map((f) => f.field).sort(), ["age", "email"]);
      // ============ AND NOT WHAT WAS IN THEM ==================
      const asText = JSON.stringify(payload);
      assert("never echoing the values", !asText.includes("not-an-email"), asText);
    }

    // ============ GARBAGE AND WRONG-SHAPE ARE DIFFERENT ========
    //
    // Both answer 400, so a status check cannot tell them apart — sabotage
    // proved it by making unparseable bodies fall through to validation, and
    // this suite noticed nothing. The distinction lives in the signal, and it
    // is the one an operator needs: somebody posting garbage at an endpoint is
    // a different fact from a client sending the wrong fields.
    const jsonSurface = `t-json-${stamp}`;
    const notJson = await guard(post("{definitely not json"), { surface: jsonSurface, schema });
    assert("a body that is not JSON is refused", !notJson.ok);
    if (!notJson.ok) eq("with 400", notJson.response.status, 400);
    const jsonSignal = await prismaSystem.securitySignal.findFirst({
      where: { surface: `http:${jsonSurface}` }, select: { detail: true },
    });
    eq("and recorded as unreadable rather than invalid",
      (jsonSignal?.detail as { reason?: string })?.reason, "not json");

    const good = await guard(post({ email: "a@b.test", age: 3 }), { surface: `t-ok-${stamp}`, schema });
    assert("a valid body passes", good.ok);
    if (good.ok) eq("and is parsed, not merely checked", good.body.age, 3);
  }

  console.log("\n--- the limiter counts, refuses, and keeps counting ---\n");
  {
    const kind = `t-limit-${stamp}`;
    const value = "caller-one";
    for (let i = 0; i < 3; i++) {
      const verdict = await checkRateLimit([{ kind, value, max: 3 }], { surface: kind });
      assert(`attempt ${i + 1} of 3 is allowed`, verdict.allowed);
    }
    const fourth = await checkRateLimit([{ kind, value, max: 3 }], { surface: kind });
    assert("the fourth is refused", !fourth.allowed);
    eq("naming the rule, never the value", fourth.trippedKind, kind);
    assert("and how long to wait", (fourth.retryAfterSeconds ?? 0) > 0);

    // A different caller is unaffected — the bucket is per value.
    const other = await checkRateLimit([{ kind, value: "caller-two", max: 3 }], { surface: kind });
    assert("a different caller is not punished", other.allowed);

    // ============ A REFUSED ATTEMPT STILL COUNTS ==============
    //
    // Otherwise somebody already over the limit hammers the endpoint for free
    // for ever, because none of those attempts extends the window.
    const before = await prismaSystem.authAttempt.count({ where: { bucket: bucketFor(kind, value) } });
    await checkRateLimit([{ kind, value, max: 3 }], { surface: kind });
    const after = await prismaSystem.authAttempt.count({ where: { bucket: bucketFor(kind, value) } });
    assert("a refused attempt is still recorded", after > before, `${before} → ${after}`);

    // The stored bucket is one-way.
    assert("the limited value is never stored", !bucketFor(kind, value).includes(value));
  }

  console.log("\n--- every rule is checked, not just the first ---\n");
  {
    // A caller who trips the address rule must still have their email attempt
    // counted, or a distributed attempt gets unlimited tries at one account.
    const ipKind = `t-multi-ip-${stamp}`;
    const emailKind = `t-multi-email-${stamp}`;
    for (let i = 0; i < 2; i++) {
      await checkRateLimit(
        [{ kind: ipKind, value: "addr", max: 2 }, { kind: emailKind, value: "victim@x.test", max: 50 }],
        { surface: "multi" },
      );
    }
    const tripped = await checkRateLimit(
      [{ kind: ipKind, value: "addr", max: 2 }, { kind: emailKind, value: "victim@x.test", max: 50 }],
      { surface: "multi" },
    );
    assert("the address rule refuses", !tripped.allowed);

    // ============ AND SO MUST THE SECOND RULE ================
    //
    // Sabotage checked only the first rule and this suite stayed green, because
    // every case here happened to trip rule one. A limit reached only by the
    // second rule must still refuse, or the second rule is decoration.
    const looseKind = `t-second-loose-${stamp}`;
    const tightKind = `t-second-tight-${stamp}`;
    const twoRules = () => [
      { kind: looseKind, value: "a", max: 1000 },
      { kind: tightKind, value: "b", max: 1 },
    ];
    await checkRateLimit(twoRules(), { surface: "second" });
    const bySecond = await checkRateLimit(twoRules(), { surface: "second" });
    assert("a limit tripped by the SECOND rule still refuses", !bySecond.allowed);
    eq("and names that rule", bySecond.trippedKind, tightKind);
    const emailCount = await prismaSystem.authAttempt.count({
      where: { bucket: bucketFor(emailKind, "victim@x.test") },
    });
    assert("and the email rule counted every attempt anyway", emailCount >= 3, `${emailCount}`);
  }

  console.log("\n--- registration: the real handler, real requests ---\n");
  {
    const { POST } = await import("@/app/api/register/route");
    const email = `reg-${stamp}@example.test`;

    // Shape first.
    const noEmail = await POST(post({ password: "a-long-enough-password-1" }));
    eq("a registration with no email is refused", noEmail.status, 400);
    const badEmail = await POST(post({ email: "nope", password: "a-long-enough-password-1" }));
    eq("and one with a malformed email", badEmail.status, 400);

    // ============ THE INJECTION SHAPE ========================
    //
    // `email` used to go straight into findUnique. A non-string reached Prisma
    // as an object, which is both a 500 and an operator-shaped input.
    const objectEmail = await POST(post({ email: { contains: "@" }, password: "a-long-enough-password-1" }));
    eq("an object where an email belongs is refused", objectEmail.status, 400);
    assert("and never reached the database as a query",
      (await prisma.user.count({ where: { email: { contains: `reg-${stamp}` } } })) === 0);

    // Size.
    const huge = await POST(post({ email, password: "x".repeat(200_000) }));
    assert("an enormous registration body is refused", huge.status === 413 || huge.status === 400, `${huge.status}`);

    // A real registration works.
    const ok = await POST(post({ email, password: "a-long-enough-password-1", name: "Reg" }));
    eq("a valid registration succeeds", ok.status, 201);
    eq("and the account exists", await prisma.user.count({ where: { email } }), 1);

    // ============ AND THE LIMIT BITES ========================
    //
    // Ten per address in the window. The valid one above counted, so nine more
    // reach the limit and the eleventh is refused — with no user created.
    const before = await prisma.user.count();
    let refused = 0;
    for (let i = 0; i < 14; i++) {
      const res = await POST(post({ email: `flood-${i}-${stamp}@example.test`, password: "a-long-enough-password-1" }));
      if (res.status === 429) refused++;
    }
    assert("a registration flood is refused", refused > 0, `${refused} refusals`);
    const created = (await prisma.user.count()) - before;
    assert("and fewer accounts were created than were attempted", created < 14, `${created} created`);
  }

  console.log("\n--- what a refusal is allowed to remember ---\n");
  {
    // ============ THE ASSERTION THAT MATTERS IN A BREACH =======
    //
    // A boundary that records what it rejected has created the leak it exists
    // to prevent. Sent deliberately: a password, a token, a card number.
    const secret = `pw-${stamp}-do-not-store`;
    const token = `sk_live_${stamp}_secret`;
    const { POST } = await import("@/app/api/register/route");
    await POST(post({ email: "not-an-email", password: secret, token, card: "4242424242424242" }));

    const since = new Date(Date.now() - 60_000);
    const signals = await prismaSystem.securitySignal.findMany({
      where: { occurredAt: { gte: since } },
      select: { kind: true, surface: true, detail: true },
    });
    assert("the refusal was recorded at all", signals.length > 0);

    const dumped = JSON.stringify(signals);
    assert("the password is nowhere in the signal stream", !dumped.includes(secret));
    assert("nor is the token", !dumped.includes(token));
    assert("nor the card number", !dumped.includes("4242424242424242"));
    // The field NAMES are useful and safe; the values are not.
    const boundary = signals.find((s) => s.kind === SIGNAL_KINDS.boundaryRejected);
    assert("a boundary rejection has its own kind", !!boundary,
      JSON.stringify(signals.map((s) => s.kind)));
    assert("and says which surface", (boundary?.surface ?? "").startsWith("http:"));

    // Nothing about a rejected body reaches telemetry either.
    const events = await prismaSystem.productEvent.findMany({
      where: { createdAt: { gte: since } }, select: { metadata: true },
    });
    assert("and nothing reached telemetry either", !JSON.stringify(events).includes(secret));
  }

  console.log("\n--- the diagnostic endpoint can no longer be written through ---\n");
  {
    const { POST } = await import("@/app/api/diag-client-log/route");

    // ============ IT REFUSES BEFORE IT LOGS ANYTHING ==========
    //
    // auth() reaches for headers(), which throws outside a request scope rather
    // than returning null — so a direct call with no session cannot get past
    // it. Asserted as "refused, and nothing written" rather than as a status
    // code, because the throw IS the refusal here and pretending otherwise
    // would be testing a shape this harness cannot produce.
    let logged: string | null = null;
    const realLog = console.log;
    console.log = (...args: unknown[]) => { logged = args.join(" "); };
    let refused = false;
    try {
      const anon = await POST(post({ requestId: "r", event: "e" }));
      refused = anon.status === 401;
    } catch {
      refused = true;
    } finally {
      console.log = realLog;
    }
    assert("an unauthenticated beacon is refused", refused);
    eq("and nothing was written to the log", logged, null);

    // ============ THE REAL RULE, NOT A COPY (2026-08-30) ======
    //
    // This declared its own identical schema inline, so sabotage removed the
    // route's rule entirely and the suite stayed green — it had been checking
    // its own duplicate the whole time. The rule now lives in one place and
    // both the route and this import it.
    const { logSafeText } = await import("@/lib/http/logSafeText");
    const oneLine = logSafeText(64);
    assert("a newline is rejected", !oneLine.safeParse("ok\nforged=entry").success);
    assert("a carriage return too", !oneLine.safeParse("ok\rforged").success);
    assert("a very long value is rejected", !oneLine.safeParse("x".repeat(500)).success);
    assert("and an ordinary event name is fine", oneLine.safeParse("stream.first_token").success);

    // ============ EVERY TEXT FIELD, NOT JUST ONE ==============
    //
    // `includes("logSafeText(")` was true while one of the two fields had been
    // swapped for a bare z.string() — sabotage renamed the first and the
    // assertion passed on the second. Counted, and the block is checked for any
    // unguarded string at all.
    //
    // HONEST LIMIT: this is a source assertion, because auth() throws outside a
    // request scope so this handler cannot be driven end to end here. The RULE
    // itself is proven behaviourally above; what cannot be is that the route
    // reaches for it.
    const { readFileSync } = await import("node:fs");
    const routeSrc = readFileSync("app/api/diag-client-log/route.ts", "utf8");
    const schemaBlock = routeSrc.slice(routeSrc.indexOf("const DiagBody"), routeSrc.indexOf("export async function"));
    eq("every text field on the beacon uses the shared rule",
      (schemaBlock.match(/logSafeText\(/g) ?? []).length, 2);
    assert("and none of them is a bare string",
      !/z\.string\(\)/.test(schemaBlock), schemaBlock.replace(/\s+/g, " ").slice(0, 160));
  }

  console.log("\n--- the callbacks bound what they are handed ---\n");
  {
    const { validateQuery, queryToken } = await import("@/lib/http/guard");
    const { z: zod } = await import("zod");

    const CallbackQuery = zod.object({
      state: queryToken(2048).optional(),
      code: queryToken(4096).optional(),
    }).passthrough();

    const query = (qs: string) => new Request(`https://example.test/cb?${qs}`);

    // A real return passes, extras and all — a provider adding a parameter must
    // never break somebody's connection.
    const real = await validateQuery(query("state=abc.def-123&code=AUTH_code~1&scope=read+write"), {
      surface: `t-cb-${stamp}`, schema: CallbackQuery,
    });
    assert("a genuine OAuth return is accepted", real.ok);
    if (real.ok) eq("and the code survives intact", real.value.code, "AUTH_code~1");

    // ============ THE BOUND THAT WAS MISSING ==================
    //
    // `code` reaches a provider's token exchange and `state` a signature check.
    // A megabyte of query string is work somebody else chose for us.
    const huge = await validateQuery(query(`code=${"a".repeat(5000)}`), {
      surface: `t-cb2-${stamp}`, schema: CallbackQuery,
    });
    assert("an enormous code is refused", !huge.ok);
    if (!huge.ok) eq("naming the field", huge.fields, ["code"]);

    // And anything a URL should not be carrying.
    const nasty: [string, string][] = [
      ["a script tag", "code=%3Cscript%3Ealert(1)%3C/script%3E"],
      ["a newline", "state=abc%0Adef"],
      ["a null byte", "state=abc%00def"],
    ];
    for (const [label, qs] of nasty) {
      const bad = await validateQuery(query(qs), { surface: `t-cb-x-${stamp}`, schema: CallbackQuery });
      assert(`${label} in a callback is refused`, !bad.ok);
    }

    // The refusal is recorded, and carries no values.
    const signal = await prismaSystem.securitySignal.findFirst({
      where: { surface: `http:t-cb2-${stamp}` }, select: { detail: true },
    });
    assert("a bad callback is recorded", !!signal);
    assert("naming fields, never values",
      !JSON.stringify(signal?.detail ?? {}).includes("aaaa"), JSON.stringify(signal?.detail));

    // ============ AND THE ROUTES USE IT ========================
    //
    // Driven for real: a PayPal return with a malformed slug must take the
    // route's own redirect rather than reaching the database.
    const { GET } = await import("@/app/api/checkout/paypal/return/route");
    const { NextRequest } = await import("next/server");

    // ============ A STORE THAT WOULD BE FOUND, IF IT LOOKED ====
    //
    // The first version of this sent a slug matching nothing, so validation
    // refusing and the database finding no store produced the SAME redirect —
    // sabotage removed the validation and the suite stayed green.
    //
    // Planting a store whose slug is the malformed value makes the two paths
    // diverge: with validation the route never queries and lands on "/", and
    // without it the store IS found and the route continues into the PayPal
    // flow, landing somewhere else entirely.
    const nastySlug = "../../etc/passwd";
    await prisma.store.create({
      data: {
        userId: (await prisma.user.create({ data: { email: `pp-${stamp}@example.test` } })).id,
        name: "Nasty", slug: nastySlug, tagline: "t", description: "d",
      },
    });

    const res = await GET(new NextRequest(
      "https://example.test/api/checkout/paypal/return?token=ok123&slug=" + encodeURIComponent(nastySlug),
    ));
    eq("a malformed PayPal return redirects rather than querying", res.status, 307);
    // Exactly the root. A route that had queried would send them to
    // /store/../../etc/passwd?checkout_problem=... instead.
    const location = res.headers.get("location") ?? "";
    assert("to the storefront root, the route's own answer",
      new URL(location, "https://example.test").pathname === "/", location);
    assert("and never into a per-store URL built from the bad slug",
      !location.includes("etc/passwd"), location);

    // ============ AND IT WAS THE BOUNDARY THAT REFUSED ========
    //
    // The redirect alone cannot prove this: an unvalidated slug reaches the
    // database, finds no store, and redirects to exactly the same place.
    // Sabotage proved that — removing the validation left this section green.
    //
    // The refusal RECORD is what distinguishes them. A validated rejection
    // leaves a boundary signal before any query; a missing store leaves none.
    const ppSignal = await prismaSystem.securitySignal.findFirst({
      where: { surface: "http:checkout.paypalReturn", kind: SIGNAL_KINDS.boundaryRejected },
      orderBy: { occurredAt: "desc" },
      select: { detail: true },
    });
    assert("the boundary recorded the refusal, so it never reached the database", !!ppSignal);
    eq("naming the field, not the value",
      (ppSignal?.detail as { fields?: string[] })?.fields, ["slug"]);
    assert("and the path traversal itself is nowhere in the record",
      !JSON.stringify(ppSignal?.detail ?? {}).includes("etc/passwd"),
      JSON.stringify(ppSignal?.detail));
  }


  console.log("\n--- endpoints deliberately left unlimited ---\n");
  {
    // ============ EXCEPTIONS ARE ASSERTED, NOT ASSUMED =========
    //
    // A rate limit on a webhook drops payments during a legitimate burst, and a
    // rate limit on the cron trigger throttles our own scheduler. Both are
    // wrong, so both are recorded here as decisions — and this fails if
    // somebody later adds one without thinking it through.
    const { readFileSync } = await import("node:fs");
    const unlimited = [
      ["app/api/webhooks/stripe/route.ts", "a provider burst is legitimate traffic"],
      ["app/api/webhooks/paypal/[storeId]/route.ts", "same"],
      ["app/api/webhooks/easypost/route.ts", "same"],
      ["app/api/webhooks/stripe-platform/route.ts", "same"],
      ["app/api/cron/sync/route.ts", "throttling our own scheduler is self-harm"],
      ["app/api/cron/tick/route.ts", "same"],
    ] as const;
    for (const [file, why] of unlimited) {
      const src = readFileSync(file, "utf8");
      assert(`${file.replace("app/api/", "")} is deliberately unlimited — ${why}`,
        !src.includes("checkRateLimit"), "a rate limit appeared on a path that must not have one");
    }
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
