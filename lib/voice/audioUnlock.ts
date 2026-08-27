// PLAYING AUDIO A BROWSER WILL ACTUALLY LET YOU PLAY.
//
// Every mobile browser refuses to start audio that is not attributable to a
// user gesture. The rule is stricter than it sounds: the gesture is spent by
// the time an `await` resolves, so an <audio> element created AFTER a fetch —
// however clearly the user tapped to start it — is not covered by the tap that
// began the sequence. iOS Safari enforces this hardest.
//
// That is the whole reason J4SpeakButton rendered a player sitting at 0:00 with
// `autoPlay` set and nothing happening: the element did not exist yet when the
// gesture was live, so autoplay was blocked and the owner had to press play a
// second time.
//
// THE FIX IS TO CLAIM THE PERMISSION DURING THE TAP and keep the element that
// holds it. Playing a fraction of a second of real silence is what performs the
// unlock; nothing is audible. Afterwards the same element can be given a real
// source and played, because it has already played once under a gesture.
//
// useJ4Talk has done this since Talk Mode's first real iPhone test. This is
// that same technique, extracted so there is one implementation rather than a
// second copy that drifts.

/** A few milliseconds of valid, silent MP3. */
const SILENT_MP3 =
  "data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA" +
  "gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgP////////////////////////" +
  "//////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAnEaJ1kAAA==";

/**
 * Claim audio permission for an element, inside the gesture that is running now.
 *
 * MUST BE CALLED SYNCHRONOUSLY from the click/tap handler — before any await.
 * Calling it afterwards achieves nothing at all, which is the mistake it exists
 * to prevent.
 *
 * A refusal is not a failure worth reporting: some browsers never needed the
 * unlock, and one that refuses it will refuse the real playback too, which is
 * where the owner can actually be told.
 */
export function unlockAudioElement(el: HTMLAudioElement): void {
  try {
    el.preload = "auto";
    el.src = SILENT_MP3;
    void el.play().catch(() => {});
  } catch {
    // Nothing to do. See above.
  }
}

/**
 * Point an already-unlocked element at real audio and play it.
 *
 * Returns whether playback actually began, so a caller can say "tap play" when
 * the browser still refuses — rather than leaving a silent player on screen and
 * letting the owner wonder.
 */
export async function playUnlockedAudio(el: HTMLAudioElement, src: string): Promise<boolean> {
  try {
    el.src = src;
    // Some browsers keep the previous position on a src swap; a reply should
    // always start at the beginning.
    el.currentTime = 0;
    await el.play();
    return true;
  } catch {
    return false;
  }
}
