import WebSocket from "ws";
import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/prisma";
import { businessIntentFor } from "@/lib/businessIntent";
import { growthCreditValueFor } from "@/lib/growthCreditCatalog";
import { computeVoiceSynthesisCost } from "@/lib/aiPricing";
import type { GenesisModelScope } from "@/lib/genesisModel";

// J4 spoken response (2026-08-08) — "J4 receives -> text renders
// progressively -> speech begins as soon as there is enough text to
// speak and continues while the remaining response is generated...
// text and voice driven from the same response stream" (Sean). This is
// the ONE place in the app that talks to ElevenLabs — app/api/chat/route.ts
// calls only this interface, never the provider directly, so a future
// provider swap (Sean's explicit requirement: "keep the voice
// implementation behind the J4 voice abstraction") means reimplementing
// this one file, no call-site changes anywhere else.
//
// Protocol verified directly against ElevenLabs' current docs
// (2026-08-08, not recalled from training data): a WebSocket streaming-
// input connection that accepts partial text as it arrives and returns
// synthesized audio chunks incrementally — the real technical fit for
// "feed incremental text, get incremental audio back," which a
// request/response TTS API (OpenAI's tts-1, for one) cannot do.
const ELEVENLABS_MODEL = "eleven_flash_v2_5"; // ElevenLabs' own recommended model for real-time/conversational use — lowest published latency (~75ms)
// A real, provisional choice (ElevenLabs' own long-standing default demo
// voice, "Rachel") — nothing in this app lets an owner choose J4's voice
// yet; override via env without a code change once that's a real
// decision, not a placeholder pretending to be one.
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

export interface J4VoiceOutputSession {
  // Feed the next text delta as it arrives from Anthropic's own stream —
  // callers never need to worry about word-boundary chunking; this
  // buffers internally and only ever sends ElevenLabs a complete word at
  // a time (their own protocol requires each message end on a real word
  // boundary).
  sendText(delta: string): void;
  // Flush whatever's buffered and cleanly close the input side once the
  // real text response is done generating.
  finish(): void;
  onAudioChunk(cb: (base64Chunk: string) => void): void;
  onError(cb: (err: Error) => void): void;
  // J4 Voice Output (2026-08-08) — fires once ElevenLabs' own completion
  // signal arrives (a real, documented {"isFinal": true} message, verified
  // against ElevenLabs' current docs — audio is guaranteed null on this
  // message). A batch caller (app/api/j4/speak/route.ts, synthesizing a
  // complete finished reply rather than relaying live chunks) needs this
  // to know when it has every chunk and can safely close the connection
  // and return the assembled audio; the original live-relay caller
  // (app/api/chat/route.ts, not yet wired) has no real need for it and can
  // simply not register one.
  onDone(cb: () => void): void;
  // Real cancellation — stops billing ElevenLabs for audio nobody will
  // hear the instant the owner interrupts (see route.ts's own comment on
  // why this is a deliberate asymmetry from the text path, which always
  // completes and persists regardless of client presence).
  abort(): void;
}

async function recordVoiceOutputUsage(scope: GenesisModelScope, characterCount: number, durationMs: number): Promise<void> {
  try {
    await prisma.aiUsageEvent.create({
      data: {
        ...scope,
        inputTokens: 0,
        outputTokens: 0,
        feature: "j4_voice_output",
        provider: "elevenlabs",
        model: ELEVENLABS_MODEL,
        durationMs,
        costUsd: computeVoiceSynthesisCost(ELEVENLABS_MODEL, characterCount),
        businessIntent: businessIntentFor("j4_voice_output"),
        growthCreditValue: growthCreditValueFor("j4_voice_output"),
      },
    });
  } catch (err) {
    Sentry.captureException(err);
  }
}

// Returns null when no ElevenLabs credential exists — the same "degrade
// to null, never throw" convention every other real AI provider in this
// app already follows (see generatedImageProvider.ts); route.ts treats
// null exactly like "voice unavailable" and the text path is completely
// unaffected, never blocked on this.
export function openJ4VoiceOutputSession(params: { scope: GenesisModelScope; voiceId?: string }): J4VoiceOutputSession | null {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  const voiceId = params.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID;
  const startedAt = Date.now();
  let characterCount = 0;
  let textBuffer = "";
  let closed = false;
  let audioCb: ((chunk: string) => void) | null = null;
  let errorCb: ((err: Error) => void) | null = null;
  let doneCb: (() => void) | null = null;

  const socket = new WebSocket(
    `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${ELEVENLABS_MODEL}&output_format=mp3_44100_128`,
    { headers: { "xi-api-key": apiKey } }
  );

  const ready = new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          text: " ",
          voice_settings: { stability: 0.5, similarity_boost: 0.75, use_speaker_boost: true },
          generation_config: { chunk_length_schedule: [120, 160, 250, 290] },
        })
      );
      resolve();
    });
    socket.once("error", (err: Error) => reject(err));
  }).catch(() => {
    // Swallowed here deliberately — the real error still reaches
    // errorCb via the socket's own "error" listener below, once a
    // caller has actually registered one. This promise only exists to
    // sequence sends after the socket is genuinely open.
  });

  socket.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as { audio?: string; error?: string; message?: string; isFinal?: boolean };
      if (msg.audio) audioCb?.(msg.audio);
      if (msg.error) errorCb?.(new Error(msg.message ?? msg.error));
      // Real, documented completion signal — audio is null on this
      // message, nothing more will ever arrive on this connection.
      if (msg.isFinal) {
        doneCb?.();
        try {
          socket.close();
        } catch {
          // Already closing/closed — nothing more to do.
        }
      }
    } catch (err) {
      errorCb?.(err instanceof Error ? err : new Error(String(err)));
    }
  });
  socket.on("error", (err: Error) => {
    errorCb?.(err);
  });

  function send(text: string) {
    characterCount += text.length;
    ready.then(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ text }));
    });
  }

  // ElevenLabs' streaming-input protocol requires each message to end on
  // a real word boundary (their own docs: "should always end with a
  // single space") — Anthropic's raw deltas routinely split mid-word, so
  // this holds back any trailing partial word until the next delta
  // completes it, rather than corrupting the text with an inserted space.
  function flushCompleteWords() {
    const lastSpace = textBuffer.lastIndexOf(" ");
    if (lastSpace === -1) return;
    const complete = textBuffer.slice(0, lastSpace + 1);
    textBuffer = textBuffer.slice(lastSpace + 1);
    if (complete.trim()) send(complete);
  }

  return {
    sendText(delta) {
      if (closed) return;
      textBuffer += delta;
      flushCompleteWords();
    },
    finish() {
      if (closed) return;
      closed = true;
      const remaining = textBuffer.trim();
      textBuffer = "";
      if (remaining) send(`${remaining} `);
      ready
        .then(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ text: "" }));
        })
        .finally(() => {
          void recordVoiceOutputUsage(params.scope, characterCount, Date.now() - startedAt);
        });
    },
    onAudioChunk(cb) {
      audioCb = cb;
    },
    onError(cb) {
      errorCb = cb;
    },
    onDone(cb) {
      doneCb = cb;
    },
    abort() {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {
        // Already closing/closed — nothing more to do.
      }
      void recordVoiceOutputUsage(params.scope, characterCount, Date.now() - startedAt);
    },
  };
}
