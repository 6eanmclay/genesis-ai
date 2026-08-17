import Anthropic from "@anthropic-ai/sdk";
import { buildStoreChatUnifiedTools } from "@/lib/execution/genesisTools";
import { STORE_CHAT_UNIFIED_SYSTEM_PROMPT } from "@/lib/dashboard/storeChatUnified";
import { withJ4CopyRules } from "@/lib/j4CopyRules";

// Does J4 send the owner to the right place, and — just as importantly — does
// it stay put when it should?
//
// Sean's rule, which is the whole test: "Don't make every question trigger
// navigation. If I ask 'what makes a good hoodie design?' J4 should answer me.
// If I say 'okay, make me a hoodie', then J4 should take me to Studio and start
// the hoodie workflow."
//
// So the cases below deliberately pair near-identical wording across the
// information / creation / navigation line. A router that passes the action
// cases and fails the question cases is worse than no router, because it turns
// every conversation into a series of trips.
//
// Each case also runs from several starting screens, since "regardless of
// whether the user is currently in Storefront, Studio, Office, Commerce, or
// Account" is a requirement rather than an assumption.

const client = new Anthropic();

/** Expected tool, or null meaning "answer, do not route or act". */
type Expectation = string | null;

interface Case {
  phrase: string;
  expect: Expectation;
  why: string;
  /**
   * The screen this request is asking to reach. When the owner is ALREADY
   * there, answering is correct and routing would be pointless — nobody should
   * be navigated to the page they are looking at. Found by running the suite:
   * "where do I change my website" asked from Storefront was scored a failure
   * when it was the right call.
   */
  destinationScreen?: string;
}

const CASES: Case[] = [
  // Questions. J4 answers. No trip, no generation.
  { phrase: "What makes a good hoodie design?", expect: null, why: "a question about design, not a request" },
  { phrase: "What colours work best for merch?", expect: null, why: "advice, not action" },
  { phrase: "Why would I put my logo on a mug?", expect: null, why: "reasoning, not doing" },

  // Creation. J4 does the work; it does not send anyone anywhere.
  { phrase: "Okay, make me a hoodie.", expect: "create_design", why: "a decision to create" },
  { phrase: "Make me a logo.", expect: "generate_brand_logo", why: "J4 can do this itself" },
  { phrase: "Make a collage of my products.", expect: "create_composition", why: "J4 can do this itself" },

  // Navigation. The right answer is a place, because no tool does the work.
  { phrase: "How do I upload my logo?", expect: "take_me_there", why: "uploading is something only the owner can do" },
  { phrase: "Take me to my products.", expect: "take_me_there", why: "an explicit request to go somewhere", destinationScreen: "Commerce" },
  { phrase: "Where do I change my website?", expect: "take_me_there", why: "asking where, not asking for a change", destinationScreen: "Storefront" },
  { phrase: "I want to see my orders.", expect: "take_me_there", why: "a screen, not an action", destinationScreen: "Commerce" },
];

// Where the owner is when they ask. Included because routing must not depend on
// the room they happen to be standing in.
const SCREENS = ["Storefront", "Studio", "Office", "Commerce", "Account"];

async function classify(phrase: string, screen: string) {
  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 900,
    system: [{ type: "text", text: withJ4CopyRules(STORE_CHAT_UNIFIED_SYSTEM_PROMPT) }],
    messages: [
      { role: "user", content: `[The merchant is currently looking at ${screen}.] ${phrase}` },
    ],
    tools: buildStoreChatUnifiedTools(),
    tool_choice: { type: "auto" },
  });
  const used = res.content.find((b) => b.type === "tool_use");
  return used && used.type === "tool_use" ? used.name : null;
}

async function main() {
  let pass = 0;
  let total = 0;
  const failures: string[] = [];

  for (const testCase of CASES) {
    // Questions are checked from every screen, because a question turning into
    // a trip is the failure mode this exists to catch. Action cases are checked
    // from two, which is enough to show the room does not decide the outcome.
    const screens = testCase.expect === null ? SCREENS : SCREENS.slice(0, 2);
    for (const screen of screens) {
      total++;
      const got = await classify(testCase.phrase, screen);
      // Already there? Answering is right, and so is routing — both are
      // reasonable, so neither is scored a failure.
      const alreadyThere = testCase.destinationScreen === screen;
      const ok = got === testCase.expect || (alreadyThere && got === null);
      if (ok) pass++;
      else failures.push(`"${testCase.phrase}" from ${screen}: got ${got ?? "(answer)"}, expected ${testCase.expect ?? "(answer)"} — ${testCase.why}`);
      console.log(`${ok ? "PASS" : "FAIL"} [${screen}] "${testCase.phrase}" -> ${got ?? "(answer)"}`);
    }
  }

  console.log(`\n${pass}/${total} routed correctly`);
  if (failures.length > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

main();
