import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { GoalCaptureSchema, ChallengeCaptureSchema, EmployeeCaptureSchema, LocationCaptureSchema } from "@/lib/businessModel/factCapture";

// Response Modes plan (2026-08-07), Phase 1 — replaces four sequential
// classifier calls (data-question, business-fact, campaign-request,
// image-request) plus the implicit "none matched" fallthrough to PRIMARY
// with one tool-enabled call in applyGenesisMessageToStore. Upload-intent
// stays a separate, earlier classifier there for a real permission reason
// (it must run before the store:manage gate) — these five tools all
// require store:manage and only ever run after that gate.
//
// Each input schema deliberately drops the trigger boolean and reply-text
// fields the old classifier schemas carried (isDataQuestion, isImageRequest,
// confirmationReply, etc.) — calling the tool at all IS the trigger now, and
// the natural-language reply comes from the model's own accompanying text
// block in the same turn, not a schema field.

export const BusinessFactCaptureInputSchema = z.discriminatedUnion("entityType", [
  z.object({ entityType: z.literal("goal"), data: GoalCaptureSchema }),
  z.object({ entityType: z.literal("challenge"), data: ChallengeCaptureSchema }),
  z.object({ entityType: z.literal("employee"), data: EmployeeCaptureSchema }),
  z.object({ entityType: z.literal("location"), data: LocationCaptureSchema }),
]);
export type BusinessFactCaptureInput = z.infer<typeof BusinessFactCaptureInputSchema>;

// Real production bug, found via trace evidence (2026-08-08) — every
// single J4 Portal message was failing the unified call with a genuine
// Anthropic 400 ("tools.1.custom.input_schema.type: Field required"),
// silently forcing every turn onto the old non-streaming fallback path.
// Root cause, reproduced locally: z.toJSONSchema() on a discriminated
// union puts "oneOf" at the schema root with no root "type" key —
// Anthropic's tool input_schema requires "type": "object" at the root.
// This is a separate, looser schema purely for what Anthropic sees;
// BusinessFactCaptureInputSchema (the real discriminated union) stays
// the source of truth for TypeScript narrowing in route.ts, and the real
// per-entityType strict validation still happens there via
// ENTITY_REGISTRY[entityType].schema.safeParse after the tool call
// returns, completely unchanged.
const BUSINESS_FACT_CAPTURE_TOOL_SCHEMA = z.object({
  entityType: z.enum(["goal", "challenge", "employee", "location"]),
  data: z.record(z.string(), z.unknown()),
});

export const RequestImageChangeInputSchema = z.object({
  scope: z.enum(["all", "specific"]).nullable(),
  productNames: z.array(z.string()).nullable(),
});
export type RequestImageChangeInput = z.infer<typeof RequestImageChangeInputSchema>;

// 2026-08-08 — the missing product-delete capability, same real scope-
// resolution shape as RequestImageChangeInputSchema above (an "all"/
// "specific" split resolved against the real active product list, never
// trusting the model's own restatement of which product it means). A
// separate tool, not folded into edit_store_content: this is a discrete,
// list-based structural removal, not a content-generation request, and
// (unlike edit_store_content) never needs the PRIMARY content pipeline —
// it's handled as its own real fast path exactly like request_image_change.
export const RequestProductRemovalInputSchema = z.object({
  scope: z.enum(["all", "specific"]).nullable(),
  productNames: z.array(z.string()).nullable(),
});
export type RequestProductRemovalInput = z.infer<typeof RequestProductRemovalInputSchema>;

const EMPTY_INPUT_SCHEMA = z.object({});

export const STORE_CHAT_UNIFIED_TOOL_NAMES = [
  "look_up_business_data",
  "capture_business_fact",
  "plan_campaign",
  "request_image_change",
  "request_product_removal",
  "edit_store_content",
] as const;
export type StoreChatUnifiedToolName = (typeof STORE_CHAT_UNIFIED_TOOL_NAMES)[number];

export function buildStoreChatUnifiedTools(): Anthropic.Tool[] {
  return [
    {
      name: "look_up_business_data",
      description:
        "Call this when the merchant is asking to be TOLD or EXPLAINED something using real business data or understanding — a factual question (revenue, orders, customers, appointments), or a genuine planning/strategy question ('what should I do next', 'build me a 90-day plan', 'how would you spend N Growth Points'). Never call this for a request to actually change something.",
      input_schema: z.toJSONSchema(EMPTY_INPUT_SCHEMA) as Anthropic.Tool.InputSchema,
    },
    {
      name: "capture_business_fact",
      description:
        "Call this when the merchant is stating a durable fact about their business you should remember — a goal they have, a challenge they're currently facing, a new employee, or a location — not a question, not a content-change request, not ordinary conversation. Fill in only what you can confidently infer from the actual message; leave optional fields null rather than guessing.",
      input_schema: z.toJSONSchema(BUSINESS_FACT_CAPTURE_TOOL_SCHEMA) as Anthropic.Tool.InputSchema,
    },
    {
      name: "plan_campaign",
      description:
        "Call this when the merchant is asking you to actually plan or create a marketing campaign — real promotional content across one or more channels (email, social, or similar). Not a question about marketing strategy — that's look_up_business_data.",
      input_schema: z.toJSONSchema(EMPTY_INPUT_SCHEMA) as Anthropic.Tool.InputSchema,
    },
    {
      name: "request_image_change",
      description:
        "Call this when the merchant is asking to replace, regenerate, or find a new photo for one or more existing products. Resolve scope yourself: 'all' when they clearly mean every active product, 'specific' with productNames set to the exact matching names, or null only when the scope is genuinely unclear (then ask a specific clarifying question in your reply text).",
      input_schema: z.toJSONSchema(RequestImageChangeInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "request_product_removal",
      description:
        "Call this when the merchant explicitly asks to remove, delete, discontinue, or get rid of one or more existing products — e.g. 'the old ones are obsolete, remove them', 'discontinue the wipes', 'delete that product'. This is a DESTRUCTIVE, irreversible action: calling this tool only PROPOSES the removal for the merchant's own review and approval, it never deletes anything immediately. Resolve scope against the active product list the same way as request_image_change: 'all' when they clearly mean every active product, 'specific' with productNames set to the exact matching names, or null only when genuinely unclear (then ask a specific clarifying question in your reply text).",
      input_schema: z.toJSONSchema(RequestProductRemovalInputSchema) as Anthropic.Tool.InputSchema,
    },
    {
      name: "edit_store_content",
      description:
        "Call this when the merchant is asking to actually change the store's identity, tagline, description, theme, brand identity, homepage content, policies, or design direction — anything that edits the live store, rather than answering a question, capturing a fact, planning a campaign, or changing a product photo.",
      input_schema: z.toJSONSchema(EMPTY_INPUT_SCHEMA) as Anthropic.Tool.InputSchema,
    },
  ];
}

// Picks the first tool_use block, matching today's own "exactly one
// classifier ever matches" behavior — if a future model version calls more
// than one tool in a turn, the rest are deliberately ignored for now rather
// than handled, a real open question named in the plan (how a turn with
// multiple tool calls reports back to the owner), not silently guessed at.
export function firstToolUse(content: Anthropic.Message["content"]): Anthropic.ToolUseBlock | null {
  for (const block of content) {
    if (block.type === "tool_use") return block;
  }
  return null;
}

export function textOf(content: Anthropic.Message["content"]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
