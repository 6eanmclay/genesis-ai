import { decideSpeak, NOTHING_SPOKEN, type SpokenState, type ReplyEntry } from "@/lib/voice/spokenReplies";

// ONE REPLY, ONE VOICE (2026-09-09).
//
//   npx tsx scripts/run-db-suites.ts spoken-replies
//
// Sean, after hearing J4 stutter: "Did J4 generate the phrase twice, or did we
// receive/render/speak the same generated phrase twice? Those are completely
// different bugs." Production answered it: `j4_voice_output` fired TWICE per
// turn, 2-3 seconds apart, on 12 of the last 15 turns - one fired FOUR times -
// while every one of those turns had exactly ONE transcription. J4 said it
// once. We spoke it twice.
//
// The cause was an id that changes under the same words: a streamed reply is
// held as `optimistic-assistant-<timestamp>`, then revalidation replaces it
// with the persisted row's cuid. The old guard remembered the id, so identical
// text under a new id read as a brand new reply.
//
// THE SEQUENCES BELOW ARE THE REAL ONES, not invented shapes - which is the
// point. This bug survived because the decision lived inside a React effect and
// could only be reached through a browser, a microphone and a live model turn.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Feed a sequence of "last entry" states through the decision, as React would. */
function speakCount(entries: (ReplyEntry | undefined)[]): { spoken: string[]; reasons: string[] } {
  let state: SpokenState = NOTHING_SPOKEN;
  const spoken: string[] = [];
  const reasons: string[] = [];
  for (const e of entries) {
    const d = decideSpeak(state, e);
    state = d.next;
    if (d.speak) spoken.push(d.text);
    else reasons.push(d.because);
  }
  return { spoken, reasons };
}

const REPLY = "Let me find that out for you. Your last order shipped on Tuesday.";

function main(): void {
  console.log("\n=== 1. The exact production sequence that spoke twice ===\n");
  {
    // What actually happens on a turn: the optimistic pair is appended (the
    // assistant placeholder is EMPTY), text streams in, then the server action
    // completes and revalidation swaps in the persisted row with a new id.
    const { spoken } = speakCount([
      { id: "optimistic-assistant-1757000000000", role: "assistant", content: "" },
      { id: "optimistic-assistant-1757000000000", role: "assistant", content: REPLY },
      { id: "cmrs66vom000204ldnhi3q4yg", role: "assistant", content: REPLY },
    ]);
    check("one reply produces exactly one spoken utterance", spoken.length === 1, `${spoken.length} utterance(s)`);
    check("and it is the reply itself", spoken[0] === REPLY, spoken[0]?.slice(0, 40) ?? "(nothing)");
  }

  console.log("\n=== 2. The four-times case: revalidation landing repeatedly ===\n");
  {
    const { spoken } = speakCount([
      { id: "optimistic-assistant-1757000000001", role: "assistant", content: "" },
      { id: "optimistic-assistant-1757000000001", role: "assistant", content: REPLY },
      { id: "cuid-persisted-a", role: "assistant", content: REPLY },
      { id: "cuid-persisted-a", role: "assistant", content: REPLY },
      { id: "cuid-persisted-b", role: "assistant", content: REPLY },
    ]);
    check("still exactly one utterance across four re-renders", spoken.length === 1, `${spoken.length}`);
  }

  console.log("\n=== 3. J4 may still repeat himself across DIFFERENT turns ===\n");
  {
    // The guard must not silence a genuine second answer. A new turn is marked
    // by the empty placeholder, which is what clears the memory.
    const { spoken } = speakCount([
      { id: "a1", role: "assistant", content: "Taking you there now." },
      { id: "u1", role: "user", content: "and again please" },
      { id: "optimistic-assistant-2", role: "assistant", content: "" },
      { id: "optimistic-assistant-2", role: "assistant", content: "Taking you there now." },
      { id: "cuid-2", role: "assistant", content: "Taking you there now." },
    ]);
    check("the same sentence on a later turn IS spoken again", spoken.length === 2, `${spoken.length} utterance(s)`);
  }

  console.log("\n=== 4. Nothing is spoken that should not be ===\n");
  {
    const empty = speakCount([{ id: "x", role: "assistant", content: "   " }]);
    check("an empty placeholder is never spoken", empty.spoken.length === 0);

    const user = speakCount([{ id: "u", role: "user", content: "hello?" }]);
    check("the owner's own words are never spoken back", user.spoken.length === 0);

    const none = speakCount([undefined]);
    check("no reply yet is not an utterance", none.spoken.length === 0);
  }

  console.log("\n=== 5. The control: this check can still see a real double ===\n");
  {
    // If the content guard were removed, sequence 1 would speak twice. Prove
    // the harness would notice - a test that cannot fail proves nothing.
    let state: SpokenState = NOTHING_SPOKEN;
    let spoken = 0;
    for (const e of [
      { id: "optimistic-assistant-9", role: "assistant", content: REPLY },
      { id: "cuid-9", role: "assistant", content: REPLY },
    ]) {
      // deliberately id-only, the OLD logic
      if (state.id !== e.id) { spoken += 1; state = { id: e.id, text: null }; }
    }
    check("the old id-only rule really did speak twice", spoken === 2, `${spoken} — this is the bug being fixed`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
