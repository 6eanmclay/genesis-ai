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
  // M3 — real, honest about the fact that this one gets applied for you,
  // not just proposed: update_seo is genuinely auto-execute-tiered now
  // (see genesisActions.ts), so this task really does end with J4 having
  // already done the work, not another approval click.
  "task.no_seo":
    "Your store doesn't have an SEO title or meta description yet, so search engines have nothing real to show for it. Tell me a bit about what makes your store worth finding, and I'll write both and apply them for you directly.",
};

export function buildTaskSeedMessage(task: Pick<Task, "dedupeKey" | "summary">): string {
  // hasOwnProperty (2026-08-22). dedupeKey is a free string on a DB row, so a
  // task keyed "constructor" resolved to the inherited Object constructor —
  // truthy, so the honest fallback below never fired and a FUNCTION became the
  // opening line of a conversation with the owner. The fallback is the whole
  // point of this function ("an opening line must be exactly this honest,
  // specific statement, never a fabricated claim"), and a bare lookup was the
  // one way to skip it.
  const bespoke = Object.prototype.hasOwnProperty.call(SEED_MESSAGE_BY_DEDUPE_KEY, task.dedupeKey)
    ? SEED_MESSAGE_BY_DEDUPE_KEY[task.dedupeKey]
    : undefined;
  if (typeof bespoke === "string" && bespoke.length > 0) return bespoke;
  return `${task.summary} What would you like to do?`;
}

// Honest statement of what the owner did (mirrors "Uploaded a photo: x.jpg"
// in uploadBusinessAssetFromChat) — never a fabricated first-person quote,
// same voice-mechanics rule every real StoreMessage this codebase writes on
// the owner's behalf already follows.
export function buildTaskUserMessage(task: Pick<Task, "title">): string {
  return `Let's work on: ${task.title}`;
}

// BUSINESS_ASSETS_ARCHITECTURE.md M3 — "the user should never feel like
// they're starting over." Reopening a task already IN_PROGRESS (clicked
// once before, navigated away, comes back) gets a real, honest recap turn
// instead of either a duplicate seed message or silently reopening with no
// acknowledgment at all. Deliberately generic and status-only — never
// fabricates specifics about what was discussed (the real prior turns are
// already sitting right above this one in the same message history; this
// only needs to signal "I remember," not restate content the owner can
// already see).
export function buildTaskRecapMessage(task: Pick<Task, "title">): string {
  return `Picking back up on: ${task.title}. Everything from where we left off is still right here — what would you like to do next?`;
}
