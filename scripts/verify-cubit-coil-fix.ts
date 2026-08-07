import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { STORE_CHAT_UNIFIED_SYSTEM_PROMPT } from "../lib/dashboard/storeChatUnified";

// Verifies the real fix for the reported bug: "I actually really like
// Cubit & Coil" right after Genesis proposed renaming the store to exactly
// that must stay conversational — never edit_store_content. Reproduces the
// real shape: a pending proposal note in the user turn, exactly like
// applyGenesisMessageToStore/app/api/chat/route.ts's own unifiedContextParts.
// One-off, kept for the record.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const tools: Anthropic.Tool[] = [
  { name: "look_up_business_data", description: "Look up real business data.", input_schema: z.toJSONSchema(z.object({})) as Anthropic.Tool.InputSchema },
  { name: "capture_business_fact", description: "Capture a durable business fact.", input_schema: z.toJSONSchema(z.object({ entityType: z.string(), data: z.record(z.string(), z.unknown()) })) as Anthropic.Tool.InputSchema },
  { name: "plan_campaign", description: "Plan a marketing campaign.", input_schema: z.toJSONSchema(z.object({})) as Anthropic.Tool.InputSchema },
  { name: "request_image_change", description: "Request a new product photo.", input_schema: z.toJSONSchema(z.object({ scope: z.enum(["all", "specific"]).nullable(), productNames: z.array(z.string()).nullable() })) as Anthropic.Tool.InputSchema },
  { name: "edit_store_content", description: "Actually change the store's identity, theme, or content.", input_schema: z.toJSONSchema(z.object({})) as Anthropic.Tool.InputSchema },
];

async function runCase(label: string, userTurn: string, priorAssistantTurn?: string) {
  const messages: Anthropic.MessageParam[] = [];
  if (priorAssistantTurn) {
    messages.push({ role: "user", content: "What do you think we should rename the store to?" });
    messages.push({ role: "assistant", content: priorAssistantTurn });
  }
  messages.push({ role: "user", content: userTurn });

  const msg = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 500,
    system: STORE_CHAT_UNIFIED_SYSTEM_PROMPT,
    messages,
    tools,
    tool_choice: { type: "auto" },
  });
  console.log(`\n=== ${label} ===`);
  console.log(`stop_reason=${msg.stop_reason}`);
  for (const b of msg.content) {
    if (b.type === "text") console.log(`  text: ${b.text}`);
    if (b.type === "tool_use") console.log(`  tool_use: ${b.name}(${JSON.stringify(b.input)})`);
  }
}

async function main() {
  const priorProposal = `I'd suggest "Cubit & Coil" — it's got a strong, crafted feel that fits your brand. Want me to go ahead and rename the store to that?`;
  const pendingNote = `(You previously proposed this change, awaiting confirmation: "Rename the store to Cubit & Coil")`;

  await runCase(
    "THE EXACT REPORTED BUG — reaction to a pending name proposal (expect: no tool call)",
    `I actually really like Cubit & Coil.\n${pendingNote}`,
    priorProposal
  );
  await runCase(
    "Real explicit confirmation of the same pending proposal (expect: edit_store_content)",
    `Yes, go ahead and rename it to that.\n${pendingNote}`,
    priorProposal
  );
  await runCase(
    "A different reaction phrase from the user's own examples (expect: no tool call)",
    `That looks good.\n${pendingNote}`,
    priorProposal
  );
  await runCase(
    "A real direct instruction with no prior proposal at all (expect: edit_store_content)",
    `Change the store name to Cubit & Coil.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
