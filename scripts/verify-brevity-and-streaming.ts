import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { STORE_CHAT_DATA_ANSWER_SYSTEM_PROMPT } from "../lib/dashboard/storeChatUnified";

// Verifies both real fixes together: (1) the data-answer call now stays
// short for a quick question, (2) it genuinely streams — each delta logged
// with its own arrival timestamp, so "all deltas within a few ms of each
// other" would expose fake/buffered streaming, while real spread-out
// timestamps confirm genuine incremental delivery. One-off, kept for record.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FAKE_BUSINESS_DATA = {
  businessProfile: {
    identity: { brandStory: "A small jewelry maker specializing in handmade rings.", targetAudience: "Gift shoppers, 25-45" },
    offerings: [],
    goals: [{ description: "Get the first three rings live on the store", status: "active" }],
    challenges: [],
  },
  recent: {},
  recentDecisions: [],
  activeThoughts: [],
  growthPointBalance: 12,
  growthPointCosts: {},
};

async function runCase(label: string, question: string) {
  const start = Date.now();
  let firstTokenAt: number | null = null;
  let fullReply = "";
  const deltaTimings: number[] = [];

  const stream = anthropic.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 1500,
    thinking: { type: "adaptive" },
    system: STORE_CHAT_DATA_ANSWER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Business data (JSON):\n${JSON.stringify(FAKE_BUSINESS_DATA, null, 2)}\n\nMerchant's question: ${question}` }],
  });

  stream.on("text", (delta) => {
    const t = Date.now() - start;
    if (firstTokenAt === null) firstTokenAt = t;
    deltaTimings.push(t);
    fullReply += delta;
  });

  await stream.finalMessage();
  const totalMs = Date.now() - start;

  console.log(`\n=== ${label} ===`);
  console.log(`question: "${question}"`);
  console.log(`TTFT: ${firstTokenAt}ms | total: ${totalMs}ms | delta count: ${deltaTimings.length} | reply length: ${fullReply.length} chars`);
  console.log(`delta arrival spread (ms from start), first 15: ${deltaTimings.slice(0, 15).join(", ")}`);
  console.log(`reply: ${fullReply}`);
}

async function main() {
  await runCase("Quick mode — the exact reported question", "What do we need to accomplish today?");
  await runCase("Deep mode — explicit request for detail", "I'm heading into a meeting — give me everything I should know about the business.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
