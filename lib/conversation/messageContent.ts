/**
 * TURNING A STORED MESSAGE INTO WHAT THE MODEL ACTUALLY RECEIVES.
 *
 * ============ J4 COULD NOT SEE (2026-09-09) ============================
 *
 * Sean uploaded a photo and asked J4 to critique it. J4 answered:
 *
 *     "I can see that you've uploaded one photo and I've saved it to your
 *      business files, but I can't actually make out its contents well enough
 *      to critique it detail by detail"
 *
 * That answer was HONEST and CORRECT, which is why it took a trace to find
 * the bug. J4 genuinely could not see it. The conversation history was built
 * like this:
 *
 *     existingMessages.map((m) => ({ role, content: m.content }))
 *
 * and the photo lives in `m.changes.imageUrls`, so the model received the
 * literal text "Uploaded 1 photos" and nothing else. The bytes were safely in
 * Blob storage the whole time; the request simply never mentioned them.
 *
 * ============ THE MECHANISM ALREADY EXISTED ============================
 *
 * lib/businessAssets/classify.ts already sends uploads to a vision-capable
 * model and gets real descriptions back - it has done since 2026-08-09. It
 * builds exactly this block:
 *
 *     { type: "image", source: { type: "url", url } }
 *
 * So this is not a new capability and not a second system. It is the same
 * proven block, on the conversation path, where it was missing.
 *
 * ============ WHY THE LIMITS BELOW ARE NOT ARBITRARY ===================
 *
 * Every image in history would be re-sent on EVERY turn - the conversation
 * window is the last N messages, so a photo uploaded once would be paid for
 * again on every subsequent turn until it scrolled out. That is how a 79k
 * token request happens. Images are therefore attached only to recent user
 * messages and capped, and the cap is stated here rather than discovered in a
 * bill.
 */

/** The most images sent in any one request, newest first. */
export const MAX_IMAGES_PER_REQUEST = 4;

/**
 * How far back a message can be and still carry its images.
 *
 * An upload matters to the turn that follows it and usually the one after.
 * Beyond that the owner has moved on, J4's own reply already describes what
 * was in it, and re-sending the bytes is pure cost.
 */
export const IMAGE_RECENCY_WINDOW = 4;

/** Anthropic content blocks, narrowed to what this path builds. */
export type ModelContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "url"; url: string } };

export interface StoredMessage {
  role: string;
  content: string;
  changes?: unknown;
}

export interface ModelMessage {
  role: "user" | "assistant";
  content: string | ModelContentBlock[];
}

/** The image urls a stored message carries, if any. */
export function imageUrlsOf(message: StoredMessage): string[] {
  const changes = message.changes;
  if (!changes || typeof changes !== "object") return [];
  const urls = (changes as { imageUrls?: unknown }).imageUrls;
  if (!Array.isArray(urls)) return [];
  return urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
}

/**
 * Build the messages array for a model request, carrying recent images.
 *
 * Assistant messages never carry images: J4 does not send the owner pictures,
 * and an image block on an assistant turn is not a shape the API accepts here.
 */
export function toModelMessages(messages: StoredMessage[]): ModelMessage[] {
  let budget = MAX_IMAGES_PER_REQUEST;

  // Newest first, so when the cap bites it keeps the images the owner is
  // most likely to be talking about rather than the oldest ones.
  const attach = new Map<number, string[]>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (budget <= 0) break;
    if (messages.length - 1 - i >= IMAGE_RECENCY_WINDOW) break;
    const m = messages[i];
    if (m.role !== "user") continue;
    const urls = imageUrlsOf(m);
    if (urls.length === 0) continue;
    const taken = urls.slice(0, budget);
    budget -= taken.length;
    attach.set(i, taken);
  }

  return messages.map((m, i) => {
    const role: "user" | "assistant" = m.role === "user" ? "user" : "assistant";
    const urls = attach.get(i);
    if (!urls || urls.length === 0) return { role, content: m.content };

    // The image comes FIRST and the owner's words after it. Anthropic's own
    // guidance for a single image is that the model attends better when the
    // image precedes the question about it, and classify.ts already orders it
    // this way.
    const blocks: ModelContentBlock[] = urls.map((url) => ({
      type: "image" as const,
      source: { type: "url" as const, url },
    }));
    blocks.push({ type: "text", text: m.content });
    return { role, content: blocks };
  });
}

/** How many images a built request actually carries — for telemetry and tests. */
export function countImages(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "image") n += 1;
  }
  return n;
}
