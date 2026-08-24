# One Canonical Understanding — implementation plan

**Status: PLAN. Awaiting approval. No production code written.** 2026-08-24.
No API credit, no live model, no schema change.

Verified against the closed `BUSINESS_UNDERSTANDING_CONTRACT.md`. **U1–U5 are
settled and are not reopened here.**

---

## 0. The flagged `insights.ts` classification — RESOLVED, by the stated test

The instruction's test: *"If it is a provider, it must remain a provider and must
not independently assemble Business Understanding."*

**Applied to the evidence:**

| Question | Answer |
|---|---|
| Does it assemble a Business Understanding? | **No.** `computeInsights(storeId): Promise<Insight[]>` returns `{ type, severity, summary, metrics }[]` — a list of detected observations |
| Does it compute facts? | **Yes** — that is its whole job. It is the Insight Engine, documented as *"100% deterministic — no AI call anywhere in this file"* |
| Could the canonical model serve it? | **No.** It reads `{ since: oneWeekAgo, until: now }` against `{ since: twoWeeksAgo, until: oneWeekAgo }`; the canonical model carries `last30Days` and `allTime`. Two fixed windows cannot serve a trend detector |
| Does the canonical assembly depend on it? | **No** — so making it a consumer would create the conditions for a cycle that does not exist today |

**RESOLUTION: `insights.ts` is a provider. It stays a provider and changes
nothing.** This applies the instruction's own test rather than amending the
contract.

**And the escalation the instruction asked for does not arise:** making it a
consumer would require giving the canonical model arbitrary-window revenue, which
would materially change U3 — but the test resolves it as a provider first, so
that question is moot. **Flagged here so the reasoning is visible rather than
assumed.**

---

## 1. The exact current assembly paths

### Path A — the canonical assembler
`getBusinessUnderstanding` → `getBusinessProfile`
**27 parallel queries** (19 in the profile, 8 more in the understanding).
Used by 11 consumers.

### Path B — the second assembler
`buildChatDataContext` (`reasoning.ts:1193`), used by `look_up_business_data`.

**It is 24 parallel queries, not 7.** Seven named fetches plus
`...ENTITY_TYPES.map((t) => recentRecords(storeId, t))` — **one query per entity
type, and there are 17**.

| It fetches | Already in Path A? |
|---|---|
| `getRevenue` ×2 | **yes** — duplicate |
| `getTopContacts` | **yes** — duplicate |
| `getUpcomingAppointments` | no |
| `getInvoiceSummary` | no |
| `getCampaignPerformanceSummary` | no |
| `getAppointmentSummary` | no |
| `recentRecords` × 17 types | no |

**So one `look_up_business_data` turn issues ~51 parallel queries** — Path A's 27
(already in `ctx.understanding`) plus Path B's 24 — with revenue and top contacts
computed twice and both copies sent to the model.

**This is materially worse than the 27 the contract recorded, and it is the real
U3 constraint.** It was found by this plan's investigation, which is what the
instruction asked for.

### Path C — canonical plus its own
`cognitiveLayer` calls `getBusinessUnderstanding` **and** seven more:
`getInvoiceSummary`, `getCampaignPerformanceSummary`, `getAppointmentSummary`
(all three duplicating Path B), plus `getOrderSummary`, `getCustomerSummaries`,
`getRecentActivity`, `getActionTypeTrackRecord`.

### Path D — a provider read by a reasoning consumer
`genesisBriefingComposer` calls `getRevenue` itself to write the owner-facing
daily briefing. Revenue is already in Path A.

---

## 2. The canonical path to establish

**One function. One assembler. Declared scope.**

```
getBusinessUnderstanding(storeId, {
  viewerUserId?,
  include?: UnderstandingSection[],   // expensive, opt-in sections
})
```

**The core** — what every consumer gets, unchanged plus the fold:

- everything Path A returns today
- **+ `connectedSummaries`**: invoice, campaign, appointment
- **+ `upcomingAppointments`**
- **+ the business summaries Path C recomputes**: order summary, customer
  summaries, recent activity (see §3 for why these are in rather than out)
- **+ `actionTypeTrackRecord`** into the existing `platformRelationship`, which is
  where J4's own history already lives

**Opt-in sections** — named, still assembled by the same function:

- `recentRecords` — the 17-query per-entity-type map, needed only by the data
  answer.

**Why opt-in rather than always-on, and why this is not a second source of
truth:** the contract's U3 recommended exactly this — *"sections that cost real
money are lazy behind it."* A consumer naming a section is asking the **one**
assembler for more of the **same** understanding. It is not composing its own.
Invariant 1 holds: there is still exactly one thing that composes providers.

**Why not fold `recentRecords` into the core:** it would make every one of the 11
consumers pay 17 extra queries to get a map only the data answer reads. That is
the fan-out that already killed a suite.

---

## 3. What changes, precisely

| File | Change | Why |
|---|---|---|
| `lib/businessModel/understanding.ts` | Grows the core + `include` sections. **Remains the only assembler** | U1 |
| `lib/businessModel/reasoning.ts` | **`buildChatDataContext` deleted** | Invariant 1 — it is the second assembler |
| `lib/execution/toolHandlers.ts` | `look_up_business_data` builds its payload from `ctx.understanding`, requesting `recentRecords` | Invariant 2 |
| `lib/intelligence/cognitiveLayer.ts` | Drops all seven own reads; takes them from the understanding | §8 item 3 |
| `lib/dashboard/genesisBriefingComposer.ts` | Reads revenue from the understanding | §8 item 3 |
| `lib/businessModel/understanding.ts` | A `presentationRead()` declaration helper | §8 item 4 |
| `app/dashboard/customers/page.tsx`, `studio/page.tsx`, `connections/page.tsx` | Wrapped in the declaration — **behaviour unchanged** | Invariant 3 |

**Unchanged, and deliberately:**

- **`insights.ts`** — a provider (§0).
- **All providers** — `getRevenue`, `getCustomerSegments`, `getObligations`,
  `currentFacts` and the rest keep reading the database. Invariant 5.
- **`currentFacts`** stays the reader for owner-authoritative types. Invariant 8.
- **No schema change.** Nothing here needs one.

### A scope determination that needs your eye

Contract §8 item 1 names *"the three connected-system summaries and upcoming
appointments"*. Item 3 says *"`cognitiveLayer` … read the canonical model instead
of recomputing."*

`cognitiveLayer` recomputes **seven** things, not three. Folding only the three
named would leave invariant 2 violated by the very consumer item 3 names — the
milestone would not achieve its own invariant.

**I read item 3 as binding and item 1 as illustrative of what was known when the
contract was written**, and plan to fold all seven. That is a larger fold than
§8 item 1 literally lists. **Flagged rather than assumed — say if you want the
narrower reading, in which case `cognitiveLayer` stays partially non-compliant
and the milestone should say so.**

---

## 4. How the U3 constraint is preserved

**Not an invented ceiling. Three mechanisms, all from measured evidence.**

1. **The assembly declares its own fetch count, and a test asserts it.**
   The number is recorded from measurement, not chosen — today the core is 27 and
   the fold adds a bounded set. Growth then becomes a visible edit to a number
   rather than a drift.

2. **A per-turn duplication gate.** The real defect is not the absolute count but
   that revenue is computed twice in one turn. The test asserts that the figure in
   the data-answer payload is the **same value the understanding already
   carries** — proving it was not recomputed.

3. **The expensive section stays opt-in.** `recentRecords` (17 queries) is
   requested by the one consumer that reads it. Every other consumer's cost is
   unchanged or lower.

**Expected effect on the measured incident:** a `look_up_business_data` turn goes
from ~51 parallel queries to ~27 core + 17 opt-in, with **no duplicates** —
roughly a 15% reduction and, more importantly, one assembly instead of two.

**Honest limit:** this does not by itself fix the PGlite single-connection
fan-out. 27 parallel reads is still a fan-out, and the suites that bring their own
Postgres will still need to. **The milestone makes the count visible and stops it
being paid twice; it does not make the assembly serial.** Saying otherwise would
overclaim.

---

## 5. Tests and gates

**New suite: `scripts/verify-canonical-understanding.ts`** — database-backed, and
placed in the **shared runner** lane if it does not fan out (per the inventory's
own detector).

### Proving no consumer rebuilds Business Understanding

| Gate | How | Negative control |
|---|---|---|
| **Exactly one assembler** | Source: only `understanding.ts` composes multiple providers into an understanding-shaped object | Add a second composer; the check must fail |
| **`buildChatDataContext` is gone** | Source: the symbol does not exist | Reintroduce it; the check must fail |
| **No reasoning consumer reads a provider directly** | Source: a named list of reasoning consumers, none importing a provider the canon supplies | Add a `getRevenue` import to `cognitiveLayer`; must fail |
| **Every presentation read is declared** | Source: a direct provider read outside the declaration helper fails | Remove one declaration; must fail |
| **No fact computed twice in a turn** | Behavioural: build a real turn against Postgres, assert the payload's revenue is the value already in the understanding | Recompute it; the values would still match, so the control instead **asserts the call count** via an injected provider |
| **A new consumer inherits everything** | Behavioural: assert the canonical object exposes the summaries a consumer previously fetched itself | Remove one from the fold; must fail |
| **Fetch count asserted** | Source: count the entries in the assembler's `Promise.all`, compare to the recorded number | Add a fetch; must fail |
| **Provenance not weakened** | Behavioural: `groundingRules`/`sourceOf` report the same after the fold | — |
| **Lifecycle not reopened** | Behavioural: a superseded fact does not appear in the understanding | Un-supersede it; must fail |

### Gates to run

Typecheck · **`npx next build`, reported separately** · the shared runner ·
`verify-fact-lifecycle` · `verify-owner-facts` · `verify-verification-readback` ·
`verify-conversations` · `verify-tool-handlers` · `verify-decision-context` ·
`verify-grounded-reasoning` (deterministic half only — **no credit**).

---

## 6. What I need approved before writing code

1. **§0** — `insights.ts` resolved as a provider, unchanged.
2. **§3** — the scope determination: fold **all seven** of `cognitiveLayer`'s
   recomputed reads, reading contract item 3 as binding over item 1's list.
3. **§2** — opt-in `recentRecords` as a named section of the one assembler,
   rather than folding 17 queries into every consumer's cost.
4. **§4** — the honest limit: this stops double payment and makes the count
   visible; it does not make the assembly serial.
