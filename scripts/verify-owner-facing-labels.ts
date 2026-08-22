import { COGNITIVE_OUTPUT_KIND_LABEL } from "@/lib/dashboard/cognitiveOutputLabels";
import { CognitiveOutputItemSchema } from "@/lib/intelligence/cognitiveLayer";
import { callGenesisAction, GENESIS_NETWORK_FAILURE_MESSAGE } from "@/lib/dashboard/submitGenesisAction";

// TWO SMALL SURFACES BETWEEN GENESIS AND THE OWNER:
//
//   npx tsx scripts/verify-owner-facing-labels.ts
//
// Neither had coverage, and both fail in the same quiet way — by showing a
// person the machine's own vocabulary, or by swallowing something that was
// never an error.
//
// COGNITIVE_OUTPUT_KIND_LABEL is "one shared source of truth for how a
// CognitiveOutput.kind becomes an owner-facing label", existing so DiscoveryFeed
// and ActivityFeed "can never drift into independently hand-copied
// vocabularies". It is a hand-maintained mirror of the kinds the system actually
// writes, and a kind with no label reaches ActivityFeed's fallback — which
// renders the raw string. Its own comment records that happening: "insight" was
// real, written by computeInsights via communicate_finding, and "had no label
// anywhere in the product until this pass."
//
// callGenesisAction is the one place a browser-level network failure on a Server
// Action is catchable at all — real evidence from Sentry breadcrumbs, a 42-61s
// hang ending in "TypeError: Failed to fetch", far past the function timeout and
// invisible to every provider-error classification because that code never ran.
//
// THE PROPERTY IT TURNS ON is unstable_rethrow. Next signals redirect() and
// notFound() by THROWING, and almost every caller here ends in a redirect. A
// catch that swallowed those would turn every redirect-terminated action into
// one that silently does nothing — no error, no navigation, the owner left
// looking at a form that appears to have worked. That is a worse failure than
// the one this function exists to handle.

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

/** The kinds the Cognitive Layer's own output union can emit. */
const schemaKinds: string[] = (
  CognitiveOutputItemSchema.options as { shape: { kind: { value: string } } }[]
).map((option) => option.shape.kind.value);

/**
 * Kinds written directly in code rather than by the model.
 *
 * Named here rather than derived, because they are `kind: "prediction"` string
 * literals at real call sites — cognitiveLayer's goal-progress write, the Daily
 * Operating Rhythm briefing, and computeInsights' communicate_finding. Listing
 * them is the honest option: the alternative is deriving nothing and asserting
 * nothing about exactly the kinds that produced this map's one recorded gap.
 */
const WRITTEN_IN_CODE = ["prediction", "briefing", "insight"];

async function main() {
  // ==========================================================================
  console.log("\n=== 1. Every kind Genesis can produce has an owner's word for it ===\n");
  // ==========================================================================
  assert("the output union emits real kinds", schemaKinds.length > 0, JSON.stringify(schemaKinds));

  const unlabelledFromSchema = schemaKinds.filter((k) => !COGNITIVE_OUTPUT_KIND_LABEL[k]);
  check("every kind the model can emit is labelled", unlabelledFromSchema, []);

  const unlabelledFromCode = WRITTEN_IN_CODE.filter((k) => !COGNITIVE_OUTPUT_KIND_LABEL[k]);
  check("and every kind written directly in code", unlabelledFromCode, []);
  assert(
    "so ActivityFeed's fallback never renders a raw kind string at a merchant",
    unlabelledFromSchema.length === 0 && unlabelledFromCode.length === 0,
    'this map\'s own comment records "insight" having been exactly that gap'
  );

  // ==========================================================================
  console.log("\n=== 2. The labels are words, not identifiers ===\n");
  // ==========================================================================
  const entries = Object.entries(COGNITIVE_OUTPUT_KIND_LABEL);
  const empty = entries.filter(([, label]) => !label.trim());
  check("no label is empty", empty, []);

  const looksLikeAKey = entries.filter(([kind, label]) => label === kind);
  check("no label is just its own kind", looksLikeAKey, []);
  const snake = entries.filter(([, label]) => label.includes("_"));
  check("nor a snake_case identifier", snake, []);
  const lowercased = entries.filter(([, label]) => label[0] !== label[0].toUpperCase());
  check("every label starts as a sentence does", lowercased, []);

  // Two kinds sharing a label would make two different things read as one.
  const labels = entries.map(([, label]) => label);
  check("and no two kinds share a label", new Set(labels).size, labels.length);

  // The two that are deliberately NOT the machine's word, because the machine's
  // word would tell an owner nothing.
  check("an explanation is offered as something worth understanding",
    COGNITIVE_OUTPUT_KIND_LABEL.explanation, "Worth understanding");
  check("and a prediction as goal progress",
    COGNITIVE_OUTPUT_KIND_LABEL.prediction, "Goal progress");

  // ==========================================================================
  console.log("\n=== 3. A real failure is caught ===\n");
  // ==========================================================================
  const ok = await callGenesisAction(async () => "done");
  check("a successful action returns its value", ok, { ok: true, value: "done" });

  const failed = await callGenesisAction(async () => {
    throw new TypeError("Failed to fetch");
  });
  check("a network failure becomes a message rather than a crash",
    failed, { ok: false, message: GENESIS_NETWORK_FAILURE_MESSAGE });
  assert("and the message says nothing was lost",
    GENESIS_NETWORK_FAILURE_MESSAGE.includes("Nothing you've already done was lost"),
    GENESIS_NETWORK_FAILURE_MESSAGE);
  assert("without naming a provider, a status code or a stack",
    !/\b(500|502|504|anthropic|claude|vercel|TypeError)\b/i.test(GENESIS_NETWORK_FAILURE_MESSAGE),
    "spoken, not logged — a raw error is never shown verbatim");

  // A thrown non-Error is still a failure, not a success.
  const threwString = await callGenesisAction(async () => {
    throw "something";
  });
  check("a thrown non-Error is still a failure", threwString.ok, false);

  // ==========================================================================
  console.log("\n=== 4. A redirect is not a failure ===\n");
  // ==========================================================================
  // THE PROPERTY THAT MATTERS MOST HERE. Next signals redirect() and notFound()
  // by throwing, and nearly every caller of this ends in a redirect. Swallowing
  // one would leave the owner looking at a form that appears to have worked and
  // did nothing at all — a worse failure than the one being handled.
  const { redirect, notFound } = await import("next/navigation");

  let redirectEscaped = false;
  try {
    await callGenesisAction(async () => {
      redirect("/dashboard");
    });
  } catch {
    redirectEscaped = true;
  }
  assert("a redirect is re-thrown rather than caught", redirectEscaped,
    "unstable_rethrow re-throws Next's own control-flow signals and is a no-op for a real error");

  let notFoundEscaped = false;
  try {
    await callGenesisAction(async () => {
      notFound();
    });
  } catch {
    notFoundEscaped = true;
  }
  assert("and so is notFound", notFoundEscaped);

  // The distinction is the whole point: a real error must NOT escape.
  let realErrorEscaped = false;
  try {
    await callGenesisAction(async () => {
      throw new Error("a genuine failure");
    });
  } catch {
    realErrorEscaped = true;
  }
  assert("while a genuine error is still swallowed into a message", !realErrorEscaped,
    "if both escaped, this function would do nothing at all");

  console.log(`\n${failures === 0 ? "All owner-facing-label assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
