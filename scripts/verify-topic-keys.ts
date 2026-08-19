import { deriveTopicKey, planTopicKeyBackfill, type BackfillCandidate } from "@/lib/intelligence/topicKeys";
import { volunteeredByJ4 } from "@/lib/intelligence/proposalOrigin";
import { planRejectionBeliefs } from "@/lib/intelligence/learn";

// Business Intelligence Engine M2 — the regression suite.
//
// Every claim Sean required, proved against engineered inputs and runnable with
// no database and no environment:
//
//   npx tsx scripts/verify-topic-keys.ts
//
// These test the exact functions the real paths call — deriveTopicKey is what
// both the backfill and every new proposal use, volunteeredByJ4 is what both
// learn.ts and storefrontSuggestionGate.ts use, and planRejectionBeliefs is
// what distillBeliefs runs. A test against a reimplementation would prove
// nothing about either.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${e}\n        actual   ${a}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const day = (n: number) => new Date(Date.UTC(2026, 0, n));

// ---------------------------------------------------------------------------
console.log("\n1. Historical decisions receive the correct deterministic topic keys");

const historical: BackfillCandidate[] = [
  { id: "h1", actionType: "update_product", input: { productId: "p1", description: "new copy" }, topicKey: null },
  { id: "h2", actionType: "update_product", input: { productId: "p2", name: "New name" }, topicKey: null },
  { id: "h3", actionType: "update_product", input: { productId: "p3", name: "N", description: "D" }, topicKey: null },
  { id: "h4", actionType: "update_product_image", input: { productId: "p4", imageUrl: "u" }, topicKey: null },
  { id: "h5", actionType: "delete_product", input: { productId: "p5" }, topicKey: null },
  { id: "h6", actionType: "update_hero", input: { headline: "x" }, topicKey: null },
];

check("description-only update", deriveTopicKey("update_product", { productId: "p", description: "d" }), "product_description_rewrite");
check("name-only update", deriveTopicKey("update_product", { productId: "p", name: "n" }), "product_name_change");
check("name and description together", deriveTopicKey("update_product", { productId: "p", name: "n", description: "d" }), "product_content_rewrite");
check("image replacement", deriveTopicKey("update_product_image", null), "product_image_replacement");
check("product removal", deriveTopicKey("delete_product", { productId: "p" }), "product_removal");
check("storefront hero", deriveTopicKey("update_hero", { headline: "x" }), "storefront_hero");

check(
  "the backfill plan derives every one of them",
  planTopicKeyBackfill(historical).map((u) => u.topicKey),
  [
    "product_description_rewrite",
    "product_name_change",
    "product_content_rewrite",
    "product_image_replacement",
    "product_removal",
    "storefront_hero",
  ]
);

// Deterministic: the same row derives the same key every time, and key order
// within the input object must not matter.
check(
  "derivation is order-independent",
  deriveTopicKey("update_product", { description: "d", name: "n", productId: "p" }),
  deriveTopicKey("update_product", { productId: "p", name: "n", description: "d" })
);

// ---------------------------------------------------------------------------
console.log("\n2. Ambiguous historical decisions remain untouched");

const ambiguous: BackfillCandidate[] = [
  // No field was actually proposed — only the record id.
  { id: "a1", actionType: "update_product", input: { productId: "p" }, topicKey: null },
  // An action type nobody has mapped. A generated fallback would be a guess.
  { id: "a2", actionType: "some_future_action", input: { anything: true }, topicKey: null },
  // Bookkeeping, deliberately excluded — "the owner declined goal_status" is a
  // preference nobody ever expressed.
  { id: "a3", actionType: "update_goal_status", input: { goalId: "g", status: "done" }, topicKey: null },
  { id: "a4", actionType: "resolve_challenge", input: { challengeId: "c" }, topicKey: null },
  // Malformed input on an input-dependent action.
  { id: "a5", actionType: "update_product", input: null, topicKey: null },
];

check("no ambiguous row is derived", ambiguous.map((r) => deriveTopicKey(r.actionType, r.input)), [null, null, null, null, null]);
check("the backfill plan skips every ambiguous row", planTopicKeyBackfill(ambiguous), []);

// ---------------------------------------------------------------------------
console.log("\n3. Two declined J4 proposals of the same topic create the belief");

const twoJ4Declines = [
  { id: "r1", topicKey: "product_description_rewrite", decidedAt: day(5), cognitiveOutputId: "co1" },
  { id: "r2", topicKey: "product_description_rewrite", decidedAt: day(9), cognitiveOutputId: "co2" },
];
const beliefs = planRejectionBeliefs(twoJ4Declines, []);
check("one belief is planned", beliefs.length, 1);
check("about the right topic", beliefs[0]?.topicKey, "product_description_rewrite");
check("counting both declines", beliefs[0]?.supportingCount, 2);
check(
  "with the owner-facing claim",
  beliefs[0]?.claim,
  'The owner has declined proposals about "product_description_rewrite" 2 time(s); consider a different approach before proposing this again.'
);
check("citing both decisions as evidence", beliefs[0]?.evidenceRefs, ["r1", "r2"]);

// A single decline is not a pattern — the threshold is real.
check("one decline forms no belief", planRejectionBeliefs([twoJ4Declines[0]], []).length, 0);

// A later execution of the same topic is honest contradicting evidence.
const contradicted = planRejectionBeliefs(twoJ4Declines, [
  { id: "m1", topicKey: "product_description_rewrite", measuredAt: day(20) },
]);
check("a later approval contradicts rather than erases", contradicted[0]?.contradictingCount, 1);
assert("and the claim says so", contradicted[0]?.claim.includes("isn't consistent") === true);

// ---------------------------------------------------------------------------
console.log("\n4. Unrelated decisions do not contribute");

check(
  "two declines on different topics form nothing",
  planRejectionBeliefs(
    [
      { id: "u1", topicKey: "product_removal", decidedAt: day(2), cognitiveOutputId: "co1" },
      { id: "u2", topicKey: "storefront_hero", decidedAt: day(3), cognitiveOutputId: "co2" },
    ],
    []
  ),
  []
);

check(
  "an unrelated measurement is not counted as contradiction",
  planRejectionBeliefs(twoJ4Declines, [{ id: "m9", topicKey: "storefront_theme", measuredAt: day(20) }])[0]
    ?.contradictingCount,
  0
);

// ---------------------------------------------------------------------------
console.log("\n5. Only proposals J4 volunteered can teach a preference");

// Two declines of the same topic — but the owner asked for both. This is the
// case the backfill creates, and the reason the origin rule had to become
// explicit: before M2 these rows had no topicKey and could never have grouped.
check(
  "two owner-initiated declines form no belief",
  planRejectionBeliefs(
    [
      { id: "o1", topicKey: "product_description_rewrite", decidedAt: day(5), cognitiveOutputId: null },
      { id: "o2", topicKey: "product_description_rewrite", decidedAt: day(9), cognitiveOutputId: null },
    ],
    []
  ),
  []
);

check(
  "a mixed history counts only what J4 volunteered",
  planRejectionBeliefs(
    [
      { id: "m1", topicKey: "storefront_hero", decidedAt: day(1), cognitiveOutputId: null },
      { id: "m2", topicKey: "storefront_hero", decidedAt: day(2), cognitiveOutputId: "co1" },
      { id: "m3", topicKey: "storefront_hero", decidedAt: day(3), cognitiveOutputId: null },
    ],
    []
  ),
  []
);

// ...and the storefront gate applies the identical rule. This is the exact
// expression the gate runs: volunteeredByJ4(rejections)[0].
const humanRejections = [
  { decidedAt: day(4), cognitiveOutputId: null },
  { decidedAt: day(6), cognitiveOutputId: null },
];
assert(
  "a J4 suggestion is not suppressed by a human-originated decision on the same topic",
  volunteeredByJ4(humanRejections)[0] === undefined
);
assert(
  "but J4's own earlier rejection still suppresses it",
  volunteeredByJ4([{ decidedAt: day(4), cognitiveOutputId: "co1" }])[0] !== undefined
);

// ---------------------------------------------------------------------------
console.log("\n6. Future decisions use the exact same derivation");

// The literal expressions the conversational creation sites now pass
// (chat/route.ts and ai-actions.ts), compared against the same shapes arriving
// through the backfill. Identical inputs, identical function, identical key —
// which is what "historical and future decisions enter identically" means.
const futureUpdate = deriveTopicKey("update_product", { productId: "p1", description: "new copy" });
const historicalUpdate = planTopicKeyBackfill([
  { id: "h1", actionType: "update_product", input: { productId: "p1", description: "new copy" }, topicKey: null },
])[0].topicKey;
check("future and historical agree for update_product", futureUpdate, historicalUpdate);

check("future and historical agree for image replacement", deriveTopicKey("update_product_image", null), "product_image_replacement");
check("future and historical agree for create_product", deriveTopicKey("create_product", null), "new_product");

// The generic conversational path passes a validated input straight through.
check("the generic path derives from its own action type", deriveTopicKey("update_seo", { title: "t" }), "storefront_seo");

// ---------------------------------------------------------------------------
console.log("\n7. The backfill only ever adds a topic key");

const plan = planTopicKeyBackfill(historical);
assert(
  "every planned update carries exactly id and topicKey",
  plan.every((u) => JSON.stringify(Object.keys(u).sort()) === JSON.stringify(["id", "topicKey"])),
  `${plan.length} updates inspected`
);

// A row that already has a key is never rewritten — so a model-authored key
// survives, and re-running the backfill is a no-op.
check(
  "rows that already have a topic key are untouched",
  planTopicKeyBackfill([
    { id: "k1", actionType: "update_hero", input: {}, topicKey: "declining_repeat_purchases" },
  ]),
  []
);

check(
  "and running the plan twice produces the same updates",
  planTopicKeyBackfill(historical),
  planTopicKeyBackfill(historical)
);

// Nothing in the plan can reach a decision, a timestamp, an actor or an
// outcome: the candidate rows carry them, the updates cannot.
const carrying: BackfillCandidate & { status: string; decidedAt: Date } = {
  id: "s1",
  actionType: "delete_product",
  input: { productId: "p" },
  topicKey: null,
  status: "REJECTED",
  decidedAt: day(3),
};
check(
  "extra fields on the source row never reach the update",
  Object.keys(planTopicKeyBackfill([carrying])[0]).sort(),
  ["id", "topicKey"]
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
