import "dotenv/config";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";

// Response Modes plan, Phase 1 pre-flight — this codebase has never
// exercised real tool-calling (grepped, zero prior use). Before wiring
// tools into the live chat path, confirm end-to-end: Zod schema -> JSON
// Schema -> Anthropic tool definition -> the model actually invoking it
// vs. replying in plain text when no tool is warranted. One-off smoke
// test, kept for the record like this project's other measurement scripts.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LookUpBusinessDataSchema = z.object({
  question: z.string().describe("The specific business question to look up an answer for"),
});
console.log("=== Zod -> JSON Schema (input_schema) ===");
const inputSchema = z.toJSONSchema(LookUpBusinessDataSchema);
console.log(JSON.stringify(inputSchema, null, 2));

const tools: Anthropic.Tool[] = [
  {
    name: "look_up_business_data",
    description: "Look up real data about the merchant's business (revenue, orders, customers, appointments) to answer a factual question. Only call this when the merchant is asking to be told something, not when they're just chatting or asking for a change.",
    input_schema: inputSchema as Anthropic.Tool.InputSchema,
  },
];

async function runCase(label: string, userMessage: string) {
  const msg = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 500,
    system: "You are J4, a business partner AI chatting with the store owner. If the message is pure conversation (an opinion, acknowledgment, small talk), just reply in plain text — do not call any tool. If it's a real question that needs real business data to answer, call look_up_business_data.",
    messages: [{ role: "user", content: userMessage }],
    tools,
    tool_choice: { type: "auto" },
  });
  console.log(`\n=== ${label} ===`);
  console.log(`user: "${userMessage}"`);
  console.log(`stop_reason: ${msg.stop_reason}`);
  for (const block of msg.content) {
    if (block.type === "text") console.log(`  text: ${block.text}`);
    if (block.type === "tool_use") console.log(`  tool_use: ${block.name}(${JSON.stringify(block.input)})`);
  }
}

async function main() {
  await runCase("Pure conversational message (expect: plain text, no tool call)", "I actually really like Cubit & Coil.");
  await runCase("Real data question (expect: tool_use on look_up_business_data)", "How much revenue did I make last week?");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
