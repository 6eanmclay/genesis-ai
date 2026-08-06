import type { Task } from "@prisma/client";

// BUSINESS_ASSETS_ARCHITECTURE.md M2 — fixed, deterministic reply strings
// per task type, same discipline as the upload-intent classifier's fixed
// reply (see GenesisAssistant.tsx's own comment on why "uploads work, here's
// how" must never be model-paraphrased): a task's opening line is exactly
// this honest, specific statement, never a fabricated claim about what J4
// already knows. Keyed by dedupeKey rather than a broader "kind" because
// each detector's own real condition (no products vs. no logo) needs a
// genuinely different first question, not a generic template — extend this
// map as new detectors are added; a task type with no entry here still gets
// an honest, if more generic, opening built from its own real summary.
const SEED_MESSAGE_BY_DEDUPE_KEY: Record<string, string> = {
  "task.no_products":
    "You don't have any products yet — that's the first thing a customer needs to see before your store can sell anything. Tell me what you'd like to sell (what it is, and roughly what you'd charge) and I'll get a real listing ready for you to review.",
  "task.no_logo":
    "Your store doesn't have a logo yet — it's one of the first things a visitor notices. I can generate real options from your brand identity, or if you already have one, you can upload it right here. Which would you like to do?",
};

export function buildTaskSeedMessage(task: Pick<Task, "dedupeKey" | "summary">): string {
  return SEED_MESSAGE_BY_DEDUPE_KEY[task.dedupeKey] ?? `${task.summary} What would you like to do?`;
}

// Honest statement of what the owner did (mirrors "Uploaded a photo: x.jpg"
// in uploadBusinessAssetFromChat) — never a fabricated first-person quote,
// same voice-mechanics rule every real StoreMessage this codebase writes on
// the owner's behalf already follows.
export function buildTaskUserMessage(task: Pick<Task, "title">): string {
  return `Let's work on: ${task.title}`;
}
