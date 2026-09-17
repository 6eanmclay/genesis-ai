import { allConnectors } from "@/lib/integrations/registry";
import { connectionHealthOf } from "@/lib/integrations/connectionHealth";

// configured() MEANS THE CREDENTIALS ARE REALLY THERE — AND NOTHING MORE:
//
//   npx tsx scripts/run-code-suites.ts configured-truthfulness
//
// ============ WHY DECLARING IT IS NOT ENOUGH (C3, 2026-09-16) ==========
//
// The connections page renders `available: entry.connector.configured?.() ?? true`,
// and `available: false` is the ONLY thing that turns a Connect button into
// "Not available to connect yet." So this one boolean decides whether an owner
// is offered a flow that can work.
//
// Two commits ago Mailchimp did not declare it at all and was therefore always
// offered; verify-connection-truthfulness now requires every OAuth connector to
// declare one. That closes the DECLARATION half and none of the truth half — a
// connector answering `configured() { return true }` satisfies it completely and
// rebuilds exactly the same defect one layer down.
//
// That is not hypothetical. verify-connection-truthfulness records it happening:
// "An earlier version of the Twilio connector answered `configured() { return
// true }` and this assertion caught it." It was caught then by a hand-written
// expected list, which is the mechanism that later failed to notice Mailchimp.
//
// So this proves the ANSWER, per connector, against the real environment: true
// with every required variable present, and false with each one individually
// removed. A constant cannot pass both directions, and neither can a connector
// that reads only the first of the two halves it needs.
//
// ============ THREE STATES, AND THIS IS ONLY THE FIRST ================
//
// lib/integrations/connectionHealth.ts already separates them and section 3
// holds the line between them:
//
//   available / configured   the PLATFORM holds what it needs to START a
//                            connection. Says nothing about any store.
//   not_connected            configured, and this store has never connected.
//   connected / failed / …   a stored row, written by a real verification.
//
// Credentials being present must never be read as a connection existing. No
// credential is invented here and no provider is contacted: the assertions set
// and unset variables in this process only.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${label}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  — ${detail}` : ""}`);
}

/**
 * What each connector's configured() actually reads.
 *
 * A HAND-WRITTEN MAP, AND THEREFORE ASSERTED COMPLETE against the registry in
 * section 1 — the same guard the webhook contract test carries, and for the
 * same reason: a connector missing from this map would be silently unproven,
 * which is the exact shape of the defect this suite exists to prevent.
 *
 * Read from each connector's own source, not from documentation.
 */
const REQUIREMENTS: Record<string, string[]> = {
  GOOGLE_CALENDAR: ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET"],
  QUICKBOOKS: ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET"],
  MAILCHIMP: ["MAILCHIMP_CLIENT_ID", "MAILCHIMP_CLIENT_SECRET"],
  // Instagram deliberately shares the Facebook app — one Meta app covers both,
  // which is why both rows name the same two variables rather than Instagram
  // having its own.
  FACEBOOK: ["FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET"],
  INSTAGRAM: ["FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET"],
  TIKTOK: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
  PRINTFUL: ["PRINTFUL_CLIENT_ID", "PRINTFUL_CLIENT_SECRET"],
  SQUARE: ["SQUARE_CLIENT_ID", "SQUARE_CLIENT_SECRET"],
  XERO: ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET"],
  ALIEXPRESS: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"],
};

/** Run `fn` with exactly `present` set, restoring the environment afterwards. */
function withEnvironment(vars: string[], present: string[], fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const v of vars) saved.set(v, process.env[v]);
  try {
    for (const v of vars) {
      if (present.includes(v)) process.env[v] = `harness-${v.toLowerCase()}`;
      else delete process.env[v];
    }
    fn();
  } finally {
    for (const [v, value] of saved) {
      if (value === undefined) delete process.env[v];
      else process.env[v] = value;
    }
  }
}

function main(): void {
  const declaring = allConnectors().filter(([, c]) => typeof c.configured === "function");

  // ==================================================================
  console.log("\n1. Every connector that declares configured() is proven here\n");
  // ==================================================================
  assert("there are connectors declaring configured()", declaring.length > 0, `${declaring.length}`);
  console.log(`      NOTE  declaring: ${declaring.map(([p]) => p).join(", ")}`);

  for (const [provider] of declaring) {
    assert(`${provider}: this suite knows what its configured() reads`,
      REQUIREMENTS[provider] !== undefined,
      "add its variables to REQUIREMENTS — an unlisted connector's configured() is never proven true or false");
  }

  // AND NOTHING IS LISTED THAT NO LONGER DECLARES ONE. A stale requirement is a
  // connector somebody stopped guarding without anyone noticing.
  const declaringNames = new Set(declaring.map(([p]) => String(p)));
  for (const provider of Object.keys(REQUIREMENTS)) {
    assert(`${provider}: still declares a configured() for this entry to describe`,
      declaringNames.has(provider), "remove it from REQUIREMENTS, or find out why the connector stopped declaring one");
  }

  // ==================================================================
  console.log("\n2. The answer is TRUE, not merely declared\n");
  // ==================================================================
  for (const [provider, connector] of declaring) {
    const vars = REQUIREMENTS[String(provider)];
    if (!vars) continue;

    // ALL PRESENT -> configured.
    withEnvironment(vars, vars, () => {
      assert(`${provider}: configured when every variable is present`,
        connector.configured?.() === true, vars.join(" + "));
    });

    // EACH ONE REMOVED -> not configured. This is the direction a constant
    // cannot survive, and the one that catches a connector reading only the
    // first half of a credential: the authorize URL needs the id and the token
    // exchange needs the secret, so half a credential fails a step later —
    // after the owner has already left for the provider and come back.
    for (const missing of vars) {
      const rest = vars.filter((v) => v !== missing);
      withEnvironment(vars, rest, () => {
        assert(`${provider}:   not configured without ${missing}`,
          connector.configured?.() === false, `only ${rest.join(" + ") || "nothing"} present`);
      });
    }

    // NOTHING PRESENT -> not configured.
    withEnvironment(vars, [], () => {
      assert(`${provider}:   nor with none of them`, connector.configured?.() === false);
    });
  }

  // ==================================================================
  console.log("\n3. Configured is not connected, and never becomes it\n");
  // ==================================================================
  //
  // The distinction connectionHealth.ts already draws, held here so that
  // "the credentials exist" can never be rendered as "this store is connected".
  {
    const configuredNeverUsed = connectionHealthOf({ available: true, row: null, recordsProduced: 0 });
    assert("a configured connector with no stored row is NOT connected",
      configuredNeverUsed.state === "not_connected", configuredNeverUsed.state);
    assert("  and raises nothing, because nothing is wrong",
      configuredNeverUsed.raisesAttention === false);

    // THE OTHER DIRECTION. Credentials that disappeared do not leave a store
    // looking connected — "available" gates everything after it.
    const rowButUnavailable = connectionHealthOf({
      available: false,
      row: { status: "CONNECTED", lastError: null, lastSyncedAt: new Date(), syncFailureCount: 0 },
      recordsProduced: 12,
    });
    assert("an unconfigured connector is unavailable even holding a CONNECTED row",
      rowButUnavailable.state === "unavailable", rowButUnavailable.state);

    // AND A FAILED VERIFICATION IS NOT HIDDEN BY BEING CONFIGURED.
    const configuredButFailed = connectionHealthOf({
      available: true,
      row: { status: "FAILED", lastError: "the account was a test account created with a testmode key", lastSyncedAt: null, syncFailureCount: 0 },
      recordsProduced: 0,
    });
    assert("a configured connector whose verification failed reads failed",
      configuredButFailed.state === "failed", configuredButFailed.state);
    assert("  and keeps the provider's own words",
      configuredButFailed.providerError === "the account was a test account created with a testmode key");
  }

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failures > 0) {
    console.log("\nFAILED:");
    for (const line of failed) console.log(`  ${line}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
