import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  approvalRef, taskRef, observationRef, sameItem, ATTENTION_SOURCES,
  type AttentionRef,
} from "@/lib/attention/identity";
import {
  isDeferred, deferredUntil, DEFERRAL_WINDOW_MS, DEFERRED_TREATMENT,
  type Deferral,
} from "@/lib/attention/deferral";

// ONE NAME FOR ONE THING, AND "NOT NOW" THAT TRAVELS (2026-09-13).
//
//   npx tsx scripts/verify-attention-identity.ts
//
// ============ WHAT THIS SUITE IS FOR ==================================
//
// scripts/audit-attention-surfaces.ts proved, on two rendered surfaces, that
// the Business arrival and the Office name the same rows differently and that
// a dismissal on one is invisible to the other. This holds the contract that
// fixes it — before either surface consumes it, so the contract can be argued
// with on its own.
//
// Nothing here renders. The cross-surface regression, on real pages, is its
// own later commit; this is the layer underneath it.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const root = process.cwd();
const APPROVAL_ID = "cmtzcyo1s0005lw0j4dkgkk6c";
const TASK_ID = "cmtzcyo200006lw0je5tqc9hx";
const OBS_ID = "cmtzcyo2b0008lw0jukrgzhbv";
const OBS_DEDUPE_KEY = "audit:obs:1:1789276386796";

// ============================================================================
console.log("\n=== 1. A ref is the underlying row, and nothing else ===\n");
// ============================================================================
//
// The three ids and the dedupeKey above are the REAL values the audit read off
// the rendered pages, so these assertions are written against what the product
// actually produced rather than against invented strings.
check("an approval is named by ApprovalRequest.id",
  approvalRef(APPROVAL_ID).id === APPROVAL_ID && approvalRef(APPROVAL_ID).source === "approval",
  JSON.stringify(approvalRef(APPROVAL_ID)));
check("a task is named by Task.id",
  taskRef(TASK_ID).id === TASK_ID && taskRef(TASK_ID).source === "task",
  JSON.stringify(taskRef(TASK_ID)));
check("an observation is named by GenesisObservation.id",
  observationRef(OBS_ID).id === OBS_ID && observationRef(OBS_ID).source === "observation",
  JSON.stringify(observationRef(OBS_ID)));

// THE DEFECT, RESTATED AS AN ASSERTION. The arrival wrote
// "observation:<dedupeKey>" for this row while the Office rendered its id.
// A ref built from the dedupeKey is a DIFFERENT item from a ref built from the
// row, and that is the whole bug: two surfaces, two names, one record.
check("the dedupeKey is not the identity",
  !sameItem(observationRef(OBS_ID), observationRef(OBS_DEDUPE_KEY)),
  "observation:<dedupeKey> named a different thing from the row it came from");

// AND THE SAME ROW IS THE SAME ITEM WHOEVER BUILT THE REF. The arrival and
// the Office each construct their own; equality must not depend on which.
check("both surfaces building a ref for one row get the same item",
  sameItem(approvalRef(APPROVAL_ID), approvalRef(APPROVAL_ID)));
check("two sources with the same id are not the same item",
  !sameItem(taskRef("x"), observationRef("x")),
  "source is part of identity — ids are only unique within a table");

// ============================================================================
console.log("\n=== 2. There is nothing to parse ===\n");
// ============================================================================
//
// Sean: "Do not solve this with string parsing, prefix stripping, headline
// matching, or ID inference."
//
// The structural guarantee is that a ref has no encoded form. If no function
// here returns a combined string, no caller can be tempted to take one apart —
// which is how "proposal:<id>" and "observation:<dedupeKey>" came to exist in
// the first place. Comments stripped first: this file's own header quotes the
// old spellings, and prose is not code.
const identitySource = readFileSync(join(root, "lib", "attention", "identity.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
check("identity.ts builds no combined key string",
  !/\$\{[^}]*\}:|\+\s*":"|":"\s*\+/.test(identitySource),
  "a ref travels as two fields, so there is no encoded form to split");
check("  and parses nothing",
  !/\.split\(|\.replace\(|\.startsWith\(|\.slice\(|indexOf\(/.test(identitySource),
  "no string operation of any kind on an identity");
check("  the module has no value imports",
  !/^import\s+(?!type)/m.test(identitySource),
  "pure contract — a client component can hold it, like officeSections.ts");

const deferralSource = readFileSync(join(root, "lib", "attention", "deferral.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
check("deferral.ts parses nothing either",
  !/\.split\(|\.startsWith\(|indexOf\(/.test(deferralSource),
  "it matches on source + sourceId, never on a key");
check("  and imports only types",
  !/^import\s+(?!type)/m.test(deferralSource));

// ============================================================================
console.log("\n=== 3. Every source can be named ===\n");
// ============================================================================
//
// The point of the set: a future surface — Commerce's "what needs doing" —
// consumes this layer instead of inventing a fourth way to name these rows.
// A new population has to be added here AND given a builder.
check("the three real populations are the three sources",
  JSON.stringify([...ATTENTION_SOURCES].sort()) === JSON.stringify(["approval", "observation", "task"]),
  ATTENTION_SOURCES.join(" | "));
const builders: Record<string, (id: string) => AttentionRef> = {
  approval: approvalRef, task: taskRef, observation: observationRef,
};
for (const source of ATTENTION_SOURCES) {
  check(`  ${source} has a builder that produces its own source`,
    builders[source]?.("id-1").source === source,
    builders[source] ? "" : "NO BUILDER");
}

// ============================================================================
console.log("\n=== 4. \"Not now\" is about the item, not the screen ===\n");
// ============================================================================
const now = new Date("2026-09-13T12:00:00Z");
const justNow = new Date(now.getTime() - 60_000);
const deferrals: Deferral[] = [{ source: "approval", sourceId: APPROVAL_ID, deferredAt: justNow }];

// THE FINDING THE AUDIT PROVED, INVERTED. On the rendered page, dismissing
// this approval on the arrival left the Office showing it. Under this contract
// there is only one question and both surfaces ask it the same way.
check("an approval deferred anywhere is deferred everywhere",
  isDeferred(approvalRef(APPROVAL_ID), deferrals, now),
  "one question, asked with the row's own id");
check("  and nothing else is swept up with it",
  !isDeferred(taskRef(TASK_ID), deferrals, now) && !isDeferred(observationRef(OBS_ID), deferrals, now));
check("  nor is a different row of the same kind",
  !isDeferred(approvalRef("some-other-approval"), deferrals, now));

// SEVEN DAYS, THE SAME SEVEN DAYS. Not a new rule — the existing dismissal
// window, moved to where both surfaces can see it.
check("the window is the one the product already used",
  DEFERRAL_WINDOW_MS === 7 * 24 * 60 * 60 * 1000, `${DEFERRAL_WINDOW_MS}ms`);
const old: Deferral[] = [{ source: "approval", sourceId: APPROVAL_ID, deferredAt: new Date(now.getTime() - DEFERRAL_WINDOW_MS - 1) }];
check("a deferral older than the window has expired",
  !isDeferred(approvalRef(APPROVAL_ID), old, now));
const edge: Deferral[] = [{ source: "approval", sourceId: APPROVAL_ID, deferredAt: new Date(now.getTime() - DEFERRAL_WINDOW_MS + 1000) }];
check("  and one a second inside it has not",
  isDeferred(approvalRef(APPROVAL_ID), edge, now));

// SO A SURFACE CAN SAY SOMETHING TRUE, rather than only grey a row out.
const until = deferredUntil(approvalRef(APPROVAL_ID), deferrals, now);
check("a deferred item knows when it comes back",
  until !== null && until.getTime() === justNow.getTime() + DEFERRAL_WINDOW_MS,
  until?.toISOString() ?? "null");
check("  and an undeferred one returns null",
  deferredUntil(taskRef(TASK_ID), deferrals, now) === null);
check("  as does an expired one",
  deferredUntil(approvalRef(APPROVAL_ID), old, now) === null);

// ============================================================================
console.log("\n=== 5. Shared eligibility, contextual presentation ===\n");
// ============================================================================
//
// The architecture Sean chose, held as a fact rather than as an intention:
// both surfaces get the same answer to "is it deferred" and are allowed
// different answers to "what do I do about it".
check("Business may suppress a deferred item", DEFERRED_TREATMENT.business === "suppress");
check("the Office shows it, marked", DEFERRED_TREATMENT.office === "show_marked",
  "the Office is where an owner goes to see the complete working picture");
check("  the two surfaces are not forced to render alike",
  DEFERRED_TREATMENT.business !== DEFERRED_TREATMENT.office,
  "eligibility is shared; presentation is contextual");

// ============================================================================
console.log("\n=== 6. The surfaces consume this, and it is their only route ===\n");
// ============================================================================
//
// THIS SECTION USED TO ASSERT THE OPPOSITE, and it was right to (2026-09-13).
//
// At the contract commit nothing consumed this layer, and saying so here
// stopped the suite being read as proof of a behaviour change it did not make.
// The surface migration then made that assertion false, and it failed in the
// regression rather than quietly going stale — which is exactly what a
// transitional assertion is for.
//
// What replaces it is the permanent version of the same care: the two
// surfaces reach this state THROUGH this module, and neither keeps a query of
// its own. verify-attention-consumption proves the behaviour on rendered
// pages; this proves there is only one door to it.
const consumers = ["app/dashboard/HomeWorkspace.tsx", "app/j4/intelligence-actions.ts"];
for (const rel of consumers) {
  const src = readFileSync(join(root, rel), "utf8");
  check(`${rel} reads the shared state`,
    /loadOwnerAttentionState/.test(src),
    "one owner-level question, asked once per surface");
  check(`  and never queries DismissedAttentionCard itself`,
    !/dismissedAttentionCard/i.test(src),
    "a second query is how two surfaces come to disagree");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
process.exit(failed.length === 0 ? 0 : 1);
