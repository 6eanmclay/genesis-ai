import {
  initialExperienceState,
  countVisitorTurns,
  MAX_VISITOR_TURNS_BEFORE_FORCED_GENERATION,
} from "@/lib/onboarding/experienceFlow";
import type { ExperienceState } from "@/lib/onboarding/types";
import {
  MAX_VOICE_MEMO_BYTES,
  ALLOWED_VOICE_MEMO_CONTENT_TYPES,
} from "@/lib/voice/voiceMemoFile";
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from "@/lib/businessAssets/uploadAssetFile";

// HOW LONG GENESIS MAY KEEP ASKING, AND WHAT IT WILL LISTEN TO:
//
//   npx tsx scripts/verify-onboarding-and-voice.ts
//
// Two small pure surfaces, neither covered.
//
// THE QUESTION CAP is EXPERIENCE_FIRST_ONBOARDING.md's bounded-questioning
// principle made concrete: "one, rarely two" clarifying rounds before Genesis
// commits and builds something. A visitor who has not signed up for anything is
// the least patient audience the product has, and an uncapped interrogation is
// how a first impression becomes a bounce.
//
// The counting rule is the load-bearing part and it is easy to get backwards:
// it counts VISITOR messages, not transcript length, "so a Genesis question
// doesn't itself count against the cap." Count the whole transcript instead and
// the cap halves — Genesis gets one question rather than two, because its own
// question consumed a turn.
//
// THE VOICE FORMATS are a real cross-platform hazard. "MediaRecorder's supported
// output format differs by browser: Chrome/Android typically record audio/webm
// (opus), Safari/iOS typically audio/mp4 — both real, both accepted here rather
// than picking one and silently failing on the other platform." Drop either and
// voice memos stop working for half the owners, on their phones, with no error
// that names the reason.

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

const transcript = (roles: ("visitor" | "genesis")[]): ExperienceState => ({
  ...initialExperienceState(),
  transcript: roles.map((role, i) => ({ role, text: `message ${i}` })) as ExperienceState["transcript"],
});

// ============================================================================
console.log("\n=== 1. A visitor starts with nothing assumed about them ===\n");
// ============================================================================
const fresh = initialExperienceState();
check("the transcript is empty", fresh.transcript, []);
check("nothing has been concluded", fresh.concept, null);
check("and the flow is still collecting", fresh.status, "collecting");
assert(
  "so Genesis begins with no idea what this business is",
  fresh.concept === null && fresh.transcript.length === 0,
  "a seeded concept would be Genesis answering before it was told anything"
);

// ============================================================================
console.log("\n=== 2. Genesis's own questions do not spend the visitor's patience ===\n");
// ============================================================================
check("nothing said is no turns", countVisitorTurns(fresh), 0);
check("one visitor message is one turn", countVisitorTurns(transcript(["visitor"])), 1);
check("a Genesis reply is not a turn", countVisitorTurns(transcript(["visitor", "genesis"])), 1);
check("a full exchange is still one", countVisitorTurns(transcript(["genesis", "visitor", "genesis"])), 1);
check("two visitor messages are two turns",
  countVisitorTurns(transcript(["visitor", "genesis", "visitor"])), 2);
check("however many questions came between them",
  countVisitorTurns(transcript(["genesis", "visitor", "genesis", "genesis", "visitor"])), 2);

assert(
  "so counting the transcript instead would halve the cap",
  countVisitorTurns(transcript(["visitor", "genesis", "visitor"])) === 2 &&
    transcript(["visitor", "genesis", "visitor"]).transcript.length === 3,
  "Genesis would get one clarifying question rather than two, because its own consumed a turn"
);

// ============================================================================
console.log("\n=== 3. The cap is one, rarely two ===\n");
// ============================================================================
check("two visitor turns before Genesis must commit", MAX_VISITOR_TURNS_BEFORE_FORCED_GENERATION, 2);
assert("which is a real cap, not a formality",
  MAX_VISITOR_TURNS_BEFORE_FORCED_GENERATION >= 1 && MAX_VISITOR_TURNS_BEFORE_FORCED_GENERATION <= 3,
  "one, rarely two — an uncapped interrogation is how a first impression becomes a bounce");

// The boundary, walked one message at a time.
const reached = (roles: ("visitor" | "genesis")[]) =>
  countVisitorTurns(transcript(roles)) >= MAX_VISITOR_TURNS_BEFORE_FORCED_GENERATION;
assert("one answer has not reached the cap", !reached(["visitor"]));
assert("nor one answer and a question", !reached(["visitor", "genesis"]));
assert("two answers have", reached(["visitor", "genesis", "visitor"]));
assert("and it stays reached", reached(["visitor", "genesis", "visitor", "genesis", "visitor"]));

// ============================================================================
console.log("\n=== 4. Both phones can leave a voice memo ===\n");
// ============================================================================
assert("Chrome and Android's format is accepted",
  Boolean(ALLOWED_VOICE_MEMO_CONTENT_TYPES["audio/webm"]), JSON.stringify(ALLOWED_VOICE_MEMO_CONTENT_TYPES));
assert("and Safari and iOS's",
  Boolean(ALLOWED_VOICE_MEMO_CONTENT_TYPES["audio/mp4"]), JSON.stringify(ALLOWED_VOICE_MEMO_CONTENT_TYPES));
assert(
  "so a voice memo is not a feature that works on half the phones",
  Boolean(ALLOWED_VOICE_MEMO_CONTENT_TYPES["audio/webm"] && ALLOWED_VOICE_MEMO_CONTENT_TYPES["audio/mp4"]),
  "MediaRecorder's output format differs by browser — dropping either fails silently on that platform"
);

// Every entry maps to a real file extension, since that is what the stored blob
// is named by.
for (const [type, extension] of Object.entries(ALLOWED_VOICE_MEMO_CONTENT_TYPES)) {
  assert(`${type} has a real extension`, /^[a-z0-9]{2,4}$/.test(extension), extension);
  assert(`${type} is an audio type`, type.startsWith("audio/"), type);
}
check("and no two formats share an extension",
  new Set(Object.values(ALLOWED_VOICE_MEMO_CONTENT_TYPES)).size,
  Object.keys(ALLOWED_VOICE_MEMO_CONTENT_TYPES).length);

// ============================================================================
console.log("\n=== 5. Voice and documents are separate ceilings, deliberately ===\n");
// ============================================================================
// The two upload paths are kept apart on purpose: voice memos go through
// applyGenesisMessageToStore, not the photo/document pipeline, and "a shared
// business-asset type union would misrepresent that real architectural split."
check("a voice memo may be 20MB", MAX_VOICE_MEMO_BYTES, 20 * 1024 * 1024);
assert("which is minutes of speech, not a single photo",
  MAX_VOICE_MEMO_BYTES >= 5 * 1024 * 1024, String(MAX_VOICE_MEMO_BYTES));

// No audio type may leak into the asset pipeline, or a voice memo would be
// classified as a document instead of being listened to.
const audioInAssets = Object.keys(ALLOWED_CONTENT_TYPES).filter((t) => t.startsWith("audio/"));
check("no audio type is accepted as a business asset", audioInAssets, []);
const assetInVoice = Object.keys(ALLOWED_VOICE_MEMO_CONTENT_TYPES).filter((t) => !t.startsWith("audio/"));
check("and no document type is accepted as a voice memo", assetInVoice, []);
assert(
  "so the two pipelines cannot quietly accept each other's files",
  audioInAssets.length === 0 && assetInVoice.length === 0,
  "voice memos go through applyGenesisMessageToStore, not classifyAndExtractAsset"
);

// Both ceilings are real, positive, and whole.
for (const [name, bytes] of [["voice", MAX_VOICE_MEMO_BYTES], ["asset", MAX_UPLOAD_BYTES]] as const) {
  assert(`the ${name} ceiling is a real number of bytes`,
    Number.isInteger(bytes) && bytes > 0, String(bytes));
}

console.log(`\n${failures === 0 ? "All onboarding-and-voice assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
