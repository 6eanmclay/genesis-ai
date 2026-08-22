import type { IntegrationProvider } from "@prisma/client";
import {
  connectExecutable,
  verifyExecutable,
  syncExecutable,
} from "@/lib/execution/adapters/integrationExecutable";
import type { IntegrationConnector } from "@/lib/integrations/types";
import { RateLimitedError } from "@/lib/integrations/rateLimit";
import { PERMISSIONS } from "@/lib/permissions";

// THE THREE ADAPTERS EVERY CONNECTOR IS DRIVEN THROUGH:
//
//   npx tsx scripts/verify-integration-executables.ts
//
// IntegrationConnector and Executable are deliberately separate contracts,
// "composed via this thin adapter rather than folded into one". The adapter is
// where a connector's own vocabulary becomes an ExecutionLog row, and it had no
// coverage — while being the single place a mistake would apply to every
// provider at once.
//
// THE ONE THAT WOULD BE INVISIBLE is section 3. A connect() that hands back an
// OAuth redirect has not connected anything yet, and neither has one that
// returns a form. They reach PENDING by two DIFFERENT routes: the form sets
// `pending: true`, while the redirect relies on engine.ts treating a
// `redirectUrl` as non-terminal on its own. Drop `redirectUrl` from that
// condition and every OAuth handoff in the product records SUCCESS the moment
// the owner is sent away — before they have approved anything, and with the
// PENDING row the callback is supposed to close never written.
//
// AND A RATE LIMIT IS A DEFERRAL, NOT A FAILURE. Its own comment: letting one
// fall through to the generic failure path "would increment syncFailureCount
// and push a perfectly healthy connection toward the 24h backoff cap for the
// crime of being popular."

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/** A connector that does exactly what the test tells it to, and nothing else. */
function stub(over: Partial<IntegrationConnector> & { provider: IntegrationProvider }): IntegrationConnector {
  return {
    displayName: `${over.provider} Display`,
    requiredPermission: PERMISSIONS.CONNECTIONS_MANAGE,
    capabilities: {} as IntegrationConnector["capabilities"],
    connect: async () => ({ kind: "connected" }) as never,
    verify: async () => ({ ok: true }),
    disconnect: async () => {},
    ...over,
  } as IntegrationConnector;
}

const CTX = { storeId: "s1", userId: "u1" } as never;

// Every provider the schema knows, so a new one cannot slip past this suite by
// simply not being listed here.
const ALL_PROVIDERS: IntegrationProvider[] = [
  "STRIPE", "PAYPAL", "GOOGLE_CALENDAR", "QUICKBOOKS", "MAILCHIMP", "PRINTFUL",
] as IntegrationProvider[];

// ============================================================================
// tsx compiles to CJS, where top-level await is unavailable.
async function main() {
  console.log("\n=== 1. Every provider gets a real, distinct action name ===\n");
  // ============================================================================
  // The three maps are parallel and hand-maintained, and a provider named in one
  // but missing from another silently falls through to the template string. That
  // is survivable by design — but the name it produces still has to be a real,
  // unique, well-formed action, or one provider's log rows land under another's.
  const names: string[] = [];
  for (const provider of ALL_PROVIDERS) {
    const connector = stub({ provider });
    const connect = connectExecutable(connector).action;
    const verify = verifyExecutable(connector).action;
    const sync = syncExecutable(connector).action;
    names.push(connect, verify, sync);

    for (const [verb, action] of [["connect", connect], ["verify", verify], ["sync", sync]] as const) {
      assert(`${provider}.${verb} has a real action name`,
        typeof action === "string" && action.length > 0, String(action));
      assert(`${provider}.${verb} is namespaced to integrations`,
        action.startsWith("integration."), String(action));
      assert(`${provider}.${verb} names its own verb`,
        action.endsWith(`.${verb}`), String(action));
    }
    assert(`${provider}'s three verbs are three different actions`,
      new Set([connect, verify, sync]).size === 3,
      JSON.stringify([connect, verify, sync]));
  }
  check("and no two provider/verb pairs share an action name",
    names.length - new Set(names).size, 0);

  // The template fallback is the documented behaviour for anything unlisted, and
  // it must lowercase the provider rather than emitting the enum's own casing.
  const unlisted = connectExecutable(stub({ provider: "PAYPAL" as IntegrationProvider })).action;
  assert("an unlisted provider falls through to its template name",
    unlisted === "integration.paypal.connect", unlisted);

  // ============================================================================
  console.log("\n=== 2. The adapter never widens who may act ===\n");
  // ============================================================================
  // The connector declares its own required permission; the adapter's job is
  // bookkeeping. Substituting a broader one here would grant every connector
  // whatever the adapter happened to pick.
  for (const permission of [PERMISSIONS.CONNECTIONS_MANAGE, PERMISSIONS.PAYMENTS_MANAGE, PERMISSIONS.STORE_MANAGE]) {
    const connector = stub({ provider: "MAILCHIMP" as IntegrationProvider, requiredPermission: permission });
    check(`connect keeps ${permission}`, connectExecutable(connector).requiredPermission, permission);
    check(`verify keeps ${permission}`, verifyExecutable(connector).requiredPermission, permission);
    check(`sync keeps ${permission}`, syncExecutable(connector).requiredPermission, permission);
  }

  // ============================================================================
  console.log("\n=== 3. Nothing is connected until it is connected ===\n");
  // ============================================================================
  const redirecting = await connectExecutable(
    stub({
      provider: "GOOGLE_CALENDAR" as IntegrationProvider,
      connect: async () => ({ kind: "redirect", url: "https://provider.test/oauth" }) as never,
    })
  ).run({}, CTX);
  check("a redirect carries the URL to send the owner to",
    (redirecting as { redirectUrl?: string }).redirectUrl, "https://provider.test/oauth");
  assert(
    "which is what makes it non-terminal, without a pending flag of its own",
    Boolean((redirecting as { redirectUrl?: string }).redirectUrl),
    "engine.ts records PENDING on `redirectUrl || pending` — drop the first half and every OAuth handoff logs SUCCESS before the owner has approved anything"
  );

  const formed = await connectExecutable(
    stub({
      provider: "MAILCHIMP" as IntegrationProvider,
      connect: async () => ({ kind: "form", fields: [{ name: "apiKey", label: "API key", type: "password" }] }) as never,
    })
  ).run({}, CTX);
  check("a form is explicitly pending", (formed as { pending?: boolean }).pending, true);
  check("and carries the fields to ask for",
    (formed.metadata as { fields?: unknown[] })?.fields?.length, 1);
  assert("neither reports anything as connected",
    !redirecting.message.includes("connected") && !formed.message.includes("connected"),
    `${redirecting.message} / ${formed.message}`);

  const connected = await connectExecutable(
    stub({ provider: "QUICKBOOKS" as IntegrationProvider, connect: async () => ({ kind: "connected" }) as never })
  ).run({}, CTX);
  assert("only a completed connection says connected", connected.message.includes("connected"), connected.message);
  check("and it is neither pending nor redirecting",
    [(connected as { pending?: boolean }).pending, (connected as { redirectUrl?: string }).redirectUrl],
    [undefined, undefined]);

  // The attempt's own executionId travels to the connector, so the callback can
  // close exactly this row "instead of guessing at the most recent PENDING one".
  let seenParams: Record<string, string> | undefined;
  await connectExecutable(
    stub({
      provider: "GOOGLE_CALENDAR" as IntegrationProvider,
      connect: async (_s, _u, params) => {
        seenParams = params;
        return { kind: "connected" } as never;
      },
    })
  ).run({ params: { foo: "bar" } }, { storeId: "s1", userId: "u1", executionId: "exec_42" } as never);
  check("the connector is told which attempt this is", seenParams?.executionId, "exec_42");
  check("alongside the caller's own params", seenParams?.foo, "bar");

  // ============================================================================
  console.log("\n=== 4. A verification failure is worth retrying ===\n");
  // ============================================================================
  const verified = await verifyExecutable(stub({ provider: "STRIPE" as IntegrationProvider })).run(undefined as never, CTX);
  assert("a passing check says so", verified.message.includes("verified"), verified.message);

  const failedVerify = await verifyExecutable(
    stub({ provider: "STRIPE" as IntegrationProvider, verify: async () => ({ ok: false, error: "Token expired" }) })
  ).run(undefined as never, CTX);
  check("a failure reports the provider's own reason", failedVerify.message, "Token expired");
  check("and is retryable", (failedVerify as { retryable?: boolean }).retryable, true);

  const silentFailure = await verifyExecutable(
    stub({ provider: "STRIPE" as IntegrationProvider, verify: async () => ({ ok: false }) })
  ).run(undefined as never, CTX);
  assert("a failure with no reason still says something", silentFailure.message.length > 0, silentFailure.message);
  assert("rather than an empty message on a real failure",
    silentFailure.message !== "", silentFailure.message);

  // ============================================================================
  console.log("\n=== 5. A rate limit is a deferral, not a failure ===\n");
  // ============================================================================
  // "Nothing is broken, we were simply asked to come back later."
  // Caught rather than awaited bare: if the deferral branch is ever removed the
  // error escapes, and a crash here would say far less than an assertion. The
  // first negative control run proved that — it took the suite down instead of
  // reporting which property had gone.
  const limited = await syncExecutable(
    stub({
      provider: "MAILCHIMP" as IntegrationProvider,
      sync: async () => {
        throw new RateLimitedError("Mailchimp asked us to wait", { retryAfterMs: 30_000, status: 429 });
      },
    } as Partial<IntegrationConnector> & { provider: IntegrationProvider })
  )
    .run(undefined as never, CTX)
    .catch((error) => {
      assert("a rate limit is handled rather than thrown", false,
        `it escaped as ${error instanceof Error ? error.name : String(error)}`);
      return { message: "", metadata: {} } as never;
    });

  check("it is partial rather than failed", (limited as { partial?: boolean }).partial, true);
  check("and retryable", (limited as { retryable?: boolean }).retryable, true);
  check("the provider's own wait travels in metadata",
    (limited.metadata as { retryAfterMs?: number }).retryAfterMs, 30_000);
  check("with nothing claimed as written", (limited.metadata as { written: number }).written, 0);
  assert(
    "so a popular connection is never pushed toward the 24h backoff cap",
    (limited as { partial?: boolean }).partial === true,
    "a thrown error reaches the scheduler as a bare FAILED with no metadata at all"
  );

  // A connector with no sync at all is a no-op, not an error.
  const nothingToSync = await syncExecutable(stub({ provider: "STRIPE" as IntegrationProvider })).run(undefined as never, CTX);
  assert("a connector with nothing to sync says so", nothingToSync.message.includes("nothing to sync"), nothingToSync.message);
  check("and reports no work rather than a failure",
    [(nothingToSync.metadata as { written: number }).written, (nothingToSync.metadata as { errors: number }).errors],
    [0, 0]);
  check("with no deferral attached", (nothingToSync.metadata as { retryAfterMs?: number }).retryAfterMs, undefined);

  // Any other error is still a real failure — the deferral path must not swallow
  // a genuine break.
  let threw = false;
  try {
    await syncExecutable(
      stub({
        provider: "MAILCHIMP" as IntegrationProvider,
        sync: async () => {
          throw new Error("the account was closed");
        },
      } as Partial<IntegrationConnector> & { provider: IntegrationProvider })
    ).run(undefined as never, CTX);
  } catch {
    threw = true;
  }
  assert("a genuine sync error still fails loudly", threw,
    "only a RateLimitedError is a deferral; everything else is a real break");

  console.log(`
${failures === 0 ? "All integration-executable assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
