import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// Read-only measurement, Response Modes plan Phase 0 continued — does a
// realistically large (~13KB, matching STORE_CHAT_PRIMARY_SYSTEM_PROMPT's
// real measured size) uncached system prompt add meaningfully to TTFT vs
// the tiny prompt in measure-ttft.ts? Synthetic filler text standing in for
// the real prompt's size only (not its content) — this is a load-shape
// test, not a quality test. One-off, not meant to be re-run as part of any build.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FILLER_PARAGRAPH =
  "When responding to the merchant, maintain a consistent, confident, expert voice throughout, and make sure every recommendation is grounded in the specifics of their business rather than generic advice that could apply to any store. ";
const LARGE_SYSTEM_PROMPT =
  "You are J4, a business partner AI. Reply naturally and briefly to what the owner said, as if chatting.\n\n" +
  FILLER_PARAGRAPH.repeat(Math.ceil(13000 / FILLER_PARAGRAPH.length));

async function measureOnce(label: string, useCache: boolean) {
  const start = Date.now();
  let firstTokenAt: number | null = null;

  const stream = anthropic.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 300,
    system: useCache
      ? [{ type: "text", text: LARGE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]
      : LARGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: "I actually really like Cubit & Coil." }],
  });

  stream.on("text", () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  });

  const final = await stream.finalMessage();
  const fullAt = Date.now();

  console.log(`\n=== ${label} ===`);
  console.log(`system prompt length: ${LARGE_SYSTEM_PROMPT.length} chars`);
  console.log(`time-to-first-token: ${firstTokenAt ? firstTokenAt - start : "n/a"}ms`);
  console.log(`time-to-full-response: ${fullAt - start}ms`);
  console.log(`cache_creation_input_tokens=${final.usage.cache_creation_input_tokens ?? 0} cache_read_input_tokens=${final.usage.cache_read_input_tokens ?? 0} input_tokens=${final.usage.input_tokens}`);
}

async function main() {
  await measureOnce("Large uncached system prompt (cold, first call)", false);
  await measureOnce("Large system prompt, cache_control set (cold — first write, no read yet)", true);
  await measureOnce("Large system prompt, cache_control set (should be a warm cache READ now)", true);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
