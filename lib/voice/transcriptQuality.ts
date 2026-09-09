/**
 * WHAT THE OWNER ACTUALLY SAID, as opposed to what Whisper returned.
 *
 * ============ TWO REAL TURNS FROM PRODUCTION (2026-09-09) ==============
 *
 * Both of these were stored as genuine user messages and answered by J4:
 *
 *     "OK. 834. OK. 834."        <- Sean said it ONCE
 *     "Thank you for watching."  <- Sean never said this at all
 *
 * Neither is a Genesis bug in the usual sense; both are documented Whisper
 * behaviours. It loops on short or noisy audio, and on silence it emits
 * stock phrases from its training data - captions, sign-offs, subtitle
 * credits. `transcribeVoiceMemo` accepted whatever came back, so silence
 * became a question and a single sentence became two.
 *
 * The second one is the worse of the two. J4 answered it earnestly
 * ("That one came through as sign-off text, so nothing to act on there"),
 * which is a good reply to a message that should never have existed. A
 * partner who responds to things you did not say is not trustworthy, however
 * gracefully it does it.
 *
 * ============ THE LINE THIS DRAWS, AND WHAT IT COSTS ===================
 *
 * Only transcripts that are ENTIRELY a known artifact are treated as silence.
 * A phrase that appears alongside real speech is left alone - if the owner
 * says "thanks for watching my store video, what should I change", that is a
 * real sentence and it survives.
 *
 * Deliberately NOT filtered: a bare "Thank you." A business owner might well
 * say exactly that to their partner, and dropping it would be the wrong
 * trade. The filtered list is only phrases a person would not plausibly say,
 * alone, to J4 - subtitle credits, "please subscribe", a lone musical note.
 *
 * The cost of being wrong here is that the owner repeats themselves once. The
 * cost of the current behaviour is J4 answering things nobody said.
 */

/**
 * Whisper's stock output on silence. Matched only when the WHOLE transcript is
 * one of these, after normalising case, whitespace and trailing punctuation.
 */
const SILENCE_ARTIFACTS = [
  "thank you for watching",
  "thanks for watching",
  "thank you for watching!",
  "thank you for watching.",
  "please subscribe",
  "like and subscribe",
  "subscribe to my channel",
  "subtitles by the amara.org community",
  "captions by the amara.org community",
  "transcription by eso translations",
  "bye",
  "bye bye",
];

function normalise(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?…]+$/g, "")
    .trim();
}

export type TranscriptReading =
  | { kind: "speech"; text: string; collapsedRepeats: number }
  | { kind: "silence"; because: string };

/**
 * Collapse a transcript that is one segment repeated back to back.
 *
 * "OK. 834. OK. 834." -> "OK. 834."   (Whisper's repetition loop)
 *
 * Only an EXACT whole-transcript repetition collapses. A sentence that merely
 * contains a repeated word is real speech and is left alone, and so is
 * "OK. OK. Right, let's go" - because the repetition must account for the
 * entire transcript, not part of it.
 */
export function collapseRepetition(text: string): { text: string; repeats: number } {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return { text: t, repeats: 1 };

  for (let copies = 2; copies <= 6; copies += 1) {
    if (t.length % copies !== 0) {
      // Allow for the separating space between copies.
      const unitLen = (t.length - (copies - 1)) / copies;
      if (!Number.isInteger(unitLen) || unitLen < 2) continue;
      const unit = t.slice(0, unitLen);
      if (Array.from({ length: copies }, () => unit).join(" ") === t) {
        return { text: unit, repeats: copies };
      }
      continue;
    }
    const unitLen = t.length / copies;
    if (unitLen < 2) continue;
    const unit = t.slice(0, unitLen);
    if (unit.repeat(copies) === t) return { text: unit.trim(), repeats: copies };
  }
  return { text: t, repeats: 1 };
}

/**
 * Turn Whisper's raw output into either real speech or an honest "nothing was
 * said". Returning silence means NO user turn is created - the owner's
 * conversation should not contain sentences they never spoke.
 */
export function readTranscript(raw: string | null | undefined): TranscriptReading {
  if (!raw) return { kind: "silence", because: "empty transcript" };

  const trimmed = raw.trim();
  if (!trimmed) return { kind: "silence", because: "whitespace only" };

  // Punctuation, musical notes and bracketed stage directions on their own are
  // what Whisper emits for room tone.
  if (!/[a-z0-9]/i.test(trimmed)) {
    return { kind: "silence", because: `no words, only ${JSON.stringify(trimmed.slice(0, 20))}` };
  }
  if (/^[\[(].*[\])]$/.test(trimmed) && trimmed.length < 40) {
    return { kind: "silence", because: `stage direction ${JSON.stringify(trimmed)}` };
  }

  const collapsed = collapseRepetition(trimmed);

  if (SILENCE_ARTIFACTS.includes(normalise(collapsed.text))) {
    return { kind: "silence", because: `Whisper silence artifact ${JSON.stringify(collapsed.text)}` };
  }

  return { kind: "speech", text: collapsed.text, collapsedRepeats: collapsed.repeats };
}
