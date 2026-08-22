// AI Cost & Usage Infrastructure, Milestone 1 — pure cost calculation,
// no I/O. Costs are computed and stored at record-time (open decision #4
// in the approved plan): editing a rate here only affects calls made
// after the edit, never rewrites historical AiUsageEvent rows. Rates are
// real, published, current prices — not researched from an invoice (none
// was available), same "clearly flagged placeholder, adjustable" status
// this codebase's other governance constants (e.g. DAILY_TOKEN_CEILING in
// lib/genesisModel.ts) already carry.

// $ per 1M tokens. Source: Anthropic's published pricing, cached
// 2026-08-04. Only "claude-opus-4-8" is actually used anywhere in this
// codebase today (confirmed by grep) — the table stays keyed by model
// string, not hardcoded to one rate, so a future model addition is a new
// row here, not a new code path.
const ANTHROPIC_RATES_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
};

// $ per image. gpt-image-1, quality "high", size "1024x1024" — the exact
// params lib/imageProviders/generatedImageProvider.ts sends today.
// Estimated from OpenAI's published per-image rate for this
// quality/size — no exact invoice line-item was available to confirm
// this to the cent; see the AI Cost & Usage Infrastructure plan's own
// note on this same estimate.
const OPENAI_IMAGE_RATE_USD: Record<string, number> = {
  "gpt-image-1": 0.17,
};

export interface AnthropicCostInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// Returns null (never throws, never guesses) for a model not yet in the
// rate table — the same "fail open on a governance concern, never break
// the real feature" convention callGenesisModel's own ceiling check
// already uses. A null costUsd on a real AiUsageEvent row means "a real
// call happened, its dollar cost isn't known yet," not "free."
export function computeAnthropicCost({ model, inputTokens, outputTokens }: AnthropicCostInput): number | null {
  // hasOwnProperty, and a real shape check (2026-08-22). A bare lookup returned
  // the inherited Object constructor for a model called "constructor" — truthy,
  // so `if (!rate)` passed it through, and `rate.input` was undefined, making
  // the arithmetic below return NaN.
  //
  // NaN is worse here than either honest answer. This file is explicit that
  // "a null costUsd on a real AiUsageEvent row means 'a real call happened, its
  // dollar cost isn't known yet,' not 'free'" — NaN is neither, and one NaN
  // poisons every SUM over a store's costs after it.
  const rate = Object.prototype.hasOwnProperty.call(ANTHROPIC_RATES_PER_MILLION_TOKENS, model)
    ? ANTHROPIC_RATES_PER_MILLION_TOKENS[model]
    : undefined;
  if (!rate || typeof rate.input !== "number" || typeof rate.output !== "number") return null;
  return (inputTokens * rate.input) / 1_000_000 + (outputTokens * rate.output) / 1_000_000;
}

export function computeImageCost(model: string, imageCount: number): number | null {
  // Same guard as computeAnthropicCost above, same reason: unknown must stay
  // unknown, and never become NaN.
  const rate = Object.prototype.hasOwnProperty.call(OPENAI_IMAGE_RATE_USD, model)
    ? OPENAI_IMAGE_RATE_USD[model]
    : undefined;
  if (typeof rate !== "number") return null;
  return rate * imageCount;
}

// $ per character. eleven_flash_v2_5 — J4's own spoken-response voice
// (lib/voice/j4VoiceOutput.ts), ElevenLabs' own recommended model for
// real-time/conversational use (lowest published latency, ~75ms).
// Estimated from ElevenLabs' published Creator-tier overage rate ($0.30
// per 1,000 characters, cached 2026-08-08) — same "real, published,
// clearly flagged, not an exact invoice line-item" status as the OpenAI
// image rate above; this app's actual ElevenLabs plan/tier isn't known
// from inside this codebase, so this is the most defensible real number
// available, not a guess.
const ELEVENLABS_RATE_USD_PER_CHARACTER: Record<string, number> = {
  eleven_flash_v2_5: 0.0003,
};

export function computeVoiceSynthesisCost(model: string, characterCount: number): number | null {
  const rate = Object.prototype.hasOwnProperty.call(ELEVENLABS_RATE_USD_PER_CHARACTER, model)
    ? ELEVENLABS_RATE_USD_PER_CHARACTER[model]
    : undefined;
  if (typeof rate !== "number") return null;
  return rate * characterCount;
}
