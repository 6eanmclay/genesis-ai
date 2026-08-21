# J4 Owner Understanding — understanding the person, not just the business

**Status: v1, 2026-08-07 — design only, not yet implemented.** Sean's own test for whether this succeeded: "if two businesses were identical but owned by different people, J4 would naturally advise each owner differently because it understands the person behind the business, not just the business itself." Everything below is designed against that bar.

**The purpose this serves, in Sean's own words, worth keeping in view of every design decision below**: "that's the difference between remembering preferences and building trust." The point was never personalization for its own sake — it's a long-term relationship. A second, complementary test alongside the one above: years in, if the owner asks J4 "what would you do?", the answer should read as a business partner who has actually worked alongside *this* owner that whole time — not a generic AI producing a well-personalized-sounding reply from a preferences table. The first test checks whether Owner Understanding differentiates; this one checks whether it accumulates into something that actually earns trust over time, not just distinguishes two owners on day one.

## The real architectural insight: this isn't a new mechanism, it's the existing one at a different scope

Sean's requirement — distinguish **explicit preferences** ("I like minimalist branding") from **inferred patterns** ("consistently chooses simple interfaces without saying so"), with inferred patterns always explainable and editable, never mysterious — is not a new problem. It's the exact problem `J4_FOUNDATION.md` already solved for the business itself: **Facts** (told, verifiable) versus **Beliefs** (learned from repeated real evidence, carrying confidence and a maturity label computed fresh at every read, never cached, never stale). Owner Understanding doesn't need a new data shape. It needs the same one, scoped to `userId` instead of `storeId` — an owner's stated preference is their *Fact*; an inferred pattern is their *Belief*, with the identical guarantee that already makes Business Understanding's beliefs non-mysterious: every read re-derives the pattern from real evidence (`evidenceCount`, first seen, last confirmed or contradicted), so "explainable" isn't a UI nicety bolted on after the fact — it's what the underlying mechanism already does by construction.

**One real, new requirement this doc adds, not inherited from `Belief`**: Sean's "always editable" is genuinely new. Today's `Belief` is computed, never directly corrected by an owner — there's no "no, that's not actually a pattern" mechanism for a *business*-level belief either. Owner Understanding needs one, and building it here is the natural moment to ask whether it should retroactively apply to `Belief` too (out of scope for this document, but worth naming: this may end up strengthening Business Understanding as a side effect, not just extending it).

## Signals — mapped against what's real today, not assumed

Sean's list: every conversation, approval, rejection, edit, manual correction, accepted recommendation, and business outcome should refine this over time. Checked against what actually exists:

- **Approvals / rejections** — real today. `getRecentDecisionOutcomes()` already collects exactly this evidence (currently windowed to 14 days for the recommendation engine's own use — `J4_FOUNDATION.md`'s Gap D already names this narrowness as a real, unresolved limitation worth revisiting here too, since a pattern about a *person* plausibly needs a longer memory than a rolling two weeks).
- **Conversations** — real today, `StoreMessage` history (now bounded to the most recent 50 per today's latency fix — worth noting explicitly: a *behavioral* pattern drawn from conversation needs to be computed incrementally over time, not re-derived from the same bounded recent window every time, or old evidence would silently fall out of the pattern entirely).
- **Accepted recommendations** — real today, overlaps substantially with approvals via `ApprovalRequest`.
- **Manual edits / corrections** — a real gap. There's no current mechanism distinguishing "the owner edited something Genesis created" from any other store mutation — this signal doesn't exist as its own tracked event yet.
- **Business outcomes** ("did the decision actually work out") — the hardest one, and honestly aspirational: this requires attributing a real business result (revenue, conversion, retention) back to a specific earlier decision, a genuine causal-inference problem this codebase has no mechanism for today, not just an unwired data source.

Naming the gaps precisely matters more than listing the vision — the first three are real and buildable now; the last two are where "design only" is doing real work, not a formality.

## The relationship to Business Understanding — one direction each way, never blended

Confirmed already, restated precisely here since it's this document's own foundation: Owner Understanding **reads** Business Understanding's evidence (a rejection pattern is a fact about decisions, already sitting in `recentDecisions`) to infer owner-level patterns. It never writes back into Business Understanding's Facts — an owner's risk tolerance is not a fact about the business. The reverse influence is behavioral, not a data write: Owner Understanding shapes *how* J4 frames a recommendation, and, concretely, which `AuthorizationTier` feels right for *this* owner — never what Business Understanding records as true. Two one-directional relationships, not a bidirectional merge — the same discipline that already keeps Facts and Beliefs from blending, applied one level up.

## The relationship to J4_IDENTITY.md — knowledge versus behavior

`J4_IDENTITY.md` defines how J4 *acts* — its personality, how it teaches, how it challenges, its continuity across sessions. Owner Understanding is what J4 *knows* about the specific person it's acting toward. These are meant to compose, not compete: identity is the constant; Owner Understanding is what tunes its application to this one owner. A cautious owner and a decisive one should both get the same J4 *identity*, applied differently — the trusted-advisor principle (`J4_IDENTITY.md`, already frozen) means something different in its concrete application depending on what Owner Understanding actually knows.

## A privacy dimension Business Understanding doesn't need to solve

Business Understanding is store-scoped and meant to be seen by everyone with real access to that store (owner, employees, per `StoreRole`). Owner Understanding profiles one specific *person's* decision-making — a materially more sensitive thing to model than "what the business sells." This needs its own visibility rule, not an inherited one: an owner's own inferred psychological/behavioral profile should very plausibly be visible and editable only by that owner, never surfaced to an Employee-role member of the same store, even though both can see the store's Business Understanding freely today.

## Open questions this document doesn't answer yet

- **Evidence window for owner-level patterns** — `recentDecisions`'s existing 14-day window was sized for the recommendation engine's own recency needs; a pattern about how a *person* thinks plausibly needs to accumulate over months, not weeks. Unresolved.
- **What "editable" actually looks like** — a UI/interaction question, not just a data one: does the owner see a list of inferred patterns to individually confirm or dismiss, and where does that live?
- **Manual-edit and business-outcome signals** — both real gaps named above, not designed here.
- **Cold start** — what J4 does before any real pattern has enough evidence to be a Belief-equivalent; presumably defers entirely to identity + explicit preferences until real evidence exists, but not decided here.

---

## What was built, and what the open questions turned out to be (2026-08-21)

**Built, and verified against real Postgres** (`scripts/verify-owner-understanding-live.ts`, 42 assertions):

An owner pattern is an ordinary `Belief` with `entityType: "owner"` and `recordId` set to the owner's `userId` — this document's own insight taken literally, so there is no new table, no migration and no second store of preferences. `getOwnerUnderstanding(storeId, userId)` reads them and returns nothing to anyone who is not the subject.

- **Explicit preferences vs. inferred patterns** — already distinct, and unchanged: a stated fact is a `BusinessRecord`, an inferred pattern is a `Belief` re-derived from real evidence at every pass, carrying `evidenceRefs` the owner can inspect.
- **Always editable** — `dismissOwnerBelief` closes the one requirement this document added that `Belief` did not already have. It sticks: `upsertBelief` refuses to resurrect a dismissed belief while the evidence is the evidence the owner already judged. It is not a permanent gag: evidence beyond that count is a genuinely stronger claim and may return. No new column — `evidenceCount` on the dismissed row records what existed at the moment of dismissal.
- **The privacy dimension** — solved as this document proposed. Owner-scoped beliefs are excluded from `getBeliefs` unless the caller names the viewer, and returned only to the person they are about. An employee of the same store sees the business's beliefs and never the owner's profile, including in prompts.

### The evidence window: the question dissolved rather than being answered

This document worried that `getRecentDecisionOutcomes`' 14-day window, "sized for the recommendation engine's own recency needs", would be too short for a pattern about a person.

**Measured, and it never applied.** `detectDecisionOutcomePattern` reads `ApprovalRequest` with **no date filter at all** — owner patterns have always accumulated over all time. Proved rather than read: two declines aged 400 and 365 days still form a pattern with `evidenceCount: 2`, while `getRecentDecisionOutcomes` correctly returns nothing for the same store. Two reads, two questions, both right.

So there is no number for Sean to choose here. The window that exists bounds "what has been settled lately", which is what it was built for.

### Still genuinely open

- **What "editable" looks like as an interface.** `dismissOwnerBelief` is real and callable; where an owner *sees* their inferred patterns and dismisses one is an interaction design decision, not a data one, and it is not invented here.
- **The manual-edit signal.** Still no mechanism distinguishing "the owner edited something Genesis created" from any other store mutation. Unchanged from v1.
- **Business outcomes.** Still a causal-inference problem, not an unwired data source. Unchanged from v1.
