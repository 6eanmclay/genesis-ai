import {
  computeAnthropicCost,
  computeImageCost,
  computeVoiceSynthesisCost,
} from "@/lib/aiPricing";

// WHAT A CALL COST — and what "unknown" costs:
//
//   npx tsx scripts/verify-ai-pricing.ts
//
// Every figure in the operator's cost reporting (verified separately in
// verify-ai-usage-live.ts) is only as good as this, because this is where a
// token count becomes dollars. Pure arithmetic over a rate table, no I/O.
//
// THE HONESTY PROPERTY IS THE NULL. A model missing from the rate table returns
// null rather than throwing and rather than 0, and the module says exactly why:
// "a null costUsd on a real AiUsageEvent row means 'a real call happened, its
// dollar cost isn't known yet,' not 'free.'"
//
// That distinction is the whole point. A new model shipped before its rate is
// added would, under a `?? 0` fallback, quietly make the platform look cheaper
// the more it was used — the exact moment an operator most needs the number to
// be right. Null propagates as unknown; zero propagates as a lie.
//
// The rates themselves are deliberately NOT asserted against published prices —
// they are documented as real-but-adjustable, and pinning them here would turn a
// rate change into a test failure. What is asserted is the arithmetic and the
// refusals.

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

const MODEL = "claude-opus-4-8";

// ============================================================================
console.log("\n=== 1. An unknown model costs 'unknown', never nothing ===\n");
// ============================================================================
check("a model with no rate returns null",
  computeAnthropicCost({ model: "claude-something-unreleased", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
  null);
assert(
  "not zero, which would make heavy use of a new model look free",
  computeAnthropicCost({ model: "claude-something-unreleased", inputTokens: 5_000_000, outputTokens: 5_000_000 }) !== 0,
  "null propagates as unknown; zero propagates as a lie"
);
check("an unknown image model likewise", computeImageCost("dall-e-99", 10), null);
check("and an unknown voice model", computeVoiceSynthesisCost("eleven_future_v9", 10_000), null);
check("an empty model name is not a free model", computeAnthropicCost({ model: "", inputTokens: 1, outputTokens: 1 }), null);

// A near-miss is the realistic case — a model string that differs by a suffix.
check("a near-miss model name is still unknown",
  computeAnthropicCost({ model: `${MODEL}-preview`, inputTokens: 1, outputTokens: 1 }), null);

// ============================================================================
console.log("\n=== 2. A known model costs what its rate says ===\n");
// ============================================================================
const oneMillionEach = computeAnthropicCost({ model: MODEL, inputTokens: 1_000_000, outputTokens: 1_000_000 });
assert("a known model produces a real number", oneMillionEach !== null && Number.isFinite(oneMillionEach));
assert("and a positive one", (oneMillionEach ?? 0) > 0);

// The rates are documented as adjustable, so the ARITHMETIC is asserted rather
// than the prices: the cost must scale linearly with tokens.
const half = computeAnthropicCost({ model: MODEL, inputTokens: 500_000, outputTokens: 500_000 })!;
assert("half the tokens cost half as much",
  Math.abs(half * 2 - (oneMillionEach ?? 0)) < 1e-9, `${half} vs ${oneMillionEach}`);

const doubled = computeAnthropicCost({ model: MODEL, inputTokens: 2_000_000, outputTokens: 2_000_000 })!;
assert("and twice the tokens cost twice as much",
  Math.abs(doubled - (oneMillionEach ?? 0) * 2) < 1e-9, `${doubled} vs ${oneMillionEach}`);

// Input and output are billed at different rates, so they must not be pooled.
const inputOnly = computeAnthropicCost({ model: MODEL, inputTokens: 1_000_000, outputTokens: 0 })!;
const outputOnly = computeAnthropicCost({ model: MODEL, inputTokens: 0, outputTokens: 1_000_000 })!;
assert("input and output are priced separately", inputOnly !== outputOnly,
  `${inputOnly} vs ${outputOnly} — pooling them would misprice every call`);
assert("output is the dearer of the two", outputOnly > inputOnly,
  "generation costs more than reading, and a swap would understate every bill");
assert("and the two together are the whole cost",
  Math.abs(inputOnly + outputOnly - (oneMillionEach ?? 0)) < 1e-9);

// ============================================================================
console.log("\n=== 3. Nothing used costs nothing ===\n");
// ============================================================================
// A real zero, distinct from the unknown above: the model IS known, and no
// tokens were spent.
check("a known model with no tokens costs zero",
  computeAnthropicCost({ model: MODEL, inputTokens: 0, outputTokens: 0 }), 0);
assert("which is a number, unlike an unknown model",
  computeAnthropicCost({ model: MODEL, inputTokens: 0, outputTokens: 0 }) !== null,
  "zero-spend and unknown-rate are different facts and must not collapse");

check("zero images cost zero", computeImageCost("gpt-image-1", 0), 0);
check("and zero characters cost zero", computeVoiceSynthesisCost("eleven_flash_v2_5", 0), 0);

// ============================================================================
console.log("\n=== 4. Images and speech scale by their own unit ===\n");
// ============================================================================
const oneImage = computeImageCost("gpt-image-1", 1)!;
assert("one image has a real cost", oneImage > 0);
assert("four images cost four times as much",
  Math.abs(computeImageCost("gpt-image-1", 4)! - oneImage * 4) < 1e-9);

const shortSpeech = computeVoiceSynthesisCost("eleven_flash_v2_5", 1_000)!;
assert("a thousand characters has a real cost", shortSpeech > 0);
assert("ten thousand costs ten times as much",
  Math.abs(computeVoiceSynthesisCost("eleven_flash_v2_5", 10_000)! - shortSpeech * 10) < 1e-9);

// A long reply is a real cost, not a rounding error — the reason voice is
// metered per character at all.
assert("a long spoken answer is materially more than a short one",
  computeVoiceSynthesisCost("eleven_flash_v2_5", 20_000)! > shortSpeech * 15);

// ============================================================================
console.log("\n=== 5. The three meters are independent ===\n");
// ============================================================================
// Each provider is priced on its own unit, and passing a model to the wrong
// meter must not silently produce a number.
check("a text model is not an image model", computeImageCost(MODEL, 1), null);
check("nor a voice model", computeVoiceSynthesisCost(MODEL, 1_000), null);
check("and an image model is not a text model",
  computeAnthropicCost({ model: "gpt-image-1", inputTokens: 1_000, outputTokens: 1_000 }), null);
assert(
  "so a mis-routed call is reported as unknown rather than mispriced",
  computeImageCost(MODEL, 1) === null,
  "a plausible wrong number is worse than an honest absence"
);
// ============================================================================
console.log("\n=== An unknown model is null, and never NaN ===\n");
// ============================================================================
// All three rate tables were bare Record lookups, and all three produced NaN
// rather than null for an inherited property key. Confirmed by running it:
//
//     computeAnthropicCost({ model: "constructor", ... })  ->  NaN
//     computeAnthropicCost({ model: "not-a-model", ... })  ->  null
//
// The truthy guard let the Object CONSTRUCTOR through, `rate.input` was
// undefined, and the arithmetic produced NaN. This file's own contract makes
// that the wrong answer twice over: "a null costUsd on a real AiUsageEvent row
// means 'a real call happened, its dollar cost isn't known yet,' not 'free'."
// NaN is neither — and unlike null it does not stay put, because one NaN turns
// every subsequent SUM over that store's costs into NaN as well.
const NOT_MODELS = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];
for (const model of NOT_MODELS) {
  check(`"${model}" is not a text model`,
    computeAnthropicCost({ model, inputTokens: 1_000, outputTokens: 1_000 }), null);
  check(`"${model}" is not an image model`, computeImageCost(model, 1), null);
  check(`"${model}" is not a voice model`, computeVoiceSynthesisCost(model, 1_000), null);
}
assert(
  "so no prototype key can put NaN into a cost column",
  NOT_MODELS.every((m) =>
    computeAnthropicCost({ model: m, inputTokens: 1, outputTokens: 1 }) === null &&
    computeImageCost(m, 1) === null &&
    computeVoiceSynthesisCost(m, 1) === null
  ),
  "one NaN poisons every SUM after it, which is how unknown becomes uncountable"
);

// And the honest answers are still real numbers, so the guard above cannot have
// been achieved by refusing everything.
assert("a real model still costs a real amount",
  Number.isFinite(computeAnthropicCost({ model: MODEL, inputTokens: 1_000, outputTokens: 1_000 }) ?? NaN),
  String(computeAnthropicCost({ model: MODEL, inputTokens: 1_000, outputTokens: 1_000 })));


console.log(`\n${failures === 0 ? "All AI-pricing assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
