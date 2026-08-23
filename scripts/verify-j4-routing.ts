import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { buildStoreChatUnifiedTools } from "@/lib/execution/genesisTools";
import { STORE_CHAT_UNIFIED_SYSTEM_PROMPT } from "@/lib/dashboard/storeChatUnified";
import { withJ4CopyRules } from "@/lib/j4CopyRules";
import { renderDigest, type UnderstandingDigest } from "@/lib/businessModel/digest";
import { TOOL_POLICY } from "@/lib/execution/toolPolicy";

// Does J4 reach for the right thing — and does it stay put when it should?
//
//   npx tsx scripts/verify-j4-routing.ts
//
// Sean's rule, which is the whole test: "Don't make every question trigger
// navigation. If I ask 'what makes a good hoodie design?' J4 should answer me.
// If I say 'okay, make me a hoodie', then J4 should take me to Studio and start
// the hoodie workflow."
//
// TWO HALVES, AND ONLY ONE OF THEM NEEDS A KEY (2026-08-22, Unified
// Intelligence UI5).
//
// The deterministic half runs anywhere, always, in under a second: every case
// names a tool that really exists, every case has a policy, the prompt actually
// explains the context it is given, and every fixture renders. That half is the
// regression gate — it catches a renamed tool, a case pointing at nothing, and a
// prompt that stopped describing its own input, none of which need a model to
// detect and all of which would otherwise be found by a merchant.
//
// The live half needs ANTHROPIC_API_KEY and answers the question the design
// document raised and declined to settle: does a model choosing among nineteen
// tools make more real mistakes than a narrow classifier? It is skipped, loudly,
// when there is no key — never silently passed.
//
// AND IT NOW SENDS WHAT THE PRODUCT SENDS. This suite used to classify with the
// system prompt and tools alone, which stopped being what the route does the
// moment the understanding digest landed. An eval measuring a stripped-down
// version of the real decision is measuring nothing useful.

const results: { name: string; ok: boolean }[] = [];
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}
function assert(name: string, ok: boolean, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Expected tool, or null meaning "answer, do not route or act". */
type Expectation = string | null;

/** A believable business, built without a database so this stays fast. */
function digest(over: Partial<UnderstandingDigest> = {}): UnderstandingDigest {
  return {
    name: "Copper & Coil",
    tagline: "Hand-wound rings",
    categories: ["Handmade goods"],
    activeProductCount: 3,
    productNames: ["Tensor Ring", "Copper Cuff", "Coil Pendant"],
    assetRolesHeld: [],
    goals: [],
    challenges: [],
    blocked: [],
    connectedSystems: [],
    beliefs: [],
    commitments: [],
    sourcing: { withRecordedSource: 0, withoutRecordedSource: 0 },
    oldestOwnerStatement: null,
    ...over,
  };
}

interface Case {
  /** Stable name, so an assertion can identify a case rather than search for the property it is meant to have. */
  id?: string;
  phrase: string;
  expect: Expectation;
  why: string;
  /**
   * The screen this request is asking to reach. When the owner is ALREADY
   * there, answering is correct and routing would be pointless — nobody should
   * be navigated to the page they are looking at.
   */
  destinationScreen?: string;
  /** What J4 knows while being asked. Defaults to a plain business. */
  context?: UnderstandingDigest;
  /**
   * Set when the RIGHT ANSWER DEPENDS ON THE CONTEXT — these are the cases the
   * live half runs twice, with and without the digest, to measure whether
   * giving J4 the business before it decides actually changes what it does.
   */
  contextSensitive?: true;
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

  // Files. Was a whole separate model round trip on every message until
  // 2026-08-22; now an ordinary tool, which is what these cases check.
  { phrase: "I have some photos I want to give you.", expect: "show_upload_options", why: "offering files, and nothing else" },
  {
    phrase: "Remove the old products and let's upload the first ring.",
    expect: "request_product_removal",
    why: "uploading is mentioned but the real instruction is a removal — answering this as an upload message silently drops it",
  },
  { phrase: "The photo on my homepage looks bad.", expect: null, why: "about existing content, not an offer of a file" },

  // ---- CONTEXT-SENSITIVE. These are why the digest exists. ----------------
  {
    id: "logo-already-held",
    phrase: "Make me a logo.",
    expect: null,
    why: "they already have one — offering another is the behaviour the removed prompt workaround tried to prevent without giving the model any way to know",
    context: digest({ assetRolesHeld: ["brand.logo"] }),
    contextSensitive: true,
  },
  {
    phrase: "What's holding up the second workshop?",
    expect: null,
    why: "the answer is already in the context; reaching for a lookup to restate it is a wasted round trip",
    context: digest({
      goals: ["Open a second workshop"],
      challenges: ["The lease on the current unit ends in December"],
      blocked: ["Open a second workshop — held up by The lease on the current unit ends in December"],
    }),
    contextSensitive: true,
  },
  {
    phrase: "How much did I make last month?",
    expect: "look_up_business_data",
    why: "a real figure is not in the summary, and must never be invented from it",
    context: digest({ activeProductCount: 12 }),
    contextSensitive: true,
  },
];

// Where the owner is when they ask. Included because routing must not depend on
// the room they happen to be standing in.
const SCREENS = ["Storefront", "Studio", "Office", "Commerce", "Account"];

function userTurn(phrase: string, screen: string, context: UnderstandingDigest | null): string {
  // Shaped the way lib/dashboard/chatTurnContext.ts shapes it, so this measures
  // the real decision rather than a convenient approximation.
  const parts = [phrase, `(Active products: ${(context ?? digest()).productNames.join(", ")})`];
  if (context) parts.push(renderDigest(context));
  parts.push(`(The merchant is currently looking at ${screen}.)`);
  return parts.join("\n");
}

async function classify(
  client: Anthropic,
  phrase: string,
  screen: string,
  context: UnderstandingDigest | null
): Promise<string | null> {
  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 900,
    system: [{ type: "text", text: withJ4CopyRules(STORE_CHAT_UNIFIED_SYSTEM_PROMPT) }],
    messages: [{ role: "user", content: userTurn(phrase, screen, context) }],
    tools: buildStoreChatUnifiedTools(),
    tool_choice: { type: "auto" },
  });
  const used = res.content.find((b) => b.type === "tool_use");
  return used && used.type === "tool_use" ? used.name : null;
}

async function main() {
  // ==========================================================================
  console.log("\n=== The gate: true without a model, and checked every run ===\n");
  // ==========================================================================
  const catalog = buildStoreChatUnifiedTools().map((t) => t.name);

  // A case expecting a tool that no longer exists passes forever by accident if
  // the live half never runs, and fails mysteriously if it does.
  const unknownExpectations = [...new Set(CASES.map((c) => c.expect))]
    .filter((e): e is string => e !== null)
    .filter((e) => !catalog.includes(e));
  check("every case expects a tool that really exists", unknownExpectations, []);
  check("and every expected tool has a policy",
    [...new Set(CASES.map((c) => c.expect))]
      .filter((e): e is string => e !== null)
      .filter((e) => !Object.hasOwn(TOOL_POLICY, e)),
    []);

  assert("every case says why it is the right answer",
    CASES.every((c) => c.why.length > 10), "a case nobody can explain is a case nobody can fix");
  assert("the suite covers answering as well as acting",
    CASES.some((c) => c.expect === null) && CASES.some((c) => c.expect !== null),
    "a router that passes only the action cases turns every conversation into a series of trips");

  // THE CONTEXT-SENSITIVE CASES ARE THE POINT. Without them this measures a
  // decision the product no longer makes.
  const sensitive = CASES.filter((c) => c.contextSensitive);
  assert("there are cases whose right answer depends on the business",
    sensitive.length >= 3, `${sensitive.length} of ${CASES.length}`);
  assert("and every one of them carries a business to depend on",
    sensitive.every((c) => c.context !== undefined));

  // The prompt has to actually describe the input it is now given.
  assert("the prompt tells the model to decide with the summary",
    STORE_CHAT_UNIFIED_SYSTEM_PROMPT.includes("USE IT WHEN DECIDING"));
  assert("and never to invent a figure from it",
    STORE_CHAT_UNIFIED_SYSTEM_PROMPT.includes("never quote a figure this summary did not give you"));

  // Every fixture renders to something a model could actually read.
  for (const c of sensitive) {
    const rendered = renderDigest(c.context!);
    assert(`the fixture for "${c.phrase.slice(0, 40)}" renders`,
      rendered.includes("What you know about this business") && rendered.length > 60);
  }
  // THE LOGO CASE IS THE ONE THIS MILESTONE TURNS ON, so it is identified by
  // name rather than searched for by the property it is supposed to have. A
  // negative control found the search version silently vacuous: remove the
  // property and find() returns undefined, so the assertion tested nothing and
  // then crashed on it — the shape of a check that can only ever pass.
  const logoCase = CASES.find((c) => c.id === "logo-already-held");
  assert("the already-has-a-logo case still exists", logoCase !== undefined);
  assert("and its context actually says a logo is held",
    logoCase?.context !== undefined && renderDigest(logoCase.context).includes("brand.logo"),
    logoCase?.context ? renderDigest(logoCase.context).slice(0, 120) : "no context");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `Gate: ALL PASS (${results.length})` : `Gate: ${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) {
    console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
    process.exit(1);
  }

  // ==========================================================================
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      "\n=== Live routing: SKIPPED ===\n\n" +
        "ANTHROPIC_API_KEY is not set, so the half of this suite that measures whether J4\n" +
        "actually reaches for the right tool did not run. That question — does a model\n" +
        "choosing among " + catalog.length + " tools make more real mistakes than a narrow classifier —\n" +
        "is the one J4_UNIFIED_INTELLIGENCE.md raised and declined to settle, and it cannot\n" +
        "be answered without a model. Set the key and re-run.\n\n" +
        "Skipped, not passed: nothing above was verified about routing quality."
    );
    // Exit 0 deliberately. The gate passed, and treating an absent key as a
    // failure would make the deterministic half unrunnable in the one place it
    // is most useful — every ordinary local run.
    process.exit(0);
  }

  console.log("\n=== Live routing, against a real model ===\n");
  const client = new Anthropic();
  let pass = 0;
  let total = 0;
  const failures: string[] = [];
  /** Cases where the digest changed the answer, in either direction. */
  const contextEffects: string[] = [];

  for (const testCase of CASES) {
    const screens = testCase.expect === null ? SCREENS : SCREENS.slice(0, 2);
    for (const screen of screens) {
      total++;
      const context = testCase.context ?? digest();
      const got = await classify(client, testCase.phrase, screen, context);
      const alreadyThere = testCase.destinationScreen === screen;
      const ok = got === testCase.expect || (alreadyThere && got === null);
      if (ok) pass++;
      else failures.push(`"${testCase.phrase}" from ${screen}: got ${got ?? "(answer)"}, expected ${testCase.expect ?? "(answer)"} — ${testCase.why}`);
      console.log(`${ok ? "PASS" : "FAIL"} [${screen}] "${testCase.phrase}" -> ${got ?? "(answer)"}`);

      // THE COMPARISON. Same phrase, same screen, no business summary — which is
      // exactly what the deciding call received before this milestone. Run only
      // for the cases whose right answer depends on it, because running it
      // everywhere would double the cost to learn nothing.
      if (testCase.contextSensitive) {
        const blind = await classify(client, testCase.phrase, screen, null);
        if (blind !== got) {
          contextEffects.push(
            `"${testCase.phrase}" [${screen}]: blind -> ${blind ?? "(answer)"}, with context -> ${got ?? "(answer)"} (expected ${testCase.expect ?? "(answer)"})`
          );
        }
      }
    }
  }

  console.log(`\n${pass}/${total} routed correctly`);
  if (contextEffects.length > 0) {
    console.log("\nWHERE THE BUSINESS SUMMARY CHANGED THE DECISION:");
    for (const e of contextEffects) console.log(`  ${e}`);
  } else {
    console.log("\nThe business summary changed no decision in this run — worth knowing, and not automatically good news.");
  }
  if (failures.length > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

main();
