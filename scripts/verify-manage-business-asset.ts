import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { STORE_CHAT_UNIFIED_SYSTEM_PROMPT } from "../lib/dashboard/storeChatUnified";

// Verifies the real fix for "J4 said it can't save an uploaded file"
// (2026-08-08): confirms manage_business_asset actually gets selected for
// real save/keep/designate phrasing, with role resolved correctly, and
// does NOT fire for unrelated messages. One-off, kept for the record.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const tools: Anthropic.Tool[] = [
  { name: "look_up_business_data", description: "Look up real business data.", input_schema: z.toJSONSchema(z.object({})) as Anthropic.Tool.InputSchema },
  { name: "capture_business_fact", description: "Capture a durable business fact.", input_schema: z.toJSONSchema(z.object({ entityType: z.string(), data: z.record(z.string(), z.unknown()) })) as Anthropic.Tool.InputSchema },
  { name: "plan_campaign", description: "Plan a marketing campaign.", input_schema: z.toJSONSchema(z.object({})) as Anthropic.Tool.InputSchema },
  { name: "request_image_change", description: "Request a new product photo.", input_schema: z.toJSONSchema(z.object({ scope: z.enum(["all", "specific"]).nullable(), productNames: z.array(z.string()).nullable() })) as Anthropic.Tool.InputSchema },
  { name: "request_product_removal", description: "Remove one or more existing products.", input_schema: z.toJSONSchema(z.object({ scope: z.enum(["all", "specific"]).nullable(), productNames: z.array(z.string()).nullable() })) as Anthropic.Tool.InputSchema },
  { name: "edit_store_content", description: "Actually change the store's identity, theme, or content.", input_schema: z.toJSONSchema(z.object({})) as Anthropic.Tool.InputSchema },
  {
    name: "manage_business_asset",
    description:
      "Call this when the merchant asks you to save, keep, hold onto, or designate a file they've already uploaded — e.g. 'save this', 'keep this for later', 'save this as my logo', 'use this as the product photo'. This ALWAYS refers to the most recently uploaded photo or document in this conversation. If the merchant names a specific role or purpose for it, set role to that; if they just say 'save this'/'keep this' with no stated purpose, set role to null.",
    input_schema: z.toJSONSchema(z.object({ role: z.string().nullable() })) as Anthropic.Tool.InputSchema,
  },
];

async function runCase(label: string, userTurn: string, priorTurns: Anthropic.MessageParam[] = []) {
  const messages: Anthropic.MessageParam[] = [...priorTurns, { role: "user", content: userTurn }];
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
  const afterUpload: Anthropic.MessageParam[] = [
    { role: "user", content: "Uploaded a photo: logo.png\n(Active products: Copper Ring)" },
    { role: "assistant", content: "I've saved this photo to your business files. I can see it's a logo, but I'm not fully sure what it is — an abstract mark with your initials. Can you tell me a bit more about what this is, so I file it correctly?" },
  ];

  await runCase(
    "Plain 'save this' right after an upload (expect: manage_business_asset, role: null)",
    "Can you save the best logo on a file?",
    afterUpload
  );
  await runCase(
    "Unambiguous plain 'save this' — the real reported scenario, one file, no 'best' framing (expect: manage_business_asset, role: null)",
    "Can you save this on file for me?",
    afterUpload
  );
  await runCase(
    "Explicit role — 'save this as my logo' (expect: manage_business_asset, role set)",
    "Save this as my primary logo.",
    afterUpload
  );
  await runCase(
    "Explicit role — product photo (expect: manage_business_asset, role set)",
    "Use this as the product photo for the copper ring.",
    afterUpload
  );
  await runCase(
    "Unrelated message, should NOT fire manage_business_asset (expect: no tool call, or a different real tool)",
    "How much revenue did we make last week?",
    afterUpload
  );
  await runCase(
    "Reaction to the file, not a save instruction (expect: no tool call — conversation)",
    "Oh nice, that one looks good.",
    afterUpload
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
