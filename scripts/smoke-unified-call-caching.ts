import "dotenv/config";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";

// Response Modes plan, Phase 1 — final smoke test mirroring the exact real
// shape now in applyGenesisMessageToStore: tools + cache_control on system
// (covers tools too) + cache_control on the last history message + a new
// user turn. Confirms cache_creation on turn 1, cache_read on turn 2 with
// identical history, and that a pure conversational reply on turn 2 still
// costs no tool call. One-off, kept for the record.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const tools: Anthropic.Tool[] = [
  {
    name: "look_up_business_data",
    description: "Look up real business data to answer a factual question. Never call for a conversational message.",
    input_schema: z.toJSONSchema(z.object({})) as Anthropic.Tool.InputSchema,
  },
];

const SYSTEM = "You are J4, a business partner AI. If the message is pure conversation, reply in plain text only. Otherwise call look_up_business_data.".repeat(50);

async function turn(label: string, history: Anthropic.MessageParam[], newUserMessage: string) {
  const messages: Anthropic.MessageParam[] =
    history.length > 0
      ? [
          ...history.slice(0, -1),
          {
            role: history[history.length - 1].role,
            content: [
              { type: "text", text: history[history.length - 1].content as string, cache_control: { type: "ephemeral" } },
            ],
          },
          { role: "user", content: newUserMessage },
        ]
      : [{ role: "user", content: newUserMessage }];

  const start = Date.now();
  const msg = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 500,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages,
    tools,
    tool_choice: { type: "auto" },
  });
  console.log(`\n=== ${label} (${Date.now() - start}ms) ===`);
  console.log(`stop_reason=${msg.stop_reason} cache_creation=${msg.usage.cache_creation_input_tokens} cache_read=${msg.usage.cache_read_input_tokens} input_tokens=${msg.usage.input_tokens}`);
  for (const b of msg.content) {
    if (b.type === "text") console.log(`  text: ${b.text}`);
    if (b.type === "tool_use") console.log(`  tool_use: ${b.name}`);
  }
  return [...history, { role: "user" as const, content: newUserMessage }, { role: "assistant" as const, content: msg.content.find((b) => b.type === "text")?.text ?? "" }];
}

async function main() {
  let history = await turn("Turn 1 (cold, cache_creation expected)", [], "I actually really like Cubit & Coil.");
  history = await turn("Turn 2 (same history prefix, cache_read expected)", history, "What was my revenue last week?");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
