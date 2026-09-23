import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  paypalConnector,
  resolveConnectEnvironment,
  sandboxConnectAllowed,
} from "@/lib/integrations/paypal";
import type { PaypalEnvironment } from "@/lib/integrations/paypal";
import { encryptCredentials, decryptCredentials } from "@/lib/integrations/credentials";
import { readFileSync } from "node:fs";

// CONNECTING PAYPAL MEANS CONNECTING REAL MONEY:
//
//   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/run-db-suites.ts paypal-connect-environment" \
//     -OutFile "C:/Users/hyper/AppData/Local/Temp/genesis-ppce.txt"
//
// WRITE THE OutFile PATH OUT IN FULL — an unset shell variable there captures
// nothing and reads exactly like a silent pass.
//
// ISOLATED DATABASE ONLY, AND NO PAYPAL CALL EVER. Section 4 installs a fetch
// that FAILS the run if anything reaches the network, so "no PayPal call" is
// proven rather than assumed.
//
// ============ THE DEFECT THIS EXISTS FOR (2026-09-23) =================
//
// lib/integrations/paypal.ts resolved a connect request with:
//
//     return normalized === "live" ? "live" : "sandbox";
//
// Everything it did not recognise became sandbox. The payments page then
// pre-filled the environment input with the literal string "sandbox", exempted
// it from `required`, and told the merchant to "create a PayPal Developer app
// at developer.paypal.com" — a dashboard that shows SANDBOX credentials by
// default. Default value, optional field and instructions all pointed the same
// way, and no surface ever displayed which environment a store was on.
//
// So a merchant who followed the instructions exactly connected an account
// that takes fake money, and GenJ4 reported their sales as real.
//
// THE RULE THIS PINS. In any non-development GenJ4 environment, connecting
// PayPal means connecting an account capable of receiving real payments.
// Sandbox is reachable only under `next dev`, never by default, and an
// environment string we cannot read is REFUSED rather than guessed.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not reinterpret, migrate or
// re-verify any integration that already exists — section 7 proves the exact
// opposite, that a stored sandbox integration stays sandbox. Legacy
// verification is a separate piece of work.

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`);
}
function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

const PAYPAL_SOURCE = "lib/integrations/paypal.ts";
const PAYMENTS_PAGE = "app/dashboard/payments/page.tsx";

/** A resolver as the merchant path uses it: one string in, an environment out. */
type Resolver = (requested: string | undefined) => PaypalEnvironment;

/**
 * Every input the connect path can actually receive, and what the rule demands
 * of it where sandbox is NOT permitted.
 *
 * "live" means the value must resolve live. "throws" means it must be refused.
 * NOTHING in this table is allowed to produce sandbox — that is the rule, and
 * section 6 runs the same table against the deleted resolver to prove the
 * table is what catches its return.
 */
const TABLE: { input: string | undefined; expect: "live" | "throws"; why: string }[] = [
  { input: undefined, expect: "live", why: "the merchant form no longer sends the field at all" },
  { input: "", expect: "live", why: "an empty submitted field" },
  { input: "   ", expect: "live", why: "whitespace is not a choice" },
  { input: "live", expect: "live", why: "the explicit request" },
  { input: "Live", expect: "live", why: "case is not a decision" },
  { input: "LIVE", expect: "live", why: "case is not a decision" },
  { input: " live ", expect: "live", why: "padding is not a decision" },
  { input: "sandbox", expect: "throws", why: "explicit, permitted only under next dev" },
  { input: "SANDBOX", expect: "throws", why: "explicit, permitted only under next dev" },
  { input: " Sandbox ", expect: "throws", why: "explicit, permitted only under next dev" },
  { input: "production", expect: "throws", why: "a plausible typo that USED to mean sandbox" },
  { input: "prod", expect: "throws", why: "a plausible typo that USED to mean sandbox" },
  { input: "Live mode", expect: "throws", why: "a plausible typo that USED to mean sandbox" },
  { input: "real", expect: "throws", why: "a plausible typo that USED to mean sandbox" },
  { input: "test", expect: "throws", why: "must not be read as a sandbox synonym" },
  { input: "0", expect: "throws", why: "a crafted value" },
];

/** Returns one line per violation, so a resolver can be judged as a whole. */
function runTable(resolve: Resolver): string[] {
  const broken: string[] = [];
  for (const row of TABLE) {
    let outcome: string;
    try {
      outcome = resolve(row.input);
    } catch {
      outcome = "throws";
    }
    if (outcome !== row.expect) {
      broken.push(`${JSON.stringify(row.input)} -> ${outcome} (rule says ${row.expect}: ${row.why})`);
    }
  }
  return broken;
}

/** The exact expression this slice deleted. Section 6's sabotage subject. */
const OLD_RESOLVER: Resolver = (requested) => {
  const normalized = requested?.trim().toLowerCase();
  return normalized === "live" ? "live" : "sandbox";
};

async function main() {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  // A key that exists only inside this process, for fixtures this suite
  // creates. No production credential is read, written or decrypted anywhere
  // in this file.
  process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  const user = await prisma.user.create({ data: { email: `ppce-${stamp}@example.test`, name: "O" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "PPCE", slug: `ppce-${stamp}`, tagline: "t", description: "d" },
  });

  console.log("\n=== 1. THE RULE: sandbox NOT permitted (Production and Preview) ===\n");
  {
    const broken = runTable((v) => resolveConnectEnvironment(v, false));
    eq("every input resolves live or is refused", broken, []);
    for (const line of broken) console.log(`        ${line}`);

    // Stated as its own assertion because it is the rule, not a consequence.
    let everSandbox = false;
    for (const row of TABLE) {
      try {
        if (resolveConnectEnvironment(row.input, false) === "sandbox") everSandbox = true;
      } catch {
        /* refused, which is allowed */
      }
    }
    assert("NO input whatsoever produces sandbox", !everSandbox,
      "this is the invariant: in a non-development environment there is no path to sandbox");
  }

  console.log("\n=== 2. LOCAL DEVELOPMENT: sandbox permitted, but never by default ===\n");
  {
    eq("an explicit 'sandbox' is honoured", resolveConnectEnvironment("sandbox", true), "sandbox");
    eq("  and so is 'live'", resolveConnectEnvironment("live", true), "live");
    // The important one. Permitting sandbox must not make it the default, or
    // a developer's blank field silently becomes the old defect again.
    eq("a BLANK field is still live, even here", resolveConnectEnvironment(undefined, true), "live");
    eq("  and an empty string too", resolveConnectEnvironment("", true), "live");
    let refused = false;
    try {
      resolveConnectEnvironment("prod", true);
    } catch {
      refused = true;
    }
    assert("an unreadable value is refused here too", refused,
      "permitting sandbox does not lower the bar on guessing");
  }

  console.log("\n=== 3. THE GATE: only `next dev` opens it ===\n");
  {
    const savedNode = process.env.NODE_ENV;
    const savedVercel = process.env.VERCEL;
    const set = (node: string | undefined, vercel: string | undefined) => {
      if (node === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
      else (process.env as Record<string, string | undefined>).NODE_ENV = node;
      if (vercel === undefined) delete (process.env as Record<string, string | undefined>).VERCEL;
      else (process.env as Record<string, string | undefined>).VERCEL = vercel;
    };

    // Next assigns "production" for every command that is not `next dev`, so
    // Vercel Production and Preview both land on the first two rows.
    set("production", "1");
    assert("Vercel Production -> closed", !sandboxConnectAllowed());
    set("production", undefined);
    assert("a production build anywhere -> closed", !sandboxConnectAllowed());
    set("development", "1");
    assert("a dev server ON Vercel -> closed", !sandboxConnectAllowed(),
      "the second condition is what closes this one");
    set("test", undefined);
    assert("NODE_ENV=test -> closed", !sandboxConnectAllowed(),
      "a suite must state its intent explicitly, not inherit sandbox");
    set(undefined, undefined);
    assert("NODE_ENV unset -> closed", !sandboxConnectAllowed());

    set("development", undefined);
    assert("local `next dev` -> OPEN", sandboxConnectAllowed(),
      "the one place a developer may connect sandbox");

    set(savedNode, savedVercel);
  }

  console.log("\n=== 4. THE WRITER: a refused connect costs nothing ===\n");
  {
    // Proves the refusal happens BEFORE the token exchange. If connect() ever
    // reordered so it called PayPal first, this fails loudly instead of
    // quietly making a network call on every run.
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown, ...rest: unknown[]) => {
      calls.push(String(input));
      return realFetch(input as Parameters<typeof realFetch>[0], ...(rest as never[]));
    }) as typeof globalThis.fetch;

    let thrown: Error | null = null;
    try {
      await paypalConnector.connect(store.id, user.id, {
        clientId: "AeTestClientId",
        clientSecret: "ETestSecret",
        environment: "sandbox",
      });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    } finally {
      globalThis.fetch = realFetch;
    }

    assert("a crafted sandbox request is refused", thrown !== null,
      "the form no longer offers it, but a POST can still carry it");
    assert("  and refused for the RIGHT reason", /real payments|local development/i.test(thrown?.message ?? ""),
      `message was: ${thrown?.message ?? "(none)"}`);
    eq("NO PayPal call was made", calls, []);
    eq("and NO integration row was written",
      await prismaSystem.storeIntegration.count({ where: { storeId: store.id, provider: "PAYPAL" } }), 0);
  }

  console.log("\n=== 5. THE FORM: no environment decision is offered to a merchant ===\n");
  {
    const savedNode = process.env.NODE_ENV;
    const savedVercel = process.env.VERCEL;
    const set = (node: string, vercel: string | undefined) => {
      (process.env as Record<string, string | undefined>).NODE_ENV = node;
      if (vercel === undefined) delete (process.env as Record<string, string | undefined>).VERCEL;
      else (process.env as Record<string, string | undefined>).VERCEL = vercel;
    };

    set("production", "1");
    const prodForm = await paypalConnector.connect(store.id, user.id, undefined);
    const prodFields = prodForm.kind === "form" ? prodForm.fields.map((f) => f.name) : [];
    eq("production offers exactly the two credential fields", prodFields, ["clientId", "clientSecret"]);
    assert("  and no environment field at all", !prodFields.includes("environment"),
      "there is nothing for a merchant to type wrong");

    set("development", undefined);
    const devForm = await paypalConnector.connect(store.id, user.id, undefined);
    const devFields = devForm.kind === "form" ? devForm.fields.map((f) => f.name) : [];
    assert("local development still offers it", devFields.includes("environment"),
      "the dev path is gated, not deleted");

    set(savedNode ?? "test", savedVercel);
  }

  console.log("\n=== 6. SABOTAGE: restore the old default and this suite fails ===\n");
  {
    const nowBroken = runTable((v) => resolveConnectEnvironment(v, false));
    eq("CONTROL: the shipped resolver satisfies the table", nowBroken, []);

    const oldBroken = runTable(OLD_RESOLVER);
    assert("SABOTAGE CAUGHT: the deleted resolver fails the same table", oldBroken.length > 0,
      `${oldBroken.length} of ${TABLE.length} inputs violate the rule under the old code`);
    for (const line of oldBroken.slice(0, 4)) console.log(`        ${line}`);

    // Without this the table above could be vacuous. It is the reason to
    // believe section 1 would go red rather than merely being green today.
    assert("  including a BLANK field, which is what a merchant actually sent",
      oldBroken.some((l) => l.startsWith("undefined") || l.startsWith('""')),
      "the old code turned 'no answer' into sandbox");

    const src = readFileSync(PAYPAL_SOURCE, "utf8").replace(/\r\n?/g, "\n");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    assert("and the collapse expression is gone from the source",
      !/\?\s*"live"\s*:\s*"sandbox"/.test(code),
      "so the literal line cannot come back unnoticed");
    assert("CONTROL: the comment stripper still sees real code", code.includes("resolveConnectEnvironment"));

    const page = readFileSync(PAYMENTS_PAGE, "utf8").replace(/\r\n?/g, "\n");
    const pageCode = page.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    assert("the payments page no longer pre-fills sandbox",
      !/defaultValue=\{[^}]*"sandbox"/.test(pageCode),
      "this default was the single most effective part of the defect");
    assert("and its copy names Live rather than steering to the sandbox dashboard",
      /under Live/.test(pageCode) && !/Create a PayPal Developer app at developer\.paypal\.com/.test(pageCode));
  }

  console.log("\n=== 7. COMPATIBILITY: an existing sandbox integration stays sandbox ===\n");
  {
    // NOT remediation. The point is the opposite: the new connection rule must
    // not reach backwards and reinterpret what is already stored. A store
    // connected to sandbox yesterday is still connected to sandbox today, and
    // every consumer reads that stored value rather than re-deriving it.
    const legacyUser = await prisma.user.create({
      data: { email: `ppce-legacy-${stamp}@example.test`, name: "L" },
    });
    const legacyStore = await prisma.store.create({
      data: { userId: legacyUser.id, name: "Legacy", slug: `ppce-legacy-${stamp}`, tagline: "t", description: "d" },
    });
    await prismaSystem.storeIntegration.create({
      data: {
        storeId: legacyStore.id,
        provider: "PAYPAL",
        externalAccountId: null,
        credentials: encryptCredentials({
          schemaVersion: 1,
          clientId: "legacy-client-id",
          clientSecret: "legacy-secret",
          environment: "sandbox",
          webhookId: null,
        }),
        connectedByUserId: legacyUser.id,
        connectedAt: new Date(),
        lastVerifiedAt: new Date(),
      },
    });

    const row = await prismaSystem.storeIntegration.findUnique({
      where: { storeId_provider: { storeId: legacyStore.id, provider: "PAYPAL" } },
    });
    const stored = decryptCredentials<{ environment: string }>(row?.credentials);
    eq("it still reads back as sandbox", stored.environment, "sandbox");
    assert("  which the new rule never touched",
      resolveConnectEnvironment(undefined, false) === "live" && stored.environment === "sandbox",
      "the connect rule governs new connections only — it does not reclassify stored ones");
  }

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
