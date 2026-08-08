import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { STORE_CHAT_UNIFIED_SYSTEM_PROMPT } from "../lib/dashboard/storeChatUnified";

// Diagnosing why "What do we need to accomplish today?" produced a long
// response instead of a short, action-oriented one. Checks which tool (if
// any) the unified call selects for this exact message, since that
// determines which prompt (and which length discipline) actually governs
// the reply. One-off, kept for the record.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const tools: Anthropic.Tool[] = [
  { name: "look_up_business_data", description: "Call this when the merchant is asking to be TOLD or EXPLAINED something using real business data or understanding — a factual question (revenue, orders, customers, appointments, goals, challenges, connected systems), or a genuine planning/strategy question (\"what should I do next\", \"build me a 90-day plan\", \"how would you spend N Growth Points\"). Never call it for a request to actually change something.", input_schema: z.toJSONSchema(z.object({})) as Anthropic.Tool.InputSchema },
  { name: "capture_business_fact", description: "Capture a durable business fact.", input_schema: z.toJSONSchema(z.object({ entityType: z.string(), data: z.record(z.string(), z.unknown()) })) as Anthropic.Tool.InputSchema },
  { name: "plan_campaign", description: "Plan a marketing campaign.", input_schema: z.toJSONSchema(z.object({})) as Anthropic.Tool.InputSchema },
  { name: "request_image_change", description: "Request a new product photo.", input_schema: z.toJSONSchema(z.object({ scope: z.enum(["all", "specific"]).nullable(), productNames: z.array(z.string()).nullable() })) as Anthropic.Tool.InputSchema },
  { name: "edit_store_content", description: "Actually change the store's identity, theme, or content.", input_schema: z.toJSONSchema(z.object({})) as Anthropic.Tool.InputSchema },
];

async function runCase(label: string, userMessage: string) {
  const msg = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1500,
    system: STORE_CHAT_UNIFIED_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `${userMessage}\n(Active products: none)` }],
    tools,
    tool_choice: { type: "auto" },
  });
  console.log(`\n=== ${label} ===`);
  console.log(`user: "${userMessage}"`);
  console.log(`stop_reason=${msg.stop_reason}`);
  for (const b of msg.content) {
    if (b.type === "text") console.log(`  text (${b.text.length} chars): ${b.text}`);
    if (b.type === "tool_use") console.log(`  tool_use: ${b.name}(${JSON.stringify(b.input)})`);
  }
}

async function main() {
  await runCase("The reported case", "What do we need to accomplish today?");
  await runCase("A close variant", "What should I work on today?");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
