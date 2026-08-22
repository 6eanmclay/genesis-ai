import {
  buildBriefing,
  type FocusableApprovalBrief,
  type LiveObservationBrief,
  type CuriosityBrief,
} from "@/lib/dashboard/genesisBriefing";
import { deriveAssessmentState } from "@/lib/dashboard/genesisState";

// THE ONE SENTENCE J4 SAYS WHILE THE OWNER IS ARRIVING:
//
//   npx tsx scripts/verify-briefing.ts
//
// buildBriefing is the "what is Genesis currently focused on" line, and it had
// no coverage. It was extracted out of LiveIntelligence.tsx so desktop and
// mobile "render the identical real sentence from one source of truth, never
// two independently hand-copied merge/priority implementations" — which makes
// it exactly one thing to get right and two surfaces that inherit it.
//
// THE GROUNDING RULE IS THE RETURN TYPE. It returns null when nothing is
// pending, "letting the caller render its own calm idle line instead — never a
// fabricated 'nothing here' sentence." A briefing that always produced a
// sentence would produce one on a quiet morning too.
//
// AND IT IS COUNT-BASED ON PURPOSE, "rather than echoing the real proposal/
// observation text into this ambient surface — the full detail already lives on
// its real, appropriate review page." So the lead must never contain an item's
// own summary: this line is a pointer, and a pointer that quotes is a
// notification dashboard, which is the thing Home deliberately is not.

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

const SECRET = "ZZSUMMARYTEXT";

const approval = (id: string): FocusableApprovalBrief => ({
  id,
  section: "website",
  href: "/b/copper-and-coil/website",
  summary: `${SECRET} a proposal`,
  noticedSummary: null,
});
const observation = (dedupeKey: string, genesisState: string, actionHref: string | null = "/b/copper-and-coil/orders"): LiveObservationBrief => ({
  dedupeKey,
  genesisState,
  summary: `${SECRET} an observation`,
  actionHref,
});
const curiosity = (id: string): CuriosityBrief => ({ id, summary: `${SECRET} a curiosity` });

const brief = (over: Partial<Parameters<typeof buildBriefing>[0]> = {}) =>
  buildBriefing({ focusableApprovals: [], liveObservations: [], curiosityItems: [], ...over });

// ============================================================================
console.log("\n=== 1. A quiet morning gets no briefing at all ===\n");
// ============================================================================
check("nothing pending is null", brief(), null);
assert(
  "so Genesis never manufactures a sentence about an empty day",
  brief() === null,
  "the caller renders its own calm idle line; a fabricated 'nothing here' is the failure this avoids"
);

// ============================================================================
console.log("\n=== 2. The most urgent thing leads, whatever order it arrived in ===\n");
// ============================================================================
// Real priority, not list order, and it must match deriveAssessmentState's own
// ordering — the dot beside the sentence and the sentence itself would otherwise
// disagree about what matters.
const everything = {
  focusableApprovals: [approval("ap1")],
  liveObservations: [observation("opp", "opportunity"), observation("urg", "urgent")],
  curiosityItems: [curiosity("c1")],
};
const all = brief(everything);
assert("an urgent observation outranks everything", all?.lead.includes("attention") ?? false, String(all?.lead));
check("and the dot agrees", deriveAssessmentState({
  hasUrgentIssue: true, hasPendingDecision: true, hasOpportunity: true, hasCuriosity: true,
}), "urgent");

const noUrgent = brief({ ...everything, liveObservations: [observation("opp", "opportunity")] });
assert("a pending decision outranks an opportunity", noUrgent?.lead.includes("decision") ?? false, String(noUrgent?.lead));
check("and the dot agrees", deriveAssessmentState({
  hasUrgentIssue: false, hasPendingDecision: true, hasOpportunity: true, hasCuriosity: true,
}), "needs_decision");

const opportunityOnly = brief({ liveObservations: [observation("opp", "opportunity")], curiosityItems: [curiosity("c1")] });
assert("an opportunity outranks curiosity",
  opportunityOnly?.lead.includes("worth considering") ?? false, String(opportunityOnly?.lead));
check("and the dot agrees", deriveAssessmentState({
  hasUrgentIssue: false, hasPendingDecision: false, hasOpportunity: true, hasCuriosity: true,
}), "opportunity");

const curiosityOnly = brief({ curiosityItems: [curiosity("c1")] });
assert("curiosity leads only when it is all there is",
  curiosityOnly?.lead.includes("curious") ?? false, String(curiosityOnly?.lead));
check("and the dot agrees", deriveAssessmentState({
  hasUrgentIssue: false, hasPendingDecision: false, hasOpportunity: false, hasCuriosity: true,
}), "curiosity");

// Arrival order must not decide the lead.
const reversed = brief({
  focusableApprovals: [approval("ap1")],
  liveObservations: [observation("urg", "urgent")],
});
const forwards = brief({
  liveObservations: [observation("urg", "urgent")],
  focusableApprovals: [approval("ap1")],
});
check("the same set briefs the same way whichever order it is built in", reversed?.lead, forwards?.lead);

// ============================================================================
console.log("\n=== 3. The count is the whole day, and the words agree with it ===\n");
// ============================================================================
const one = brief({ focusableApprovals: [approval("ap1")] });
assert("one thing reads as one thing", one?.lead.includes("one thing") ?? false, String(one?.lead));
check("and the call to action is singular", one?.ctaLabel, "review it");

const three = brief({ focusableApprovals: [approval("a"), approval("b"), approval("c")] });
assert("three things say three", three?.lead.includes("3 things") ?? false, String(three?.lead));
check("and the call to action becomes a starting point", three?.ctaLabel, "start here");

// The count spans every kind, not just the leading one — an owner with one
// urgent issue and four opportunities has five things today.
const mixed = brief({
  liveObservations: [observation("urg", "urgent"), observation("o1", "opportunity"), observation("o2", "opportunity")],
  curiosityItems: [curiosity("c1")],
});
assert("the count includes everything, not only the leading kind",
  mixed?.lead.includes("4 things") ?? false, String(mixed?.lead));
assert("while the lead still describes the most urgent one",
  mixed?.lead.includes("attention") ?? false, String(mixed?.lead));

// Singular curiosity says "something" rather than "one thing", and takes its
// own softer call to action.
const oneCuriosity = brief({ curiosityItems: [curiosity("c1")] });
assert("a single curiosity is 'something'", oneCuriosity?.lead.includes("something") ?? false, String(oneCuriosity?.lead));
check("with a softer invitation", oneCuriosity?.ctaLabel, "take a look");

// ============================================================================
console.log("\n=== 4. A pointer, never a quotation ===\n");
// ============================================================================
// Count-based on purpose. The real text lives on the review page this links to,
// and echoing it here would turn an ambient line into a notification feed.
for (const [name, b] of [
  ["an approval", one],
  ["a mixed day", mixed],
  ["a curiosity", oneCuriosity],
] as const) {
  assert(`${name}'s lead quotes no item text`, !b?.lead.includes(SECRET), String(b?.lead));
  assert(`${name}'s call to action quotes none either`, !b?.ctaLabel.includes(SECRET), String(b?.ctaLabel));
}

// ============================================================================
console.log("\n=== 5. A link only exists when there is somewhere to go ===\n");
// ============================================================================
check("an approval links to itself, focused", one?.ctaHref, "/b/copper-and-coil/website?focus=ap1");
assert("carrying the business it belongs to",
  one?.ctaHref?.startsWith("/b/copper-and-coil/") ?? false,
  String(one?.ctaHref));

// Curiosity carries no href by design — "explanation-kind outputs carry no
// actionHref (nothing to route to), so this renders as plain text, never a
// fabricated link."
check("a curiosity has no link", oneCuriosity?.ctaHref, null);
assert("rather than a link to nowhere in particular",
  oneCuriosity?.ctaHref !== "/dashboard" && oneCuriosity?.ctaHref !== "",
  "a fabricated link is worse than plain text");

// An observation with no actionHref is the same honest absence.
const hrefless = brief({ liveObservations: [observation("o", "urgent", null)] });
check("an observation with nowhere to go has no link", hrefless?.ctaHref, null);
assert("but still says what it is about", (hrefless?.lead.length ?? 0) > 0, String(hrefless?.lead));

console.log(`\n${failures === 0 ? "All briefing assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
