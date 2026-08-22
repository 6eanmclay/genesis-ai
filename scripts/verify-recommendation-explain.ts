import { getRecommendationExplanation } from "@/lib/dashboard/explainRecommendation";
import { RECOMMENDATION_MESSAGES } from "@/lib/dashboard/recommendations";
import { businessBasePath, sectionHref, LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { resolveWorkspaceContext } from "@/lib/j4/workspaceContext";

// THE TWO GUARDS IN FRONT OF AN EXPLANATION, AND WHERE A RECOMMENDATION SENDS
// THE OWNER:
//
//   npx tsx scripts/verify-recommendation-explain.ts
//
// EXTERNALLY BLOCKED, and recorded rather than faked: the explanation itself is
// a real Claude call, and there is no ANTHROPIC_API_KEY in this environment. No
// mock stands in for it — a mocked model call would assert that the mock works.
//
// What IS reachable is everything before the network, and both guards throw
// before a single token is spent:
//
//   * An unknown recommendation id throws rather than explaining nothing. The
//     ids are a closed set, and Genesis-authored recommendations carry real DB
//     cuids that are deliberately absent from it — RecommendationItem only
//     offers the explain pill for source: "rules" for exactly that reason.
//   * A missing storeId throws rather than silently skipping cost governance.
//     Its own comment: this "fails loudly rather than silently skipping cost
//     governance for a call that, in practice, is never actually missing it."
//     A model call billed to nobody is the failure that hides forever.
//
// The second half of this file is a routing property found while covering the
// first: every recommendation's actionHref is authored as "/dashboard/...", and
// RecommendationItem rendered it raw. Same defect as ACTION_SECTIONS' review
// links, in a surface verify-business-browser's assertion did not reach —
// recommendations render on Analytics and Home, not on the page it checked.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/** What this call threw, or null if it did not throw. */
async function threw(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main() {
  // ==========================================================================
  console.log("\n=== 1. An id nobody recognises is refused, not improvised ===\n");
  // ==========================================================================
  const unknown = await threw(() =>
    getRecommendationExplanation({ recommendationId: "recommend.not_a_real_one", storeId: "s1", storeName: "Copper & Coil" })
  );
  assert("an unknown recommendation id throws", unknown !== null, String(unknown));
  assert("and says which one", (unknown ?? "").includes("recommend.not_a_real_one"), String(unknown));

  // A Genesis-authored recommendation carries a real DB cuid, never one of
  // these keys. RecommendationItem only offers the explain pill for
  // source: "rules" precisely because this lookup would throw otherwise — so
  // the throw is load-bearing rather than defensive.
  const cuid = await threw(() =>
    getRecommendationExplanation({ recommendationId: "clx8h2k9p0000abcd1234efgh", storeId: "s1", storeName: "X" })
  );
  assert("a Genesis recommendation's own cuid throws too", cuid !== null,
    "which is why only rule-based recommendations get an explain pill");

  const empty = await threw(() =>
    getRecommendationExplanation({ recommendationId: "", storeId: "s1", storeName: "X" })
  );
  assert("an empty id throws", empty !== null);
  // OBJECT PROTOTYPE KEYS, and this is the assertion that found a real defect.
  //
  // RECOMMENDATION_MESSAGES is a plain Record, so a bare lookup resolved
  // "constructor" and friends to inherited FUNCTIONS. They passed the falsy
  // check and reached the model call — a real request, really billed, carrying
  // "function Object() { [native code] }" into the prompt as the merchant's
  // recommendation. The first run of this file proved it: each of those ids
  // produced a genesis-ai-error from the Anthropic client rather than the
  // registry's own refusal.
  //
  // So "it threw" is not a sufficient assertion — the network throws too, and
  // for the wrong reason. The message has to be the registry's own.
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    const inherited = await threw(() =>
      getRecommendationExplanation({ recommendationId: key, storeId: "s1", storeName: "X" })
    );
    assert(`"${key}" is refused by the registry, before any model call`,
      (inherited ?? "").startsWith("Unknown recommendation id:"),
      String(inherited));
  }

  // ==========================================================================
  console.log("\n=== 2. No explanation is billed to nobody ===\n");
  // ==========================================================================
  // The storeId guard runs AFTER the id lookup, so this needs a real id to
  // reach it — which is the ordering worth pinning: an unknown id must never
  // consume a model call either.
  const realId = Object.keys(RECOMMENDATION_MESSAGES)[0];
  assert("there is at least one real recommendation to test with", Boolean(realId), String(realId));

  const noStore = await threw(() =>
    getRecommendationExplanation({ recommendationId: realId, storeName: "Copper & Coil" })
  );
  assert("a call with no storeId throws", noStore !== null, String(noStore));
  assert("and says it is about usage accounting",
    (noStore ?? "").includes("usage accounting"), String(noStore));
  assert(
    "so a model call is never made without a store to attribute its cost to",
    noStore !== null,
    "a call billed to nobody is the failure that hides forever"
  );

  // ==========================================================================
  console.log("\n=== 3. Every recommendation actually says something ===\n");
  // ==========================================================================
  const ids = Object.keys(RECOMMENDATION_MESSAGES);
  assert("there are real recommendations", ids.length > 0);
  const blank = ids.filter((id) => !RECOMMENDATION_MESSAGES[id]?.trim());
  check("none is empty", blank, []);
  const unprefixed = ids.filter((id) => !id.startsWith("recommend."));
  check("every id is namespaced", unprefixed, []);
  // The explanation prompt is told not to restate the recommendation, which is
  // only meaningful if the recommendation is a real sentence to begin with.
  const tooShort = ids.filter((id) => RECOMMENDATION_MESSAGES[id].length < 20);
  check("and every message is a real sentence", tooShort, []);

  // ==========================================================================
  console.log("\n=== 4. A recommendation never sends the owner to another business ===\n");
  // ==========================================================================
  // Found while covering the above. Every actionHref is authored as the legacy
  // "/dashboard/..." spelling, and that route resolves the ACCOUNT'S ACTIVE
  // business — so following a recommendation from inside /b/<slug>/... could
  // land the owner on a different business's screen entirely.
  const BASE = businessBasePath("copper-and-coil");
  // The rule-based producer only. The Genesis producer reads the database, and
  // a suite that reached for one would be testing the fixture.
  const { ruleBasedProducer } = await import("@/lib/dashboard/recommendations");
  const produced = (await ruleBasedProducer.produce({
    storeId: "s1",
    storeName: "Copper & Coil",
    store: { published: false },
    products: [],
    stripeIntegration: null,
    attentionItems: [],
    orderSummary: null,
    customerSummaries: [],
    inventorySnapshot: null,
    recentActivity: [],
  } as never)).filter((r) => r.actionHref);

  assert("the rule-based producer returned something to check", produced.length > 0,
    `${produced.length} recommendations`);
  // The ones an empty business would actually see, which is not what I first
  // assumed: an unpublished store with no products is told to add a product and
  // connect Stripe, NOT to publish. That ordering is right and worth pinning —
  // telling somebody to publish an empty storefront would be advice that makes
  // their business worse.
  check("an empty business is told to stock it, not to publish it",
    produced.map((r) => r.id).sort(),
    ["recommend.add_first_product", "recommend.connect_stripe"]);
  assert("and is never told to publish nothing",
    !produced.some((r) => r.id === "recommend.publish_store"),
    JSON.stringify(produced.map((r) => r.id)));

  const escaping = produced
    .map((r) => sectionHref(r.actionHref, BASE))
    .filter((href) => !href.startsWith(BASE));
  check("every recommendation's link stays in this business", escaping, []);

  // The legacy base is still the identity, so nothing moved for an account on
  // /dashboard.
  check("while the legacy route is unchanged",
    produced.map((r) => sectionHref(r.actionHref, LEGACY_BUSINESS_BASE)),
    produced.map((r) => r.actionHref));

  // Every destination is a real place J4 also recognises — closing the loop with
  // the workspace registry rather than trusting the href by eye.
  const unrecognised = produced
    .map((r) => r.actionHref)
    .filter((href) => resolveWorkspaceContext(href) === null);
  check("and every destination is a screen J4 knows", [...new Set(unrecognised)], []);


  console.log(`\n${failures === 0 ? "All recommendation-explain assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
