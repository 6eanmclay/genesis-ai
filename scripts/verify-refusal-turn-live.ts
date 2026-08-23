import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { buildStoreChatUnifiedTools, allToolUses } from "@/lib/execution/genesisTools";
import { STORE_CHAT_UNIFIED_SYSTEM_PROMPT } from "@/lib/dashboard/storeChatUnified";
import { withJ4CopyRules } from "@/lib/j4CopyRules";
import { planToolRun, droppedNoticeFor, policyRefusedEverything } from "@/lib/execution/toolPolicy";

// IS THE REFUSAL REACHABLE FROM A REAL MODEL CHOICE?
//
//   npx tsx scripts/verify-refusal-turn-live.ts
//
// WHY THIS IS SEPARATE FROM verify-tool-policy.ts. That suite now proves the
// whole chain downstream of a choice: given a plan that drops the only tool,
// the owner hears the sentence. It proves it deterministically, and it proves
// it about a plan the SUITE constructs.
//
// It cannot tell you whether a real model ever produces that plan. If J4 never
// reaches for show_upload_options on a removal phrase, removal_not_upload never
// fires in production and the sentence is correct, tested, and dead. A rule
// nothing triggers is not a working rule.
//
// So this measures the one link a deterministic suite cannot: model choice, fed
// straight into the real policy call, with the real notice printed. Model choice
// and turn outcome are different measurements and are labelled as such below.
//
// COST: two calls.

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.log("\nSKIPPED: ANTHROPIC_API_KEY is not set. Nothing was measured.\n");
  process.exit(0);
}

// BOTH ORDERINGS, because the rule keys off the message and the model keys off
// emphasis. The first is the fixture case from verify-j4-routing.ts, where the
// removal leads. The second puts the upload first, which is the phrasing most
// likely to actually produce show_upload_options — and therefore the phrasing
// most likely to reach the rule.
const CASES = [
  { name: "removal leads", phrase: "Remove the old products and let's upload the first ring." },
  { name: "upload leads", phrase: "I want to upload photos of the first ring — and get rid of the old products." },
];

async function main() {
  const client = new Anthropic({ apiKey: key });
  let calls = 0;
  let reached = 0;

  for (const testCase of CASES) {
    const res = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 900,
      system: [{ type: "text", text: withJ4CopyRules(STORE_CHAT_UNIFIED_SYSTEM_PROMPT) }],
      messages: [
        {
          role: "user",
          content: `Screen: Products\nBusiness: Copper & Coil — hand-wound copper rings, made to order.\n\nMerchant: ${testCase.phrase}`,
        },
      ],
      tools: buildStoreChatUnifiedTools(),
      tool_choice: { type: "auto" },
    });
    calls++;

    // MODEL CHOICE — what J4 asked to do.
    const requested = allToolUses(res.content).map((t) => t.name);

    // TURN OUTCOME — what the product does with that, through the real policy
    // call the two callers make.
    const plan = planToolRun(requested, testCase.phrase);
    const notice = droppedNoticeFor(plan);
    const refusedAll = policyRefusedEverything(plan);

    console.log(`\n--- ${testCase.name} ---`);
    console.log(`  phrase        "${testCase.phrase}"`);
    console.log(`  model chose   ${requested.length > 0 ? requested.join(", ") : "(no tool — answered conversationally)"}`);
    console.log(`  policy runs   ${plan.run.length > 0 ? plan.run.join(", ") : "(nothing)"}`);
    console.log(`  policy drops  ${plan.dropped.length > 0 ? plan.dropped.map((d) => `${d.name} (${d.why})`).join(", ") : "(nothing)"}`);
    console.log(`  refused all   ${refusedAll}`);
    console.log(`  owner hears   ${notice ? `"${notice}"` : "(nothing about a refusal)"}`);

    if (plan.dropped.some((d) => d.why === "removal_not_upload")) reached++;
  }

  console.log(`\nCalls made: ${calls}`);
  console.log(
    reached > 0
      ? `\nREACHABLE. ${reached} of ${CASES.length} produced removal_not_upload from a real model choice,\nand the owner is told.`
      : `\nNOT REACHED in either case. The rule and its sentence are correct and\ndeterministically tested, but no real choice here triggered them — so nothing\nhere is evidence that an owner has ever seen that sentence. Treat the rule as\nunexercised in production rather than as working.`
  );
  // Not an exit failure: "the model did not pick that tool" is a measurement,
  // not a broken assertion. Reporting it as red would make an honest finding
  // look like a regression.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
