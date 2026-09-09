import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/prisma";
import { businessIntentFor } from "@/lib/businessIntent";
import { growthCreditValueFor } from "@/lib/growthCreditCatalog";
import type { GenesisModelScope } from "@/lib/genesisModel";
import { readTranscript } from "@/lib/voice/transcriptQuality";

// J4 Voice Memos — the transcription layer only. Understanding a memo's
// content (what it means, what to do with it) is deliberately NOT this
// file's job: the real transcript this returns becomes the userMessage
// passed into applyGenesisMessageToStore (app/dashboard/ai-actions.ts),
// the same real conversational understanding/routing pipeline a typed
// message goes through — never a second, parallel "interpret the memo"
// pipeline. This file only ever answers "what did they say."
//
// Same provider-abstraction shape as lib/imageProviders/generatedImageProvider.ts
// (this codebase's own established pattern for a non-Anthropic AI
// provider): a plain fetch call, no SDK dependency, "degrade to null,
// never throw" on any real failure.
const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const MODEL = "whisper-1";

interface TranscribeVoiceMemoParams {
  audioUrl: string;
  originalFilename: string;
  scope: GenesisModelScope;
}

interface TranscribeVoiceMemoResult {
  transcript: string;
  aiUsageEventId: string | null;
}

async function recordTranscriptionUsage(scope: GenesisModelScope, durationMs: number): Promise<string | null> {
  try {
    const event = await prisma.aiUsageEvent.create({
      data: {
        ...scope,
        inputTokens: 0,
        outputTokens: 0,
        feature: "voice_memo_transcription",
        provider: "openai",
        model: MODEL,
        durationMs,
        // Real per-minute Whisper pricing needs the audio's real duration,
        // which nothing here decodes yet — costUsd stays null rather than
        // guessed, the same "a real call happened, its dollar cost isn't
        // known yet" convention AiUsageEvent.costUsd's own schema comment
        // documents (see prisma/schema.prisma).
        costUsd: null,
        businessIntent: businessIntentFor("voice_memo_transcription"),
        growthCreditValue: growthCreditValueFor("voice_memo_transcription"),
      },
    });
    return event.id;
  } catch (err) {
    Sentry.captureException(err);
    return null;
  }
}

// Real dependency (2026-08-08) — OpenAI's transcription API only ever
// accepts real audio bytes as multipart/form-data, never a URL (confirmed
// against OpenAI's own docs), so this fetches the already-uploaded Vercel
// Blob (the browser did the real upload, same as photos/documents — see
// uploadVoiceMemo, app/dashboard/ai-actions.ts) and re-sends its bytes on.
export async function transcribeVoiceMemo(params: TranscribeVoiceMemoParams): Promise<TranscribeVoiceMemoResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const startedAt = Date.now();
  let rawTranscript: string | null = null;
  try {
    const audioResponse = await fetch(params.audioUrl);
    if (!audioResponse.ok) return null;
    const audioBlob = await audioResponse.blob();

    const formData = new FormData();
    formData.append("file", audioBlob, params.originalFilename);
    formData.append("model", MODEL);
    formData.append("response_format", "json");

    const response = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });
    if (!response.ok) return null;

    const json = (await response.json()) as { text?: string };
    rawTranscript = json.text?.trim() || null;
  } catch {
    return null;
  }

  // WHAT WHISPER RETURNED IS NOT ALWAYS WHAT WAS SAID (2026-09-09).
  //
  // Two real production turns: "OK. 834. OK. 834." (said once, looped by
  // Whisper) and "Thank you for watching." (never said at all - its stock
  // output on silence). Both were stored as genuine user messages and
  // answered. Returning null here means NO user turn is created, which is
  // the honest outcome for silence: the owner's conversation should not
  // contain sentences they did not speak.
  const reading = readTranscript(rawTranscript);
  if (reading.kind === "silence") {
    // Recorded, not swallowed - a transcription really was paid for, and a
    // rise in these is how we would notice the microphone misbehaving.
    await recordTranscriptionUsage(params.scope, Date.now() - startedAt);
    return null;
  }
  const transcript = reading.text;

  const aiUsageEventId = await recordTranscriptionUsage(params.scope, Date.now() - startedAt);
  return { transcript, aiUsageEventId };
}
