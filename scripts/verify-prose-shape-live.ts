import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  STORE_CHAT_PRIMARY_SYSTEM_PROMPT,
  StoreChatPrimarySchema,
  CHAT_CONTROL_SYSTEM_PROMPT,
  ChatControlSchema,
} from "@/app/dashboard/ai-actions";

// UI6 PIECE 3 — ACCEPTANCE CRITERION 4, THE ONE THAT NEEDS A MODEL:
//
//   npx tsx scripts/verify-prose-shape-live.ts
//
// HONEST NOTE ON WHY THIS FILE IS NEW. The contract said "the prompt change is
// measured live before it is called done" and I never built the measurement —
// so "pending live acceptance" was pending a harness as well as a credential.
// This is that harness, written to the measurement already defined and nothing
// more.
//
// WHAT IT MEASURES, and only this: does the model return a LEAD SENTENCE rather
// than an enumeration of the changes? The checklist beneath a reply is
// server-built and authoritative, so prose that re-lists it makes the owner read
// the same thing twice.
//
// WHAT IT DELIBERATELY DOES NOT MEASURE: whether the prose is good, whether the
// content edits are right, or anything else about the reply. This is one
// acceptance criterion, not a copy review.
//
// COST: four calls. Kept small on purpose — this is validation of a defined
// question, not exploration.

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.log("\nSKIPPED: ANTHROPIC_API_KEY is not set. Nothing was measured.\n");
  process.exit(0);
}

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}

/** Sentences, counted the way a reader would. */
function sentenceCount(text: string): number {
  return text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0).length;
}

const STORE_STATE = `Store: Copper & Coil — hand-wound copper rings, made to order.
Tagline: "Quietly made."
Homepage headline: "Rings with a story."
Palette: charcoal and pale grey.
Active products: Copper Ring (£85), Wide Band (£110), Twist Ring (£95).`;

// BOTH OWNER-VISIBLE REPLY PATHS, and that is the whole point of this file.
//
// The first version measured only PRIMARY and reported a failure I went and
// "fixed" in CONTROL — because I had assumed there was one reply prompt. There
// are two: CONTROL writes the reply while a store is still a draft, PRIMARY
// writes it once the store is live. Piece 3's rule had been added to CONTROL
// alone, and PRIMARY still instructed a 2-4 sentence walk through everything
// changed. The measurement was right; my first reading of it was not.
//
// So an acceptance criterion about how J4 speaks is measured on every prompt
// that makes J4 speak. Adding a third reply path means adding it here.
const PATHS = [
  { name: "live store", prompt: STORE_CHAT_PRIMARY_SYSTEM_PROMPT, schema: StoreChatPrimarySchema },
  { name: "draft store", prompt: CHAT_CONTROL_SYSTEM_PROMPT, schema: ChatControlSchema },
];

const CASES = [
  {
    name: "a sweeping change",
    message: "Warm the whole thing up — it feels cold and clinical right now.",
  },
  {
    name: "a small specific change",
    message: "Rewrite my tagline so it says something about the making.",
  },
];

async function main() {
  const client = new Anthropic({ apiKey: key });
  let calls = 0;

  for (const path of PATHS)
  for (const testCase of CASES) {
    const label = `${path.name}, ${testCase.name}`;
    const outcome = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 8000,
      system: path.prompt,
      messages: [{ role: "user", content: `${STORE_STATE}\n\nMerchant: ${testCase.message}` }],
      output_config: { format: zodOutputFormat(path.schema) },
    } as Parameters<typeof client.messages.create>[0]);
    calls++;

    const block = (outcome as { content: { type: string; text?: string }[] }).content.find(
      (b) => b.type === "text"
    );
    const parsed = JSON.parse(block?.text ?? "{}") as { reply?: string };
    const reply = (parsed.reply ?? "").trim();

    console.log(`\n--- ${label} ---`);
    console.log(`  "${reply}"\n`);

    assert(`${label}: J4 replied at all`, reply.length > 0);

    // A LEAD SENTENCE, plus at most one more. The prompt allows a second only if
    // it genuinely earns its place, so three or more is the enumeration this
    // change removed.
    const sentences = sentenceCount(reply);
    assert(`${label}: leads with one sentence, at most two`,
      sentences <= 2, `${sentences} sentences`);

    // AND DOES NOT ENUMERATE — IN ANY FORM.
    //
    // The first version of this checked only for list MARKERS, and passed on a
    // reply that walked through the palette, then the type, then the copy, then
    // a new section in flowing prose. It did not enter the behaviour it claimed
    // to test: an enumeration without bullets is still an enumeration, and it is
    // the one the model actually produces.
    //
    // So the real signal is how many distinct things the reply names. A lead
    // sentence names a direction; a tour names areas.
    const AREAS = /\b(palette|colou?rs?|typography|type pairing|font|headings?|copy|tagline|headline|spacing|buttons?|cards?|sections?|FAQ|about)\b/gi;
    const areasNamed = new Set((reply.match(AREAS) ?? []).map((a) => a.toLowerCase())).size;
    assert(`${label}: does not tour what it changed`,
      areasNamed <= 2,
      `named ${areasNamed} areas — the checklist beneath already lists them`);
    assert(`${label}: uses no list markers either`,
      !/^\s*[-•*]\s/m.test(reply),
      "a bulleted list in the prose duplicates the server-built checklist");

    // A rough length check as a second signal: an enumeration is long even
    // without list markers.
    assert(`${label}: is short enough to be a lead, not a report`,
      reply.length <= 400, `${reply.length} characters`);
  }

  console.log(`\nCalls made: ${calls}`);
  console.log(`${failures === 0 ? "PIECE 3 PROSE ACCEPTED." : `${failures} assertion(s) FAILED — piece 3 not accepted.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
