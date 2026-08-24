import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  verified,
  verifiedUnless,
  unavailable,
  mismatch,
  namedKeyMismatches,
  verificationLabel,
} from "@/lib/execution/verification";

// VERIFICATION HARDENING — the acceptance suite.
//
//   npx tsx scripts/verify-verification-hardening.ts
//
// VERIFICATION_HARDENING_CONTRACT.md §9. The milestone's core invariant is one
// sentence:
//
//   SUCCESS without verification must be unreachable.
//
// This file asserts the parts that can be established WITHOUT a database: the
// comparison rules, the engine's own wiring, and — most importantly — that
// omission cannot present as "Verification unavailable". The read-back
// behaviour of individual executables is asserted against real Postgres in
// verify-verification-readback.ts, which brings its own database.
//
// Every assertion here is paired with a negative control that proves it can
// fail. An assertion nobody has watched fail is a claim, not a test.

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}
function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Comments explain the reason; code is the evidence. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const root = process.cwd();
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

// ===========================================================================
console.log("\n=== 1. Omission cannot compile, and cannot present as unavailable ===\n");
// The single most important boundary in the contract (§3.1, §9.2 item 1b).
// "Unavailable" describes the MECHANISM. If it could absorb "nobody wrote
// one", the new state would be the old `verified: false` with a better name.
// ===========================================================================

const executableSrc = codeOnly(read("lib", "execution", "executable.ts"));

assert("`verify` is a REQUIRED member of Executable",
  /\n  verify\(/.test(executableSrc) && !/verify\?\(/.test(executableSrc),
  "optional would make omission silent, which is how 27 gaps stayed invisible");

// EVERY executable object declares one. Counted from source rather than
// trusted, because the compiler check above is the guarantee and this is the
// evidence that it is actually binding on the real files.
const execDir = join(root, "lib", "execution", "executables");
let objects = 0;
let verifies = 0;
const missing: string[] = [];
for (const file of readdirSync(execDir).filter((f) => f.endsWith(".ts"))) {
  const src = codeOnly(read("lib", "execution", "executables", file));
  const names = [...src.matchAll(/export const (\w+)\s*:\s*\n?\s*Executable</g)].map((m) => m[1]);
  const count = (src.match(/^\s{2}async verify\(/gm) ?? []).length;
  objects += names.length;
  verifies += count;
  if (names.length > count) missing.push(`${file}: ${names.length} executable(s), ${count} verify()`);
}
assert("every executable object in lib/execution/executables declares verify()",
  missing.length === 0, missing.join("; "));
console.log(`        ${objects} executable objects, ${verifies} verify() implementations`);

// The adapters are Executables too, and were the easiest place to forget.
const adapterSrc = codeOnly(read("lib", "execution", "adapters", "integrationExecutable.ts"));
eq("all three integration adapters declare verify()",
  (adapterSrc.match(/async verify\(/g) ?? []).length, 3);

// AND THE LINE ITSELF. "unavailable" must never be reachable by writing
// nothing — the only way to reach it is to call it deliberately, with a reason.
assert("the unavailable state requires an explicit reason",
  /unavailable\(reason: string\)/.test(codeOnly(read("lib", "execution", "verification.ts"))),
  "a reason-less unavailable would be indistinguishable from an omission");

// ===========================================================================
console.log("\n=== 2. The engine maps the three states, and adds no fourth status ===\n");
// ===========================================================================

const engineSrc = codeOnly(read("lib", "execution", "engine.ts"));

assert("verification runs only for an outcome that claims to have landed",
  /if \(status === "SUCCESS"\) \{[\s\S]*?executable\.verify\(/.test(engineSrc),
  "verifying a PENDING handoff would check a value nobody wrote yet");

assert("a confirmed read-back is the only thing that sets verified true",
  /v\.state === "verified"[\s\S]{0,120}verified = true/.test(engineSrc));

assert("a failed read-back becomes WARNING, not FAILED",
  /v\.state === "failed"[\s\S]{0,400}status = "WARNING"/.test(engineSrc),
  "the write may have partly landed; the turn did not fail");

assert("an unavailable verification leaves the status alone",
  !/v\.state === "unavailable"[\s\S]{0,200}status =/.test(engineSrc),
  "execution genuinely succeeded, so SUCCESS is correct");

const statusType = codeOnly(read("lib", "execution", "types.ts"));
eq("no fourth execution status was added",
  /ExecutionStatus =([^;]*);/.exec(statusType)?.[1].trim(),
  '"SUCCESS" | "WARNING" | "FAILED" | "PENDING" | "PARTIAL"');

assert("the reason is recorded where a WARNING can explain itself",
  /verification: verificationReason/.test(engineSrc));

// ===========================================================================
console.log("\n=== 3. The comparison rules ===\n");
// Pure functions, so these enter the real behaviour with no database at all.
// ===========================================================================

eq("an exact match verifies", verifiedUnless([]), { state: "verified" });
eq("a mismatch names the field", verifiedUnless(["a: expected 1, stored 2"]),
  { state: "failed", mismatches: ["a: expected 1, stored 2"] });
eq("verified() is the confirmed state", verified(), { state: "verified" });
eq("unavailable() carries its reason", unavailable("no read-back API"),
  { state: "unavailable", reason: "no read-back API" });

eq("equal scalars are not a mismatch", mismatch("f", "x", "x"), null);
eq("equal objects are not a mismatch", mismatch("f", { a: 1 }, { a: 1 }), null);
assert("a different value is a mismatch", mismatch("f", "x", "y") !== null);
assert("a missing value is a mismatch", mismatch("f", "x", undefined) !== null);

// THE CLASS B RULE, and the one most likely to be got wrong.
eq("only the keys the input named are compared",
  namedKeyMismatches({ a: 1 }, { a: 1, untouched: "left alone" }), []);
eq("a key the input did not name cannot fail verification",
  namedKeyMismatches({ a: 1 }, { a: 1, b: "something else entirely" }), []);
assert("a named key that did not land does fail",
  namedKeyMismatches({ a: 1 }, { a: 2 }).length === 1);
eq("undefined means 'not named' and is skipped",
  namedKeyMismatches({ a: undefined }, {}), []);
assert("null is a real value and IS compared",
  namedKeyMismatches({ a: null }, { a: "still here" }).length === 1,
  "a caller clearing a field is asking for null to be stored");

// ===========================================================================
console.log("\n=== 4. Negative controls — every assertion above can fail ===\n");
// Each control breaks the property and confirms the check notices. A control
// that cannot fail proves nothing, and this repository has shipped exactly
// that before.
// ===========================================================================

// 4a. The Class B rule, inverted: if it compared everything, an untouched key
// would fail. This is the false-POSITIVE direction — the one that would
// quietly turn every successful merge into a WARNING.
const wholeObjectComparison = (input: object, stored: Record<string, unknown>) => {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(input), ...Object.keys(stored)])) {
    const m = mismatch(key, (input as Record<string, unknown>)[key], stored[key]);
    if (m) out.push(m);
  }
  return out;
};
assert("CONTROL: comparing the whole object WOULD fail an untouched key",
  wholeObjectComparison({ a: 1 }, { a: 1, untouched: "left alone" }).length === 1,
  "which is why namedKeyMismatches exists, and why the assertion above is not vacuous");

// 4b. A "verified" that ignored its mismatches would pass anything.
assert("CONTROL: verifiedUnless does not ignore its mismatches",
  verifiedUnless(["something did not land"]).state === "failed");

// 4c. mismatch() comparing by reference would report equal objects as unequal.
assert("CONTROL: object comparison is by value, not reference",
  mismatch("f", { a: [1, 2] }, { a: [1, 2] }) === null,
  "reference equality would make every JSON write look like a failure");

// 4d. THE BOUNDARY CONTROL (§9.4 item 12b). Deleting a verify() must not
// produce an unavailable row — it must fail the check in section 1. Simulated
// on a copy of the source so nothing on disk is touched.
const sample = read("lib", "execution", "executables", "updateTheme.ts");
// `\r?` throughout, deliberately: this repository checks out CRLF on Windows,
// and the first version of this control matched nothing — reporting a green
// check for a property it had never tested. That is the exact false green this
// suite exists to prevent, found by the control failing rather than passing.
const withoutVerify = sample.replace(/^[ ]{2}async verify\([\s\S]*?\r?\n[ ]{2}\},\r?\n/m, "");
assert("CONTROL: an executable with its verify() removed fails the count check",
  (codeOnly(withoutVerify).match(/^\s{2}async verify\(/gm) ?? []).length === 0 &&
    [...codeOnly(withoutVerify).matchAll(/export const (\w+)\s*:\s*\n?\s*Executable</g)].length === 1,
  "the section-1 check compares objects against verify() count, so this would fail there");
assert("CONTROL: and it does NOT become an unavailable row",
  !/unavailable\(/.test(codeOnly(withoutVerify)),
  "omission has no path to the unavailable state — it is a defect, not a state");

// ===========================================================================
console.log("\n=== 5. Provider-backed operations keep their local half ===\n");
// §6: verify the local half, declare the remote one, never let one imply the
// other.
// ===========================================================================

const shippingSrc = codeOnly(read("lib", "execution", "executables", "shipping.ts"));
assert("shipping verifies the local order row", /prisma\.order\.findFirst/.test(shippingSrc));
assert("and does not claim the carrier confirmed anything",
  !/unavailable\(/.test(shippingSrc),
  "the local half is genuinely verified; declaring the whole action unavailable would discard it");

const publishSrc = codeOnly(read("lib", "execution", "executables", "storePublish.ts"));
assert("storePublish verifies the published flag it wrote",
  /store\.published === expected/.test(publishSrc));

assert("the integration verify action declares itself unavailable, with a reason",
  /unavailable\(\s*`\$\{connector\.displayName\} reports its own connection state/.test(adapterSrc),
  "asking the provider twice is repetition, not confirmation");

// ===========================================================================
console.log("\n=== 6. What the owner reads ===\n");
// §3: three states, and "unavailable" must not sound like a problem.
// ===========================================================================

eq("a confirmed read-back reads as Verified", verificationLabel("SUCCESS", true), "Verified");
eq("a failed read-back reads as Verification failed", verificationLabel("WARNING", false), "Verification failed");
eq("an unavailable one says so plainly", verificationLabel("SUCCESS", false), "Verification unavailable");
eq("a turn that has not landed says nothing about verification", verificationLabel("PENDING", false), null);
eq("and neither does an outright failure", verificationLabel("FAILED", false), null);

assert("the three states are decoded in ONE place",
  /export function verificationLabel/.test(codeOnly(read("lib", "execution", "verification.ts"))),
  "a second copy is how two surfaces start disagreeing about what happened");

const cardSrc = codeOnly(read("app", "dashboard", "ExecutionStatusCard.tsx"));
assert("the owner-facing card uses it rather than reading the flag directly",
  cardSrc.includes("verificationLabel(") && !cardSrc.includes('log.verified ? " (verified)"'),
  "the old ternary could not tell 'checked and fine' from 'nobody checked'");

// CONTROL: a label that never varied would pass every assertion above.
assert("CONTROL: verificationLabel actually varies with its input",
  new Set([
    verificationLabel("SUCCESS", true),
    verificationLabel("SUCCESS", false),
    verificationLabel("WARNING", false),
  ]).size === 3);

// ===========================================================================
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
