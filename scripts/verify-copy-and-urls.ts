import {
  buildTaskSeedMessage,
  buildTaskUserMessage,
  buildTaskRecapMessage,
} from "@/lib/dashboard/taskConversation";
import { integrationCallbackUrl, canonicalBaseUrl } from "@/lib/integrations/util";

// TWO SMALL SURFACES WHERE BEING WRONG IS QUIET:
//
//   npx tsx scripts/verify-copy-and-urls.ts
//
// A task's opening line, and the URL a payment provider calls back to. Neither
// had coverage, and both fail in ways nobody notices for a while.
//
// THE CALLBACK URL IS THE SERIOUS ONE. canonicalBaseUrl exists because
// getBaseUrl derives the host from the incoming request — right for an OAuth
// redirect, where the browser has to return to where it started, and wrong for
// anything durable. Its own comment: a merchant who connects PayPal from a
// preview deployment "would otherwise have a refund webhook registered against
// that preview's hostname — it works until the deployment is rotated, and then
// their refunds silently stop arriving with nothing anywhere saying why."
//
// THE TASK COPY is fixed and deterministic per task type on purpose, and the
// reason is stated in the file: an opening line must be "exactly this honest,
// specific statement, never a fabricated claim about what J4 already knows".
// The fallback matters as much as the entries — a detector added without a
// bespoke line must still open honestly from its own real summary rather than
// with a generic claim, and the recap must acknowledge without inventing what
// was discussed.

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

async function main() {
  // ==========================================================================
  console.log("\n=== 1. A durable callback never points at a preview ===\n");
  // ==========================================================================
  const original = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  try {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "genesis.example.com";
    check("the project's own production domain wins", await canonicalBaseUrl(), "https://genesis.example.com");
    assert(
      "so a webhook registered from a preview still points at production",
      (await canonicalBaseUrl()).includes("genesis.example.com"),
      "otherwise refunds stop arriving when the deployment rotates"
    );

    // A domain already carrying a scheme is not double-prefixed.
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "https://genesis.example.com";
    check("a domain with a scheme is left alone", await canonicalBaseUrl(), "https://genesis.example.com");
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "http://localhost:3000";
    check("including an http one", await canonicalBaseUrl(), "http://localhost:3000");

    // Whitespace around an env var is the classic deployment-config mistake,
    // and " genesis.example.com" would otherwise become "https:// genesis...".
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "  genesis.example.com  ";
    check("surrounding whitespace is trimmed", await canonicalBaseUrl(), "https://genesis.example.com");

    // An empty value must not produce "https://" — it has to fall through to
    // the request host instead, which is what local development relies on.
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "   ";
    let fellThrough = false;
    try {
      await canonicalBaseUrl();
    } catch {
      // getBaseUrl() calls next/headers, which throws outside a request. That
      // throw IS the evidence: it proves the empty value fell through rather
      // than being turned into a bare "https://".
      fellThrough = true;
    }
    assert("an empty value falls through rather than becoming 'https://'", fellThrough,
      "reached getBaseUrl, which needs a real request");
  } finally {
    if (original === undefined) delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    else process.env.VERCEL_PROJECT_PRODUCTION_URL = original;
  }

  // ==========================================================================
  console.log("\n=== 2. One spelling of the callback path ===\n");
  // ==========================================================================
  check("the route shape is spelled out in exactly one place",
    integrationCallbackUrl("https://genesis.example.com", "STRIPE"),
    "https://genesis.example.com/api/integrations/stripe/callback");
  check("and the provider is lowercased to match the route segment",
    integrationCallbackUrl("https://genesis.example.com", "PAYPAL"),
    "https://genesis.example.com/api/integrations/paypal/callback");
  check("a multi-word provider too",
    integrationCallbackUrl("https://genesis.example.com", "GOOGLE_CALENDAR"),
    "https://genesis.example.com/api/integrations/google_calendar/callback");
  assert("every provider produces a distinct callback",
    new Set(
      (["STRIPE", "PAYPAL", "MAILCHIMP", "QUICKBOOKS", "PRINTFUL"] as const).map((p) =>
        integrationCallbackUrl("https://x.test", p)
      )
    ).size === 5,
    "two providers sharing a callback would cross their OAuth returns");

  // ==========================================================================
  console.log("\n=== 3. A task opens with something true ===\n");
  // ==========================================================================
  const noProducts = buildTaskSeedMessage({ dedupeKey: "task.no_products", summary: "unused" });
  assert("the no-products task names the real gap", noProducts.includes("don't have any products"));
  assert("and asks for what it actually needs", noProducts.includes("what you'd like to sell"));

  // The SEO one is honest that it applies the change rather than proposing it,
  // because update_seo is genuinely auto-execute tiered.
  const noSeo = buildTaskSeedMessage({ dedupeKey: "task.no_seo", summary: "unused" });
  assert("the SEO task says it will apply the change itself", noSeo.includes("apply them for you"),
    "update_seo is auto-execute tiered, and saying 'I'll propose it' would be false");

  // THE FALLBACK. A detector added without a bespoke line must still open from
  // its own real summary rather than with an invented claim.
  const unknown = buildTaskSeedMessage({
    dedupeKey: "task.some_future_detector",
    summary: "Three orders have been waiting more than a week.",
  });
  assert("an unmapped task opens from its own real summary",
    unknown.startsWith("Three orders have been waiting more than a week."), unknown);
  assert("and asks rather than asserting what J4 will do",
    unknown.includes("What would you like to do?"), unknown);
  assert("never claiming knowledge it does not have",
    !/I already|I have looked|I noticed earlier/i.test(unknown), unknown);

  // ==========================================================================
  console.log("\n=== 4. The owner's own line is a statement, not a quote ===\n");
  // ==========================================================================
  const userLine = buildTaskUserMessage({ title: "Add your first product" });
  check("it states what they did", userLine, "Let's work on: Add your first product");
  assert("rather than fabricating a first-person request",
    !userLine.startsWith("I want") && !userLine.startsWith("Can you"),
    "a message written on the owner's behalf must not put words in their mouth");

  // ==========================================================================
  console.log("\n=== 5. Coming back is acknowledged, not restated ===\n");
  // ==========================================================================
  const recap = buildTaskRecapMessage({ title: "Add your first product" });
  assert("it names the task being resumed", recap.includes("Add your first product"));
  assert("signals that nothing was lost", recap.includes("still right here"),
    "the owner should never feel like they are starting over");
  assert("and restates none of the prior conversation",
    !/we discussed|you said|last time you/i.test(recap),
    "the real prior turns are already visible above it; inventing specifics is the risk");
  // ==========================================================================
  console.log("\n=== 6. A task key nobody wrote is still an honest opening ===\n");
  // ==========================================================================
  // dedupeKey is a free string on a DB row, so a bare Record lookup resolved
  // "constructor" to the inherited Object constructor — truthy, so the honest
  // fallback above never fired and a FUNCTION became the first line J4 says in
  // that conversation. The fallback is the entire point of this function, and a
  // bare lookup was the one way to skip it.
  for (const dedupeKey of ["constructor", "toString", "__proto__", "valueOf"]) {
    const seeded = buildTaskSeedMessage({ dedupeKey, summary: "Three orders are waiting." });
    assert(`"${dedupeKey}" still opens from the task's own summary`,
      seeded.startsWith("Three orders are waiting."), seeded);
    assert(`and never returns a function (${dedupeKey})`, typeof seeded === "string", typeof seeded);
  }


  console.log(`\n${failures === 0 ? "All copy-and-url assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
