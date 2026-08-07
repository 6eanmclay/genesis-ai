import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// Read-only measurement, Response Modes plan Phase 0 — real time-to-first-token
// for a small, classifier-shaped call on claude-opus-4-8, since historical
// ProductEvent rows only ever recorded total call duration (no streaming was
// ever used in this codebase, so no prior TTFT data exists). Not meant to be
// re-run as part of any build — a one-off measurement, kept for the record.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function measureOnce(label: string, opts: { thinking: "adaptive" | "disabled"; maxTokens: number }) {
  const start = Date.now();
  let firstTokenAt: number | null = null;
  let fullTextAt: number | null = null;

  const stream = anthropic.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: opts.maxTokens,
    thinking: opts.thinking === "adaptive" ? { type: "adaptive" } : undefined,
    system: "You are J4, a business partner AI. Reply naturally and briefly to what the owner said, as if chatting.",
    messages: [{ role: "user", content: "I actually really like Cubit & Coil." }],
  });

  stream.on("text", () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  });

  const final = await stream.finalMessage();
  fullTextAt = Date.now();

  console.log(`\n=== ${label} ===`);
  console.log(`thinking=${opts.thinking} max_tokens=${opts.maxTokens}`);
  console.log(`time-to-first-token: ${firstTokenAt ? firstTokenAt - start : "n/a"}ms`);
  console.log(`time-to-full-response: ${fullTextAt - start}ms`);
  console.log(`stop_reason=${final.stop_reason} output_tokens=${final.usage.output_tokens}`);
  const textBlock = final.content.find((b) => b.type === "text");
  console.log(`reply: ${textBlock && "text" in textBlock ? textBlock.text : "(no text block)"}`);
}

async function main() {
  await measureOnce("Adaptive thinking, max_tokens=1000 (current codebase pattern)", { thinking: "adaptive", maxTokens: 1000 });
  await measureOnce("Thinking disabled, max_tokens=300 (candidate fast-path config)", { thinking: "disabled", maxTokens: 300 });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
