/**
 * WHETHER THIS ASSISTANT REPLY HAS ALREADY BEEN SPOKEN.
 *
 * ============ WHY J4 SAID EVERYTHING TWICE (2026-09-09) ================
 *
 * Production told us plainly: `j4_voice_output` fired TWICE per turn, 2-3
 * seconds apart, on 12 of the last 15 turns - and one turn fired FOUR times.
 * Every one of those turns had exactly ONE transcription, so it was never the
 * owner's input producing two turns. Sean heard the overlap as a stutter:
 *
 *     "Let me find that out for you. Let me find that out for you."
 *
 * The second playback starts while the first is still going, which is why the
 * OPENING is the part that repeats rather than the whole reply.
 *
 * THE CAUSE WAS AN ID THAT CHANGES UNDER THE SAME WORDS. A streamed reply is
 * held optimistically as `optimistic-assistant-<timestamp>`; when the server
 * action finishes, revalidation replaces it with the real database row and its
 * cuid. The guard remembered the ID it had spoken, so the identical text under
 * a new id read as a brand new reply. Two ids, one sentence, two voices.
 *
 * ============ WHY THIS IS A FUNCTION AND NOT AN `if` IN THE EFFECT ====
 *
 * The decision is the bug. Left inline it can only be tested through a browser,
 * a microphone and a real model turn, which is why it survived this long. Here
 * the exact production sequence - optimistic id, then persisted id, same words -
 * is three lines of a test.
 */

export interface SpokenState {
  /** The id of the last reply spoken, when it is still the same object. */
  id: string | null;
  /** What was last spoken, so a reply that changes id keeps its identity. */
  text: string | null;
}

export const NOTHING_SPOKEN: SpokenState = { id: null, text: null };

export interface ReplyEntry {
  id: string;
  role: string;
  content: string;
}

export type SpeakDecision =
  | { speak: false; next: SpokenState; because: string }
  | { speak: true; next: SpokenState; text: string };

/**
 * Decides whether `entry` should be spoken, given what was spoken before.
 *
 * Content, not just id, is the identity of a reply - see the note above. The
 * two are kept together because the id still does useful work: it is the cheap
 * check, and it distinguishes "the same object re-rendered" from "the same
 * words again".
 */
export function decideSpeak(previous: SpokenState, entry: ReplyEntry | undefined): SpeakDecision {
  if (!entry) return { speak: false, next: previous, because: "no reply yet" };

  // A NEW TURN HAS STARTED. The owner has spoken, so whatever J4 last said is
  // no longer a candidate for suppression - he is allowed to answer two
  // questions with the same sentence.
  if (entry.role === "user") {
    return { speak: false, next: NOTHING_SPOKEN, because: "the last entry is the owner's" };
  }

  if (entry.role !== "assistant") {
    return { speak: false, next: previous, because: `not an assistant reply (${entry.role})` };
  }

  const text = entry.content.trim();

  // AN EMPTY PLACEHOLDER IS A TURN BEGINNING, not a reply. Speaking it would
  // say nothing and end the turn early - and it is also the honest moment to
  // forget the previous reply, so J4 CAN legitimately repeat himself on a
  // later turn without this guard silencing him.
  if (!text) {
    return { speak: false, next: NOTHING_SPOKEN, because: "empty placeholder - a turn is starting" };
  }

  if (previous.id === entry.id) {
    return { speak: false, next: previous, because: "already spoken (same id)" };
  }

  // THE FIX. Same words, new id: this is the persisted row replacing the
  // optimistic one. Remember the new id so the cheap check catches it next
  // time, and stay quiet.
  if (previous.text !== null && previous.text === text) {
    return {
      speak: false,
      next: { id: entry.id, text },
      because: "already spoken (same words, new id - optimistic replaced by persisted)",
    };
  }

  return { speak: true, next: { id: entry.id, text }, text };
}
