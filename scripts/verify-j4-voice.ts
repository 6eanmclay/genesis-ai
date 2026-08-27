import {
  readMicPermission,
  micGuidanceFor,
  platformFromUserAgent,
  canPromptFor,
  type MicPermission,
} from "@/lib/voice/micPermission";
import { readFileSync } from "fs";
import { join } from "path";

// J4'S VOICE, AND THE ATTACHMENTS THAT REACH IT:
//
//   npx tsx scripts/verify-j4-voice.ts
//
// Standalone — no database, no network, no device.
//
// ============ WHAT THIS CAN AND CANNOT PROVE ==============================
//
// The permission REASONING is pure and is proven here, every branch. What
// cannot be proven from this machine is what a real Android handset does when
// Chrome has remembered a refusal — there is no device and no mobile browser
// automation. That gap is named in the report rather than papered over, and it
// is exactly why the reasoning was made pure: the part that can be checked is
// checked, and the part that needs a phone is stated plainly.
//
// The lifecycle assertions are source-level for the same reason. There is no
// DOM here; what matters is that the attachment is not thrown away before the
// server has confirmed it, and that is visible in the code.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const read = (...p: string[]) => codeOnly(readFileSync(join(process.cwd(), ...p), "utf8"));

const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

async function main() {
  console.log("\n=== 1. Which device we are talking to ===\n");

  eq("an Android phone", platformFromUserAgent(ANDROID), "android");
  eq("an iPhone", platformFromUserAgent(IPHONE), "ios");
  eq("anything else", platformFromUserAgent(DESKTOP), "other");
  eq("and no user agent at all is not a guess", platformFromUserAgent(""), "other");

  console.log("\n=== 2. Whether a prompt can still appear ===\n");

  // THE DISTINCTION THE WHOLE ANDROID REPORT TURNS ON. A refusal in the moment
  // and a remembered block both reach the catch as NotAllowedError, and they need
  // opposite advice.
  assert("never asked means asking will work", canPromptFor("prompt"));
  assert("already granted needs no prompt", canPromptFor("granted"));
  assert("but a remembered refusal means no prompt is coming", !canPromptFor("denied"));
  // iOS Safari does not implement the microphone permission name, so it answers
  // "unknown" — and must keep the behaviour that already works there.
  assert("a browser that will not say is asked anyway", canPromptFor("unknown"),
    "iOS Safari lands here; not asking would break the platform that works");

  console.log("\n=== 3. What the owner is told, per state and platform ===\n");

  const androidDenied = micGuidanceFor("denied", "android");
  assert("Android blocked names Android's own settings",
    /Chrome/.test(androidDenied.detail) && /Permissions/.test(androidDenied.detail));
  assert("and the second permission layer, which is where it usually is",
    /Settings . Apps/.test(androidDenied.detail) || /Settings → Apps/.test(androidDenied.detail),
    "Android has TWO layers: the site permission and the browser app's own OS permission");
  assert("it does NOT offer a retry that cannot work", !androidDenied.canRetry,
    "a Try again button that can only ever fail implies the owner did something wrong");
  assert("and it explains that the browser stopped asking",
    /no longer asking|stopped asking/i.test(androidDenied.headline + androidDenied.detail),
    "otherwise 'microphone is blocked' reads as a bug, which is exactly how it was reported");

  const iosDenied = micGuidanceFor("denied", "ios");
  assert("iOS blocked names Safari's own controls", /Safari/.test(iosDenied.detail));
  assert("and likewise offers no impossible retry", !iosDenied.canRetry);
  assert("CONTROL: the two platforms are told different things",
    androidDenied.detail !== iosDenied.detail,
    "one set of instructions cannot be right for both");

  const androidPrompt = micGuidanceFor("prompt", "android");
  assert("a refusal in the moment DOES offer to ask again", androidPrompt.canRetry,
    "sending somebody to settings when a prompt would work is its own dead end");
  assert("and says what to expect", /Allow/.test(androidPrompt.detail));
  const unknownGuidance = micGuidanceFor("unknown", "ios");
  assert("an unknown state also offers the ask", unknownGuidance.canRetry);

  // Every state produces something sayable — no branch falls through to an empty
  // panel.
  for (const state of ["prompt", "granted", "denied", "unknown"] as MicPermission[]) {
    for (const platform of ["android", "ios", "other"] as const) {
      const g = micGuidanceFor(state, platform);
      assert(`${state}/${platform} has something to say`,
        g.headline.length > 0 && g.detail.length > 0);
    }
  }

  console.log("\n=== 4. Reading the permission never prompts and never throws ===\n");

  // The whole point of asking first: it must be free of side effects, or it
  // becomes the thing it was meant to avoid.
  //
  // navigator is a getter-only property on Node's globalThis, so it is
  // redefined rather than assigned.
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const setNavigator = (value: unknown) =>
    Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });

  setNavigator(undefined);
  eq("no navigator at all is unknown, not a crash", await readMicPermission(), "unknown");

  setNavigator({});
  eq("a browser with no Permissions API is unknown", await readMicPermission(), "unknown");

  setNavigator({ permissions: { query: async () => { throw new TypeError("unsupported name"); } } });
  eq("one that rejects the microphone name is unknown", await readMicPermission(), "unknown");

  setNavigator({ permissions: { query: async () => ({ state: "denied" }) } });
  eq("and a real denied answer is carried through", await readMicPermission(), "denied");

  setNavigator({ permissions: { query: async () => ({ state: "prompt" }) } });
  eq("as is prompt", await readMicPermission(), "prompt");

  setNavigator({ permissions: { query: async () => ({ state: "something-new" }) } });
  eq("a state we do not recognise is unknown rather than assumed",
    await readMicPermission(), "unknown");

  if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);


  console.log("\n=== 5. The attachment is not thrown away before it lands ===\n");

  // THE BUG THIS SECTION EXISTS FOR. handleSendToJ4 cleared the recording on its
  // FIRST line, before a byte had left the browser — so the review panel vanished
  // instantly and a failure left the owner with no recording, no error, and no
  // way back to the audio they had just made.
  const memo = read("app", "j4", "VoiceMemoButton.tsx");

  const sendFn = memo.slice(memo.indexOf("function handleSendToJ4"));
  const sendBody = sendFn.slice(0, sendFn.indexOf("\n  function "));
  assert("the recording is not cleared before the send",
    sendBody.indexOf("clearPending()") > sendBody.indexOf("await callGenesisAction"),
    "clearing first is what made Send look like it did nothing");
  // THE FAILURE BRANCH ITSELF, sliced rather than sampled with a character
  // window. The first version of this looked 400 characters past
  // `if (!result.ok)` and caught the clearPending in the SUCCESS path further
  // down — a false failure from an imprecise window, which is the same class of
  // mistake as a false pass.
  const failureBranch = sendBody.slice(
    sendBody.indexOf("if (!result.ok)"),
    sendBody.indexOf("return;", sendBody.indexOf("if (!result.ok)")) + "return;".length
  );
  assert("a failure keeps the recording on screen",
    failureBranch.includes("return;") && !failureBranch.includes("clearPending"),
    "losing somebody's only copy of what they said because a network call failed is the worst outcome here");
  assert("and says why it failed, beside the recording",
    /setSendError\(result\.message\)/.test(sendBody));

  // THE SILENT THIRD CASE. ok with no value is a completed turn — the action
  // finishes through redirectKeepingChatOpen, which runChatTurn turns into
  // undefined. The old code had no branch for it at all.
  assert("a successful send with no payload is still handled",
    /if \(result\.value\)[\s\S]{0,200}else[\s\S]{0,120}router\.refresh\(\)/.test(sendBody),
    "ok:true with value:undefined used to hit neither branch: no message, no error, nothing");
  assert("and only then is the recording released",
    sendBody.indexOf("clearPending()") < sendBody.indexOf("router.refresh()"),
    "confirmed success is the only thing that clears an attachment");

  assert("the panel says which of the three states it is in",
    /Sending…/.test(memo) && /Try again →/.test(memo) && /Send to J4 →/.test(memo));
  assert("and the error is shown as an alert, not a quiet line",
    /role="alert"/.test(memo));

  console.log("\n=== 6. Documents and photos have the same lifecycle ===\n");

  // Sean's instruction: do not fix audio in isolation. These paths track status
  // per file rather than clearing a single pending item, so they never had the
  // premature-clear bug — asserted so that stays true.
  const workspace = read("app", "j4", "J4Workspace.tsx");
  assert("a failed document upload is marked failed, not silently dropped",
    /setEntryStatus\(entry\.id, "failed"\)/.test(workspace));
  assert("and the owner is told which files did not make it",
    /Couldn't upload: \$\{problems\.join/.test(workspace));
  assert("a successful one is marked uploaded",
    /setEntryStatus\(entry\.id, "uploaded"\)/.test(workspace));
  assert("failures do not abort the rest of the batch",
    /continue;/.test(workspace),
    "one bad document used to abort every file after it, including ones that would have worked");
  assert("and progress is shown while it happens",
    /setProgress\(/.test(workspace));

  console.log("\n=== 7. Listen speaks on the tap that asked for it ===\n");

  const speak = read("app", "j4", "J4SpeakButton.tsx");
  const unlock = read("lib", "voice", "audioUnlock.ts");

  // THE REASON IT USED TO SIT AT 0:00. The element was created after the fetch,
  // by which time the gesture that authorised it was spent.
  const handleIdx = speak.indexOf("async function handleListen");
  const handleBody = speak.slice(handleIdx, speak.indexOf("useEffect", handleIdx));
  assert("the audio element is unlocked before anything is awaited",
    handleBody.indexOf("unlockAudioElement(el)") < handleBody.indexOf("await fetch"),
    "after an await the tap no longer authorises playback, however clearly the owner tapped");
  assert("and the same element is then given the real audio",
    /playUnlockedAudio\(el, url\)/.test(handleBody));
  assert("with a message when the browser still refuses",
    /setNeedsTap\(!started\)/.test(handleBody),
    "a silent player with no explanation is what this replaced");
  assert("the unlock plays real silence rather than nothing",
    /data:audio\/mp3;base64/.test(unlock));
  assert("and it is one implementation, not a second copy",
    /audioUnlock/.test(speak),
    "Talk Mode has done this since its first iPhone test; this is that technique extracted");

  // ============ NO MEDIA PLAYER IN A CONVERSATION (2026-08-27) ==========
  //
  // Listening used to render a native <audio controls> — a scrubber with
  // elapsed and remaining times — inside a chat message. It delivered the
  // pause and resume Sean asked for by putting desktop chrome in a
  // conversation, and on a phone it was the bulkiest thing on screen.
  //
  // The five-bar glyph already says "J4 is speaking" better than a timeline
  // does, so it is the control now as well as the indicator. Asserted rather
  // than trusted, because a media element is exactly the sort of thing that
  // comes back when somebody wants a progress bar.
  assert("no native media player is rendered",
    !/<audio/.test(speak),
    "a scrubber with timestamps is not what a two-sentence reply needs");
  assert("the five-bar glyph is what shows speech instead",
    /J4VoiceGlyph speaking=\{speaking\}/.test(speak));
  // ============ GREEN IS THE SIGNAL, NOT THE PAINT (2026-08-27) =========
  //
  // Sean wants a restrained dark green to mean "J4 is speaking right now", and
  // explicitly does not want the whole control green. So the assertion is not
  // that green exists -- it is that green is CONDITIONAL on speaking, which is
  // the difference between a signal and a colour scheme.
  const voiceGlyph = read("app", "j4", "J4VoiceGlyph.tsx");
  assert("the speaking colour is a real hex, not a name",
    /#[0-9A-Fa-f]{6}/.test(voiceGlyph));
  assert("and it only applies while speaking",
    /speaking \? SPEAKING_GREEN : "currentColor"/.test(voiceGlyph),
    "a permanently green control says nothing, because it always says it");
  assert("the silent state still inherits the surrounding colour",
    /currentColor/.test(voiceGlyph),
    "the resting control must look exactly as it did");

  assert("and tapping it pauses and resumes",
    /togglePlayback/.test(speak) && /el\.pause\(\)/.test(speak),
    "pause and resume were the reason the player was there; they are kept");

  console.log("\n=== 8. The voice control looks like J4 ===\n");

  assert("the speaker emoji is gone", !/🔊/.test(speak),
    "an emoji renders as a different picture on every platform and read as a system alert");
  const glyph = read("app", "j4", "J4VoiceGlyph.tsx");
  assert("replaced by a drawn mark", /<svg/.test(glyph));
  assert("that animates only while actually speaking",
    /speaking \? "j4voice-on"/.test(glyph),
    "a waveform moving when nothing plays is decoration pretending to be state");
  assert("and stops for anyone who asked for less motion",
    /prefers-reduced-motion/.test(glyph));
  // ============ REFINED, NOT ABANDONED (2026-08-27) ====================
  //
  // This asserted `fill="currentColor"` unconditionally: the glyph takes the
  // surrounding colour and belongs to whatever surface it sits on. That rule
  // is still right for the RESTING control, and Sean's green brief does not
  // contradict it — it adds a second state.
  //
  // So the requirement narrows rather than disappearing: silent still inherits,
  // and green is the exception that means "speaking right now". Written this
  // way round because the failure worth catching is a glyph that introduces
  // its own colour when nothing is happening.
  assert("silent, it takes the surrounding colour rather than introducing its own",
    /: "currentColor"/.test(glyph),
    "so it belongs to whatever surface it sits on");

  console.log("\n=== 9. A turn with no words says so ===\n");

  const talk = read("app", "dashboard", "useJ4Talk.ts");
  assert("an empty transcription is explained in the owner's terms",
    /I didn't catch that/.test(talk),
    "it used to say 'Recorded 37KB of audio/webm, got no words back', which reads as a fault");
  assert("and the engineering detail goes to the console instead",
    /console\.error\("\[j4talk\] transcription failed:"/.test(talk));
  assert("CONTROL: and the turn still restarts, because that is correct",
    /if \(stateRef\.current === "thinking"\) restartRef\.current\(\);/.test(talk),
    "the state machine was right; only the explanation was missing");

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  console.log("\nNOTE: Android permission BEHAVIOUR is unverified — no device and no");
  console.log("mobile browser automation. The reasoning above is proven; the handset is not.");
  process.exit(failures === 0 ? 0 : 1);

}

main();
