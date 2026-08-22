import { getSurface } from "@/lib/design/surfaces";
import { growthCreditValueFor } from "@/lib/growthCreditCatalog";
import { growthPointPackage } from "@/lib/growthPoints/purchaseCatalog";
import { resolveAssetContentType } from "@/lib/businessAssets/uploadAssetFile";
import { computeAnthropicCost, computeImageCost, computeVoiceSynthesisCost } from "@/lib/aiPricing";
import { buildTaskSeedMessage } from "@/lib/dashboard/taskConversation";
import { resolveWorkspaceContext } from "@/lib/j4/workspaceContext";
import { isStorefrontTarget } from "@/lib/storefront/targets";
import { isRefinableDimension } from "@/lib/storefront/dimensions";
import type { AiFeature } from "@/lib/aiFeatures";

// THE INHERITED-PROPERTY SWEEP:
//
//   npx tsx scripts/verify-registry-lookups.ts
//
// One class of defect, found six times in a single day, in six unrelated parts
// of the codebase. Every instance was the same two lines:
//
//     const x = SOME_REGISTRY[key];   // key comes from outside
//     if (!x) return null;            // or `x ?? fallback`, or `x === undefined`
//
// A plain object inherits from Object.prototype, so `SOME_REGISTRY["constructor"]`
// is a FUNCTION rather than undefined. Functions are truthy. They are not
// `undefined`. They are not `null`. So they walk straight through every guard
// of that shape and come back typed as whatever the signature promised.
//
// WHAT THAT ACTUALLY DID, in the six places it was found:
//
//   * a function was interpolated into a live Claude prompt, and really billed
//   * `price: undefined` reached a live Stripe checkout.sessions.create
//   * a function was written into a merchant's ExecutionLog as their error
//   * a TypeError killed a whole chat turn instead of dropping one bad capture
//   * an uploaded file resolved to a function instead of being refused
//   * a cost came back NaN instead of null, which then poisons every SUM after it
//
// None of them was a type error. Every signature said `string | null` or
// `number | null` and every one of them was capable of returning a function.
//
// This file is the standing guard. It is deliberately NOT a lint rule: the shape
// is legitimate wherever the key is a closed union, and a rule broad enough to
// catch the dangerous cases would flag dozens of safe ones. Instead it exercises
// every lookup that takes a FREE STRING from outside — a filename, a URL param,
// a model's output, a DB column — with the prototype keys, and asserts each
// gives its own honest refusal.
//
// The rule for anything added later: if a caller can hand you a string you did
// not define, use Object.prototype.hasOwnProperty.call, and check the SHAPE of
// what you got rather than its truthiness.

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

/** Everything a plain object inherits, plus the one people forget. */
const PROTOTYPE_KEYS = [
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__proto__",
  "__defineGetter__",
];

/** A lookup that must refuse every prototype key. */
interface Guarded {
  what: string;
  /** Returns whatever the real function returns for this key. */
  call: (key: string) => unknown;
  /** What an honest refusal looks like here. */
  refusal: unknown;
}

const GUARDED: Guarded[] = [
  { what: "a design surface", call: (k) => getSurface(k), refusal: null },
  { what: "a growth credit value", call: (k) => growthCreditValueFor(k as AiFeature), refusal: null },
  { what: "a Growth Point package", call: (k) => growthPointPackage(k), refusal: null },
  { what: "an upload's content type (by extension)", call: (k) => resolveAssetContentType({ type: "", name: `f.${k}` }), refusal: null },
  { what: "an upload's content type (by reported type)", call: (k) => resolveAssetContentType({ type: k, name: "f.zzz" }), refusal: null },
  { what: "a text model's cost", call: (k) => computeAnthropicCost({ model: k, inputTokens: 10, outputTokens: 10 }), refusal: null },
  { what: "an image model's cost", call: (k) => computeImageCost(k, 1), refusal: null },
  { what: "a voice model's cost", call: (k) => computeVoiceSynthesisCost(k, 10), refusal: null },
  { what: "a workspace", call: (k) => resolveWorkspaceContext(k), refusal: null },
];

// ============================================================================
console.log("\n=== 1. Every free-string lookup refuses what it never defined ===\n");
// ============================================================================
for (const { what, call, refusal } of GUARDED) {
  for (const key of PROTOTYPE_KEYS) {
    check(`${what}: "${key}"`, call(key), refusal);
  }
}

// ============================================================================
console.log("\n=== 2. Nothing ever returns a function ===\n");
// ============================================================================
// The assertion that names the actual failure. "Is it null" would pass against
// a lookup that returned 0, "" or NaN; this one says what went wrong every time.
const leaked = GUARDED.flatMap(({ what, call }) =>
  PROTOTYPE_KEYS.filter((key) => typeof call(key) === "function").map((key) => `${what} <- ${key}`)
);
check("no lookup hands back an inherited function", leaked, []);

// NaN is its own failure, and a worse one than a function in the cost tables:
// null stays put, NaN spreads through every sum it touches.
const nannish = PROTOTYPE_KEYS.flatMap((key) =>
  [
    ["text", computeAnthropicCost({ model: key, inputTokens: 10, outputTokens: 10 })],
    ["image", computeImageCost(key, 1)],
    ["voice", computeVoiceSynthesisCost(key, 10)],
  ]
    .filter(([, v]) => typeof v === "number" && Number.isNaN(v))
    .map(([kind]) => `${kind} <- ${key}`)
);
check("and no cost comes back NaN", nannish, []);

// ============================================================================
console.log("\n=== 3. The honest fallbacks still fire ===\n");
// ============================================================================
// A guard that refused everything would pass section 1 and be useless. These
// prove the surrounding behaviour is intact.
for (const key of PROTOTYPE_KEYS) {
  const seeded = buildTaskSeedMessage({ dedupeKey: key, summary: "Three orders are waiting." });
  assert(`a task keyed "${key}" still opens from its own summary`,
    typeof seeded === "string" && seeded.startsWith("Three orders are waiting."), String(seeded));
}

assert("a real design surface still resolves", getSurface("garment.tshirt") !== null,
  "if this ever goes null the sweep above is passing for the wrong reason");
assert("a real model still prices", typeof computeAnthropicCost({ model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 1000 }) === "number");
assert("a real workspace still resolves", resolveWorkspaceContext("/dashboard/website") !== null);

// ============================================================================
console.log("\n=== 4. The closed vocabularies already knew ===\n");
// ============================================================================
// These three were written with the discipline from the start, and are included
// so the sweep covers the whole family rather than only the places it failed.
for (const key of PROTOTYPE_KEYS) {
  assert(`"${key}" is not a storefront target`, !isStorefrontTarget(key));
  assert(`"${key}" is not a refinable dimension`, !isRefinableDimension(key));
}

console.log(`\n${failures === 0 ? "All registry-lookup assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
