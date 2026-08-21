import {
  rankMoves,
  evidenceStrength,
  marginImprovementPercent,
  concentration,
  deepenMove,
  candidateMove,
  unblockMove,
  type BusinessMove,
} from "@/lib/sourcing/moves";
import { currentMovePolicy } from "@/lib/sourcing/movePolicy";
import { currentPolicy } from "@/lib/sourcing/progressionPolicy";
import type { ProductEvidence } from "@/lib/sourcing/progression";
import type { Recommendation } from "@/lib/sourcing/recommend";
import type { Outcome } from "@/lib/sourcing/feasibility";

// Ranking the next business move. No database, no network:
//
//   npx tsx scripts/verify-moves.ts
//
// P0.5 units 9-10. The judgement that decides what J4 says first, checkable
// without a database, a server or a model.
//
// THE DECISION THIS FILE DEFENDS: deepening does not beat widening as a rule,
// and widening does not beat deepening. Both are scored from the evidence for a
// particular business and product, and whichever the evidence supports rises.
// Section 3 is that stated as a pair of opposite cases.

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

const MOVE = currentMovePolicy();
const POLICY = currentPolicy();

function evidence(over: Partial<ProductEvidence> = {}): ProductEvidence {
  return {
    productId: "p1", currency: "USD", unitsSold: 40, refundedUnits: 0, orderCount: 40,
    firstSoldAt: new Date(), windowDays: 56, unitsPerWeek: 5,
    netRevenueCents: 40 * 1_800, netMarginCents: 40 * 820, marginPerUnitCents: 820,
    returnRate: 0, ...over,
  };
}

const affordable: Outcome = { kind: "recommended_now", caveats: [], reasons: ["It's working."] };
const notYet = (weeks: number): Outcome => ({
  kind: "not_yet", reasons: ["It's working."], blockers: ["It needs money up front."],
  plan: `About ${weeks} weeks.`, capitalBasis: "assumed_because_unstated", caveats: [],
});

const fit = (score: number): Recommendation => ({
  verdict: "fits", score, reasons: ["It matches your business."], concerns: [], basedOn: ["own_words"],
});

const deepen = (over: Partial<Parameters<typeof deepenMove>[0]> = {}) =>
  deepenMove({
    productId: "prod", productName: "Foam roller", fromKind: "WHOLESALE_DROPSHIP",
    toKind: "WHOLESALE_STOCKED", evidence: evidence(), outcome: affordable,
    bulkUnitCostInCents: 410, upfrontCents: 41_000, paybackWeeks: 5,
    reconsideration: null, policy: POLICY, movePolicy: MOVE, ...over,
  });

const candidate = (over: Partial<Parameters<typeof candidateMove>[0]> = {}) =>
  candidateMove({
    sourcedProductId: "cand", name: "Resistance bands", kind: "WHOLESALE_DROPSHIP",
    fit: fit(20), outcome: affordable, movePolicy: MOVE,
    concentration: 1, provenNames: ["Foam roller"], hasProvenProduct: true, ...over,
  });

// ---------------------------------------------------------------------------
console.log("\n1. A move is an actionable decision, not a product listing");
{
  const move = deepen();
  assert("it says what to do", move.recommendation.length > 0, move.recommendation);
  assert("and why", move.why.length > 0, move.why.join(" | "));
  assert("on what evidence", move.evidence.length > 0, move.evidence.join(" | "));
  assert("what the owner would actually do", move.action.length > 0, move.action);
  // The field that makes it a progression rather than a suggestion.
  assert("and what it unlocks", move.unlocks.length > 0, move.unlocks);
  check("nothing is blocking an affordable one", move.blockers, []);

  const blocked = deepen({ outcome: notYet(5) });
  assert("a deferred move names what is in the way", blocked.blockers.length > 0, blocked.blockers.join(" | "));
  assert("and still says why it is worth doing", blocked.why.length > 0);
}

// ---------------------------------------------------------------------------
console.log("\n2. A business with nothing proven is starting, not widening");
{
  const first = candidate({ hasProvenProduct: false, concentration: 0, provenNames: [] });
  check("the same product is a START for a new business", first.kind, "start");
  assert("and says it costs nothing", first.evidence.some((e) => e.includes("nothing")), first.evidence.join(" | "));
  assert("promising first sales", first.unlocks.includes("first real sales"), first.unlocks);

  const later = candidate({ hasProvenProduct: true });
  check("and a WIDEN once something sells", later.kind, "widen");
  assert("naming what it sits beside", later.evidence.some((e) => e.includes("Foam roller")), later.evidence.join(" | "));
}

// ---------------------------------------------------------------------------
console.log("\n3. Evidence decides between deepening and widening — not a rule");
{
  // CASE A: a product working extremely well, with a big saving available. The
  // evidence says improve what you have.
  const strongDeepen = deepen({
    evidence: evidence({ unitsSold: 120, marginPerUnitCents: 820 }),
    bulkUnitCostInCents: 300,   // from 980 -> 300 is a large improvement
    paybackWeeks: 3,
  });
  const modestWiden = candidate({ fit: fit(8), concentration: 0.5 });
  const [topA] = rankMoves([strongDeepen, modestWiden], MOVE);
  check("a strongly proven product with a big saving leads", topA.kind, "deepen");

  // CASE B: same shape of business, but the saving is tiny and the complementary
  // product is an excellent fit. THE SAME CODE now prefers widening.
  const weakDeepen = deepen({
    evidence: evidence({ unitsSold: 22 }),
    bulkUnitCostInCents: 950,   // from 980 -> 950 is almost nothing
    paybackWeeks: 30,
  });
  const strongWiden = candidate({ fit: fit(28), concentration: 1 });
  const [topB] = rankMoves([weakDeepen, strongWiden], MOVE);
  check("a weak saving beside an obvious complement leads to widening", topB.kind, "widen");

  // THE POINT, stated: neither kind has a fixed rank. The same two kinds swap
  // places purely on evidence.
  assert("so neither kind is globally superior", topA.kind !== topB.kind, `${topA.kind} / ${topB.kind}`);
}

// ---------------------------------------------------------------------------
console.log("\n4. A narrow catalogue is what makes widening valuable");
{
  // One proven product and nothing else: an obvious complementary opportunity.
  check("one product, one proven", concentration(1, 1), 1);
  // Nothing proven: widening has no evidence behind it at all.
  check("nothing proven means no widening case", concentration(5, 0), 0);
  // A broad catalogue has already taken the opportunity.
  assert("a wide catalogue gains less", concentration(8, 2) < concentration(2, 1),
    `${concentration(8, 2)} vs ${concentration(2, 1)}`);

  const narrow = candidate({ concentration: 1 });
  const broad = candidate({ concentration: 0 });
  assert("so a narrow catalogue scores a widen higher", narrow.score > broad.score,
    `${narrow.score} vs ${broad.score}`);
}

// ---------------------------------------------------------------------------
console.log("\n5. Affordable beats aspirational, and aspirational is still shown");
{
  const now = deepen({ outcome: affordable });
  const later = deepen({ productId: "other", outcome: notYet(5) });
  const ranked = rankMoves([later, now], MOVE);
  check("the affordable one leads", ranked[0].outcome.kind, "recommended_now");
  // NEVER hidden. It is the most motivating thing in the system.
  check("and the deferred one is still offered", ranked.length, 2);
  assert("with what is in the way", ranked[1].blockers.length > 0);
}

// ---------------------------------------------------------------------------
console.log("\n6. An unblock leads only when it unlocks something materially better");
{
  const strongProduct = unblockMove({
    productId: "prod", sourcedProductId: null, subject: "Foam roller",
    missing: ["what the supplier charges in bulk"],
    question: "What would Foam roller cost you to buy in bulk?",
    blockedMoveStrength: 90,
    outcome: { kind: "cannot_assess", missing: ["bulk price"] },
    movePolicy: MOVE,
  });
  const modestAction = candidate({ fit: fit(10) });

  // A product selling hard whose economics are unknown: the question IS the
  // best move, because knowing would change everything about it.
  const [top] = rankMoves([modestAction, strongProduct], MOVE);
  check("a valuable unknown leads", top.kind, "unblock");
  assert("phrased as the question to ask", top.action.includes("cost you to buy in bulk"), top.action);

  // The same missing fact about something nobody buys is not worth asking about
  // before doing something real.
  const weakProduct = { ...strongProduct, score: 2 };
  const goodAction = candidate({ fit: fit(28), concentration: 1 });
  const ranked = rankMoves([weakProduct, goodAction], MOVE);
  check("an unimportant unknown does not lead", ranked[0].kind, "widen");
  // Still offered, never suppressed — it is simply not the first thing said.
  check("but it is still offered", ranked.length, 2);
  check("below the action", ranked[1].kind, "unblock");

  // And it must clear the best action by a real margin, not merely tie it.
  const tie = { ...strongProduct, score: goodAction.score };
  check("a tie does not promote a question over an action",
    rankMoves([tie, goodAction], MOVE)[0].kind, "widen");
}

// ---------------------------------------------------------------------------
console.log("\n7. Three moves, and never three about the same thing");
{
  const many: BusinessMove[] = [
    deepen({ productId: "a", productName: "A" }),
    candidate({ sourcedProductId: "b", name: "B", fit: fit(25) }),
    candidate({ sourcedProductId: "c", name: "C", fit: fit(22) }),
    candidate({ sourcedProductId: "d", name: "D", fit: fit(18) }),
    candidate({ sourcedProductId: "e", name: "E", fit: fit(15) }),
  ];
  const ranked = rankMoves(many, MOVE);
  check("exactly three", ranked.length, MOVE.moveCount);
  assert("in descending order", ranked.every((m, i) => i === 0 || ranked[i - 1].score >= m.score),
    ranked.map((m) => m.score).join(", "));

  // Three suggestions about one product is a catalogue of one thing, not three
  // choices.
  const duplicates: BusinessMove[] = [
    deepen({ productId: "same", productName: "Same" }),
    { ...deepen({ productId: "same", productName: "Same" }), recommendation: "Another way to say it" },
    candidate({ sourcedProductId: "other", name: "Other" }),
  ];
  const deduped = rankMoves(duplicates, MOVE);
  check("one move per subject", deduped.filter((m) => m.productId === "same").length, 1);
}

// ---------------------------------------------------------------------------
console.log("\n8. The same inputs always produce the same answer");
{
  const moves = [deepen(), candidate({ sourcedProductId: "x", name: "X" }), candidate({ sourcedProductId: "y", name: "Y", fit: fit(19) })];
  const first = rankMoves(moves, MOVE).map((m) => m.recommendation);
  for (let i = 0; i < 5; i++) {
    check(`run ${i + 1} is identical`, rankMoves([...moves].reverse(), MOVE).map((m) => m.recommendation), first);
  }
}

// ---------------------------------------------------------------------------
console.log("\n9. The arithmetic behind the ranking");
{
  // Evidence strength is relative to the bar, not an absolute count: twice the
  // threshold is what matters, not twenty units.
  check("at the bar, no strength beyond it", evidenceStrength(evidence({ unitsSold: 20 }), 1, POLICY), 0);
  assert("twice the bar is stronger",
    evidenceStrength(evidence({ unitsSold: 40 }), 1, POLICY) > 0);
  // Capped, so one runaway product cannot dominate every ranking forever.
  check("and it is capped", evidenceStrength(evidence({ unitsSold: 100_000 }), 1, POLICY), 3);

  // Margin improvement is the real driver of deepening.
  const improvement = marginImprovementPercent(evidence({ netRevenueCents: 40 * 1_800, marginPerUnitCents: 820, unitsSold: 40 }), 410);
  assert("a halved unit cost is a large improvement", improvement !== null && improvement > 50, String(improvement));
  // UNKNOWN COST MEANS NO NUMBER, never a zero that would quietly rank it last
  // as though the saving were nil.
  check("an unknown bulk price yields no improvement figure",
    marginImprovementPercent(evidence(), null), null);
  check("and an unknown margin likewise",
    marginImprovementPercent(evidence({ marginPerUnitCents: null }), 410), null);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
