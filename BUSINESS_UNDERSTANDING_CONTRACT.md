# One Canonical Understanding — contract

**Status: PROPOSED. Nothing implemented.** 2026-08-24. No API credit, no live
model, no production code, schema or behaviour changed.

Evidence: `UNDERSTANDING_REASSESSMENT.md` plus a full consumer census taken for
this contract. **The goal is not cleaner code.** It is one source of truth for
what J4 knows, so the conversation layer, the proactive layer, tools, teaching,
challenges, beliefs and the BI engine reason from the same understanding.

---

## 1. What the census found

Every caller that touches business facts, classified by what it does:

| Role | Count | Examples |
|---|---|---|
| **Providers** — compute a fact from the database | ~12 | `getRevenue`, `getCustomerSegments`, `computeInsights`, `getObligations`, `currentFacts` |
| **The canonical assembler** | 1 | `getBusinessUnderstanding` → `getBusinessProfile` |
| **A second assembler** | 1 | `buildChatDataContext` (`reasoning.ts:1193`) |
| **Consumers using canon only** | 8 | `chatTurnContext`, `proposeBrandLogo`, `productContentGeneration`, `J4Surface`, … |
| **Consumers using canon AND their own reads** | 3 | `cognitiveLayer`, `integrations/gaps`, `understanding/page.tsx` |
| **Consumers reading providers directly** | 8 | `genesisBriefingComposer`, `insights`, `customers/page`, `studio/page`, … |

### The measured duplication

Nine facts are computed at more than one independent call site:

| Fact | sites | where |
|---|---|---|
| `getRevenue` | **4** | profile, `buildChatDataContext`, `genesisBriefingComposer`, `insights` |
| `getCustomerSegments` | 3 | profile, `buildChatDataContext`, `customers/page` |
| `getItemPerformance` | 3 | profile, `buildChatDataContext`, `profitability` |
| `getTopContacts` | 2 | profile, `buildChatDataContext` |
| `getCustomerSegmentTrend` | 2 | profile, `customers/page` |
| `currentAssetsByRole` | 2 | understanding, `studio/page` |
| `getInvoiceSummary` | 2 | `buildChatDataContext`, `cognitiveLayer` |
| `getAppointmentSummary` | 2 | `buildChatDataContext`, `cognitiveLayer` |
| `getCampaignPerformanceSummary` | 2 | `buildChatDataContext`, `cognitiveLayer` |

**In one `look_up_business_data` turn**, `getRevenue` and `getTopContacts` are
computed twice — by `getBusinessProfile` (already in `ctx.understanding`) and
again by `buildChatDataContext` — and both results are sent to the model in the
same payload.

`toolHandlers.ts:2015` already refuses to re-query the understanding because
*"own understanding query is how a second source of truth begins."* The payload
built four lines later does exactly that for revenue.

### The correction the census forced

My reassessment framed this as "reasoning consumers vs presentation consumers".
**The census shows that line is wrong.** `insights.ts` reads `getRevenue`
directly and is neither: it is a **provider of derived facts** — the Insight
Engine, deterministic, feeding the proactive layer. Forbidding it from reading
revenue would be forbidding it from doing its job.

So the architecture has **three roles, not two**, and the rule below is about
consumers only.

---

## 2. U1 — What exactly is the canonical model?

**Evidence.** `getBusinessUnderstanding` already assembles ~27 parallel queries
(19 in the profile, 8 more in the understanding) and returns identity,
classification, offerings, revenue, customers, people, suppliers, connected
systems, goals, challenges, assets, beliefs, recent decisions, commitments,
blocked goals, active thoughts, owner understanding, platform relationship.

Two things sit outside it that consumers add back: the **connected-system
summaries** (invoice, campaign, appointment) and **upcoming appointments**. Both
are added independently by `buildChatDataContext` and `cognitiveLayer`.

**Options**

| | Consequence |
|---|---|
| **Canonical = everything a consumer needs to REASON about the business** | The three summaries move in; a new consumer inherits them. One object, one cost, one meaning |
| Canonical = today's model, extensions stay | Nothing changes. The next consumer silently knows less than the previous two |
| Canonical = a thin core, everything lazy | No consumer over-pays, and "did this consumer remember to ask" returns as the failure mode |

**RECOMMEND: the canonical model is everything J4 needs to reason about the
business, and the three connected-system summaries move into it.** They are not
presentation detail — they are facts about the business that both reasoning
consumers already decided they needed, independently, which is the strongest
possible evidence that they belong.

**Explicitly NOT canonical:** anything a single UI surface needs to render
itself. See U2.

---

## 3. U2 — When is a per-consumer extension legitimate?

**Evidence.** Of the 8 consumers reading providers directly, some are dashboard
pages rendering one section — `customers/page.tsx` needs customer segments and
nothing else. Loading a 27-query understanding to render that page would be
absurd. Others are J4 producing owner-facing statements —
`genesisBriefingComposer` computes revenue itself to write the daily briefing.

**Options**

| | Consequence |
|---|---|
| **Legitimate for PRESENTATION, never for REASONING** | A page rendering one section reads its provider directly. Anything J4 says or decides comes from the canonical model. The line is what the caller *does with it* |
| No extensions ever | `customers/page.tsx` pays 27 queries to show a segment chart |
| Extensions anywhere, if declared | Declaration is better than silence, but a reasoning consumer that declares an extension is still a second source of truth |

**RECOMMEND: legitimate for presentation, never for reasoning** — and, following
the Verification Hardening precedent, **a presentation read is declared, not
incidental**. Silence is how these diverged; a named, reasoned exception is not.

**By this rule, three current consumers are in violation and are the milestone's
real work:** `buildChatDataContext` (a second assembler), `cognitiveLayer` (canon
plus its own), and `genesisBriefingComposer` (J4 speaking from its own revenue
read).

**`insights.ts` is NOT in violation.** It is a provider.

---

## 4. U3 — The cost and complexity ceiling

**Evidence, measured.** The canonical assembly is ~27 parallel queries today.
That fan-out has already caused a real, recorded failure: two verification suites
carry comments saying `getBusinessProfile` and `buildTurnContext` fan out enough
parallel reads to exhaust PGlite's single connection and **kill an unrelated
suite three positions later**. Both had to be moved to their own Postgres.

Folding in three summaries makes it ~30.

**Options**

| | Consequence |
|---|---|
| **A hard ceiling, and sections that cost real money are lazy behind it** | Bounded and predictable; laziness reintroduces "did the consumer ask" unless the lazy sections are the same for everyone |
| No ceiling | The object grows until something else dies the way those suites did |
| Split into named bundles per consumer type | Multiple canonical models, which is the problem restated |

**RECOMMEND: a stated ceiling with an escape hatch that is measured, not
assumed.** Concretely:

1. The canonical assembly declares its query count, and **a test asserts the
   count** — so growth is a visible decision rather than a drift.
2. Anything genuinely expensive (a provider round trip, a large scan) is not
   admitted to the canonical model at all; it stays a provider a consumer calls
   deliberately, under the U2 declaration rule.
3. **The ceiling number is not chosen in this contract.** It should be set from a
   measurement of the assembly's real cost, which is implementation work.

---

## 5. U4 — Is a disagreement stored, or computed live?

**This is the decision that interacts with the fact lifecycle just shipped, and
it should not be answered casually.**

**Evidence.** `CognitiveOutput` already has everything a disagreement needs:

| Column | What it would carry |
|---|---|
| `topicKey` | stable identity, so the same disagreement is not raised twice |
| `status` | `ACTIVE / RESOLVED / SUPERSEDED` |
| `recordId` + `entityType` | which fact it is about |
| `data` | the two sides, structured |
| dismissal | the owner can already dismiss |

And decisively: **`resolveMissingObservations` (`notify.ts:66`) already retires a
finding that is no longer in the current set.** A disagreement the owner fixes
should stop being raised, and that machinery exists.

**Options**

| | Consequence |
|---|---|
| **Computed live, surfaced as a `CognitiveOutput`** | Self-correcting: fix the business and it stops appearing. No new record kind, no new lifecycle, no migration. Cost: recomputed each cycle, and it is not itself a fact with provenance |
| Stored as a new record kind | Durable and queryable, and it needs its own staleness, resolution and correction rules — **re-inventing the lifecycle that was just closed**, for a thing nobody asserted |
| Stored as a `BusinessRecord` | Worse: a disagreement is not owner testimony, not connector data and not an artifact. It would need a seventh provenance kind for something J4 *derived* |

**RECOMMEND: computed live, surfaced through `CognitiveOutput`.** A disagreement
is an **observation about facts**, not a fact. It has no author to attribute, it
must disappear when it stops being true, and the mechanism for exactly that
already exists and is already owner-dismissible.

**The consequence, stated:** a disagreement cannot be corrected by the owner *as
a fact*, because it is not one — they correct the underlying fact, and the
observation goes away. That is the intended behaviour and it is worth being
explicit that it is a choice.

---

## 6. U5 — What does J4 do when it finds a disagreement?

**Evidence.** The precedent from the last milestone (D5) was *record, preserve,
resolve explicitly* — but that governed a disagreement between two **statements
by the same author**. This is a disagreement between **sources**, where nobody is
necessarily wrong: the catalogue may be stale, or the owner's description may be.

J4 already has a proactive channel that speaks once per finding, does not repeat
after dismissal, and withdraws when the finding stops being true.

**Options**

| | Consequence |
|---|---|
| Silently prefer one source | Requires a precedence rule nobody has agreed, and hides a real signal |
| Answer with it only when asked | Never wrong, and the owner has to think to ask — so the most valuable case, where they have not noticed, never fires |
| **Raise it proactively, once, as an observation** | Uses the existing channel, its dedupe and its dismissal. Cost: a false or trivial disagreement is an interruption |
| Ask which is true | Turns every disagreement into a task for the owner |

**RECOMMEND: raise it proactively, once, as an observation — and never resolve it
on the owner's behalf.** J4 says what it noticed and what the two sides are; the
owner decides. This matches the frozen identity principle that J4 makes better
entrepreneurs rather than replacing their judgement.

**A bound worth setting now:** a disagreement is only worth raising if **both
sides are well-sourced**. A catalogue with no products does not contradict a
stated offering — it is an empty business, and grounding already knows the
difference.

---

## 7. Invariants

1. **One canonical assembler.** `getBusinessUnderstanding` is the only thing that
   composes providers into an understanding. A second assembler is a defect.
2. **A reasoning consumer reads the canonical model and nothing else.**
3. **A presentation consumer may read a provider directly, declared with a
   reason** — never silently.
4. **No fact is computed twice in one turn.**
5. **Providers stay free to read the database.** They are how facts exist.
6. **Provenance is not weakened.** The canonical model carries it; folding
   summaries in must not flatten `sourceOf`/`groundingRules` reporting.
7. **Nothing in this milestone writes.** Assembly is read-only, as
   `understanding.ts` already states.
8. **The fact lifecycle is not reopened.** `currentFacts` stays the reader for
   owner-authoritative types; convergence must not reintroduce a path that reads
   superseded facts.

---

## 8. Scope

### In

1. Fold the three connected-system summaries and upcoming appointments into the
   canonical model.
2. Retire `buildChatDataContext` as a second assembler — its contents either move
   into the canonical model or become a declared presentation read.
3. `cognitiveLayer` and `genesisBriefingComposer` read the canonical model
   instead of recomputing.
4. A declaration mechanism for presentation reads.
5. A query-count assertion (U3).
6. Tests: no fact computed twice in a turn; a new consumer inherits everything.

### Out, explicitly

- **Reconciliation itself.** U4 and U5 decide how a disagreement would be
  *represented and surfaced*; building the detection is a separate contract.
- **The relationship graph.** 7 unread kinds stay unread here.
- **The six unreached entity types.**
- **Verification Hardening and the Business Fact Lifecycle.** Closed.
- **Any schema change.** The recommendation in U4 needs none.
- **The standalone suite runner.** Still tracked separately.

---

## 9. Acceptance

**IMPLEMENTED / VERIFIED / LIVE-PROVIDER-BLOCKED stay separate**, as in the last
two milestones.

1. Exactly one assembler exists — asserted at source, with a control that adds a
   second and confirms the check fails.
2. No fact is computed more than once in a single turn — measured, not assumed.
3. Every reasoning consumer reads the canonical model.
4. Every presentation read is declared with a reason; an undeclared one fails.
5. The query count is asserted, and growing it is a visible change.
6. Provenance and grounding still report correctly after the fold.
7. `currentFacts` is still the reader for owner-authoritative types — a control
   confirms a superseded fact cannot re-enter the understanding.
8. Typecheck, **`npx next build` reported separately from any suite count**, the
   shared runner, and every suite touched.
9. New suites declare their lane.

---

## 10. Open — all of U1–U5

**Five decisions, presented with evidence, options and a recommendation. None is
taken.** This contract is not implementable until Sean approves or amends them.

Two are worth flagging because they are the ones a reasonable reading might get
wrong:

- **U2** draws the line at *reasoning vs presentation*, not at "internal vs UI".
  My own reassessment used the wrong framing, and the census corrected it:
  `insights.ts` reads revenue directly and is right to, because it is a provider.
- **U4** recommends **not** storing disagreements, which means declining to give
  them the lifecycle just built for facts. That is deliberate: a disagreement has
  no author, and it must disappear when it stops being true.
