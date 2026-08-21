import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { resolveBusiness } from "@/lib/businessContext";
import { openJ4VoiceOutputSession } from "@/lib/voice/j4VoiceOutput";

// J4 Voice Output (2026-08-08) — "Add voice playback for J4 responses...
// Play/Pause/Resume and preferably seek/scrub controls" (Sean). Real,
// deliberate scope cut from the earlier (never-built) concurrent-
// streaming design: this synthesizes one COMPLETE finished reply into one
// complete audio file, returned once, rather than relaying live chunks
// while text is still generating. A native <audio> element then gives
// Play/Pause/seek/scrub for free — no custom player, no MediaSource
// Extensions, none of the real, unresolved mobile-Safari-reliability
// questions the concurrent design would have needed. "Do not build the
// full voice-to-voice meeting experience yet" (Sean) — this is the
// smallest real thing that satisfies what was actually asked.
//
// Provider-agnostic by construction: this route only ever calls
// lib/voice/j4VoiceOutput.ts's own abstraction, never ElevenLabs
// directly — "do not hard-code a 'Claude voice'... TTS provider and
// voice separate from reasoning model" is satisfied by the module this
// already sits behind, unchanged.
export const maxDuration = 60;

const MAX_TEXT_LENGTH = 4000; // a real ceiling — not a full business review's worth of speech in one request

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const resolution = await resolveBusiness(session.user.id);
  if (resolution.kind === "ambiguous") {
    return NextResponse.json({ error: "Choose which business this is for first." }, { status: 409 });
  }
  if (resolution.kind === "none" || !hasPermission(resolution.role, PERMISSIONS.GENESIS_CHAT)) {
    return NextResponse.json({ error: "You don't have permission to do this." }, { status: 403 });
  }
  const resolved = resolution;

  const body = (await request.json().catch(() => null)) as { text?: string } | null;
  const text = body?.text?.trim();
  if (!text) {
    return NextResponse.json({ error: "No text to speak." }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json({ error: "That reply is too long to speak in one go." }, { status: 400 });
  }

  const voiceSession = openJ4VoiceOutputSession({ scope: { storeId: resolved.store.id } });
  if (!voiceSession) {
    // Honest degradation, same convention as every other real AI provider
    // in this app (see generatedImageProvider.ts) — no ELEVENLABS_API_KEY
    // configured yet. Never fabricate audio or silently no-op; a real,
    // specific status the client can distinguish from a genuine failure.
    return NextResponse.json({ error: "Voice isn't set up yet." }, { status: 503 });
  }

  const chunks: Buffer[] = [];

  const audioReady = new Promise<Buffer>((resolve, reject) => {
    voiceSession.onAudioChunk((base64Chunk) => {
      chunks.push(Buffer.from(base64Chunk, "base64"));
    });
    voiceSession.onError((err) => {
      reject(err);
    });
    voiceSession.onDone(() => {
      resolve(Buffer.concat(chunks));
    });
  });

  voiceSession.sendText(text);
  voiceSession.finish();

  let audio: Buffer;
  try {
    audio = await audioReady;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't generate speech for that reply." },
      { status: 502 }
    );
  }

  if (audio.length === 0) {
    return NextResponse.json({ error: "Couldn't generate speech for that reply." }, { status: 502 });
  }

  return new NextResponse(new Uint8Array(audio), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
