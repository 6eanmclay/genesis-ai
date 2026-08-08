// J4 Voice Memos — client+server shared upload constants, same reasoning
// as lib/businessAssets/uploadAssetFile.ts's own comment: no server-only
// imports here, so J4Workspace.tsx (a client component) can safely import
// these too, validating against the exact same constants the server does.
// Deliberately separate from that file rather than added to it — voice
// memos don't go through ingestBusinessAsset/classifyAndExtractAsset (the
// photo/document pipeline); they go through applyGenesisMessageToStore,
// the same real conversational understanding a typed message gets (see
// lib/voice/j4VoiceMemo.ts's own comment). A shared "business asset" type
// union would misrepresent that real architectural split.
export const MAX_VOICE_MEMO_BYTES = 20 * 1024 * 1024; // 20MB — minutes of real speech, not a single photo

// MediaRecorder's supported output format differs by browser: Chrome/
// Android typically record audio/webm (opus), Safari/iOS typically
// audio/mp4 — both real, both accepted here rather than picking one and
// silently failing on the other platform. mpeg/wav included for whatever
// arrives via a non-MediaRecorder path (e.g. a file picker fallback).
export const ALLOWED_VOICE_MEMO_CONTENT_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};
