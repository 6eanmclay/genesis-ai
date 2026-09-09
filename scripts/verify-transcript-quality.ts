import { readTranscript, collapseRepetition } from "@/lib/voice/transcriptQuality";

// ONE UTTERANCE, ONE TURN. SILENCE, NO TURN. (2026-09-09)
//
//   npx tsx scripts/run-db-suites.ts transcript-quality
//
// Both strings below are REAL, taken from production storeMessage rows on
// 2026-09-09, and both were stored as genuine user messages and answered by J4:
//
//     "OK. 834. OK. 834."        Sean said it once
//     "Thank you for watching."  Sean never said it at all
//
// Sean's requirement, verbatim: "one utterance = one stored user turn",
// "silence = no user turn".

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function main(): void {
  console.log("\n=== 1. The two real production transcripts ===\n");
  {
    const looped = readTranscript("OK. 834. OK. 834.");
    check("the looped transcript becomes ONE utterance",
      looped.kind === "speech" && looped.text === "OK. 834.",
      looped.kind === "speech" ? JSON.stringify(looped.text) : looped.because);

    const silence = readTranscript("Thank you for watching.");
    check("Whisper's silence artifact creates NO user turn",
      silence.kind === "silence",
      silence.kind === "silence" ? silence.because : JSON.stringify(silence.text));
  }

  console.log("\n=== 2. Silence, in the shapes Whisper actually emits ===\n");
  {
    for (const [raw, why] of [
      ["", "empty"],
      ["   ", "whitespace"],
      ["...", "punctuation only"],
      ["♪♪♪", "music marker"],
      ["[BLANK_AUDIO]", "stage direction"],
      ["Thanks for watching!", "sign-off"],
      ["Subtitles by the Amara.org community", "subtitle credit"],
      ["Please subscribe", "channel plug"],
    ]) {
      const r = readTranscript(raw);
      check(`no turn for ${why}: ${JSON.stringify(raw).slice(0, 34)}`, r.kind === "silence",
        r.kind === "speech" ? "became a message!" : "");
    }
  }

  console.log("\n=== 3. Real speech is never lost ===\n");
  {
    const real = [
      "um wait what happened with paypal it said capture succeeded still pending",
      "No, I just don't remember what PayPal I'm using on there.",
      "Oh, yeah, you could take me there? Yeah, yes, please.",
      "Thank you.",
      "Thanks for watching my store video, what should I change about it?",
      "OK. OK. Right, let's do the pricing next.",
      "834",
    ];
    for (const r of real) {
      const read = readTranscript(r);
      check(`kept: ${JSON.stringify(r.slice(0, 46))}`, read.kind === "speech",
        read.kind === "silence" ? "WRONGLY DROPPED: " + read.because : "");
    }
    // The tradeoff, asserted rather than assumed: a bare "Thank you." survives
    // because an owner might really say it, even though Whisper also emits it.
    const thanks = readTranscript("Thank you.");
    check("a bare \"Thank you.\" is deliberately NOT filtered",
      thanks.kind === "speech", "the cost of filtering it would be dropping real speech");
  }

  console.log("\n=== 4. Repetition collapses only when it is the WHOLE transcript ===\n");
  {
    check("x2 collapses", collapseRepetition("OK. 834. OK. 834.").text === "OK. 834.");
    check("x3 collapses", collapseRepetition("hello hello hello").text === "hello",
      JSON.stringify(collapseRepetition("hello hello hello").text));
    check("partial repetition is left alone",
      collapseRepetition("OK. OK. Right, let's go").text === "OK. OK. Right, let's go");
    check("ordinary speech is untouched",
      collapseRepetition("the price is the price we agreed").text === "the price is the price we agreed");
    check("repeat count is reported", collapseRepetition("OK. 834. OK. 834.").repeats === 2,
      String(collapseRepetition("OK. 834. OK. 834.").repeats));
  }

  console.log("\n=== 5. Controls: this suite can still fail ===\n");
  {
    // If the artifact list were emptied, the sign-off would become a turn.
    const wouldBeSpeech = readTranscript("Thank you for watching, here is what I want to change");
    check("a sign-off WITH real speech after it is kept", wouldBeSpeech.kind === "speech",
      "only a whole-transcript artifact counts as silence");
    check("and a non-artifact sentence of similar length is kept",
      readTranscript("Thank you for building this thing").kind === "speech");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
