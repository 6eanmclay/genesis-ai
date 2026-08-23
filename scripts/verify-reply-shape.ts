import { extractChangeList } from "@/app/j4/messageChanges";
import { readFileSync } from "fs";
import { join } from "path";

// WHAT A REPLY LEADS WITH (UI6 piece 3):
//
//   npx tsx scripts/verify-reply-shape.ts
//
// The list of what actually changed was a collapsed <details> labelled "See what
// changed", sitting under several paragraphs of model prose — the trustworthy
// half of a reply subordinate to the half that can be wrong.
//
// It is the trustworthy half BY CONSTRUCTION, and that is the whole argument.
// ai-actions.ts builds it server-side specifically to CORRECT the model's reply,
// whose own comment records it saying "Done" when execute() had actually failed.
//
// NO DATABASE AND NO MODEL. The parser is pure and the rest is the source of the
// two files that decide the shape — which is what would regress.

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

console.log("\n=== 1. The parser is untouched ===\n");
// Piece 3 changes how the list is SHOWN, never what counts as one. A message
// with no changes must render exactly as it did before.
check("a real list is read", extractChangeList(["Changed the palette", "Rewrote the tagline"]),
  ["Changed the palette", "Rewrote the tagline"]);
check("no changes is null", extractChangeList(null), null);
check("an object of artefacts is not a change list", extractChangeList({ imageUrl: "x" }), null);
check("and non-strings are dropped", extractChangeList(["real", 3, null]), ["real"]);

console.log("\n=== 2. The list is primary, not an aside ===\n");
const workspace = readFileSync(join(process.cwd(), "app", "j4", "J4Workspace.tsx"), "utf8");
assert("the change list is no longer collapsed behind a disclosure",
  !workspace.includes("See what changed"),
  "a <details> labelled 'See what changed' makes the authoritative half optional to read");
assert("it renders as a plain list, open",
  workspace.includes('data-role="change-list"'),
  "the marker the shape is asserted on");
// It sits with the reply rather than in the secondary text colour the aside used.
assert("and not in the muted aside colour",
  !/data-role="change-list"[\s\S]{0,200}textSecondary/.test(workspace),
  "the trustworthy half should not read as a footnote");

console.log("\n=== 3. J4 writes the sentence and never the list ===\n");
const actions = readFileSync(join(process.cwd(), "app", "dashboard", "ai-actions.ts"), "utf8");
assert("the prompt asks for one lead sentence",
  actions.includes("LEAD WITH ONE SENTENCE."),
  "the prose is the half that shortens");
assert("and explicitly forbids enumerating the changes",
  actions.includes("Do NOT enumerate the individual changes"),
  "repeating the list in prose makes the owner read the same thing twice");
// THE PROPERTY THIS PIECE MUST NOT WEAKEN. If a prompt ever asked the model to
// produce the list, the field would stop being the correction it was built as.
assert("no prompt asks the model to produce the change list",
  !/changes:\s*string\[\]/.test(actions.slice(actions.indexOf("STORE_CHAT_PRIMARY_SYSTEM_PROMPT"),
    actions.indexOf("STORE_CHAT_PRIMARY_SYSTEM_PROMPT") + 6000)),
  "the list is server-built precisely because the model's account of what it did can be wrong");
assert("and it is still built server-side",
  actions.includes("const changes: string[] = [];"),
  "deterministic, code-built — not model-generated");

console.log("\n=== 4. What is deliberately NOT claimed ===\n");
// Acceptance criterion 4 of the contract: the prompt change is measured live
// before this piece is called done. It has not been.
console.log(
  "  The prompt half is UNVERIFIED. Whether the model actually returns one lead\n" +
  "  sentence needs a live run, and the Anthropic credit balance is exhausted.\n" +
  "  The render half above is real and asserted; the prose half is implemented\n" +
  "  and unmeasured, and piece 3 is not accepted until it has been.\n"
);

console.log(`\n${failures === 0 ? "All reply-shape assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
