# J4 Foundation — what J4 knows about a business

**Status: v2, 2026-08-05 — J4's Business Understanding is complete.** v1 (2026-08-04) proposed closing two gaps; this pass audited that proposal against the real code and everything frozen since. **Gaps A, B, and C are all fully closed** (confirmed live in code, not just planned — see below). One remaining gap (D) corrects an overstated claim made elsewhere in this codebase and is left as a real, explicitly deferred future product decision, not a blocker. Accuracy over preserving earlier assumptions — this document describes what exists, not what was once proposed.

The Business Understanding object this document names (§2) is the canonical representation of what J4 knows about a business — every future capability (chat, the first meeting with J4, recommendations, Business Intelligence, automations, eventual proactive reasoning) starts from this same understanding rather than assembling its own. Explicitly one J4, not an intelligent-in-recommendations/shallow-in-conversation split.

## The finding this document had to lead with, v1 (2026-08-04)

This wasn't a blank-slate question. Before writing anything, I read every real file involved — `lib/intelligence/cognitiveLayer.ts`, `lib/intelligence/learn.ts`, `lib/businessModel/` (entities, reasoning, profile, sync), the real Prisma schema for `Belief`/`BusinessRecord`/`BusinessEvent`/`CognitiveOutput`/`GenesisObservation`, and `ARCHITECTURE.md`'s own "J4 Cognitive Architecture" and "Business Intelligence Engine" sections. What's there is not a prototype or a set of loose parts — it's a formally named, four-subsystem architecture (**Understand / Execute / Learn / Reason**), already frozen in `ARCHITECTURE.md`, already wired into real recommendation and chat flows, and already empirically tested (`J4_REASON_VALIDATION.md`, 6 real before/after scenarios against production data).

So this document's real job was never to invent an architecture. It states the one that already exists against five real questions, confirms it's the right foundation to build on, and names — precisely, not vaguely — the real gaps between what exists and "the first meeting with J4" actually working the way it was described. Two gaps were named in v1; both are now closed. Two more (C, D) are named in this pass.

## 1. What J4 knows about a business

Two kinds of knowledge, kept deliberately separate — this separation is the architecture's own root rule, not a detail:

- **Facts** — current, verifiable state. Identity (name, tagline, brand story, mission, target audience), what's for sale and how it's performing, revenue, customers and real computed segments, team, suppliers, connected systems, stated goals and challenges, locations. Assembled by one real function, `getBusinessProfile()`.
- **Beliefs** — patterns Genesis has *learned*, not been told. Not opinions — claims backed by repeated real evidence, each carrying a confidence score and a maturity label (`early signal` → `an emerging pattern` → `well-established`, or `being reconsidered` if fresh evidence starts contradicting an established one).

A third, narrower category feeds recommendations specifically: **recent decision outcomes** — what the owner actually approved or rejected in the last 14 days, framed explicitly as fact, never blended with belief. **This 14-day window is real and narrow — see Gap D below** for a real case where that narrowness now matters.

And a fourth: **what J4 has already said** — active recommendations, explanations, and noticed opportunities it's already surfaced, so a new review doesn't repeat itself or contradict a still-open conversation.

**A fifth category is real as of 2026-08-05 but not yet part of Business Understanding**: the store's own relationship with the platform itself — Growth Points balance, current `Plan`, subscription status, Business Partner trial state. This is a genuinely different axis from the four above — not a fact about the owner's *business*, a fact about the owner's *relationship with Genesis* — but it's real, it exists in the schema today, and at least one already-frozen principle (`J4_IDENTITY.md`'s "J4 is a trusted advisor") depends on J4 being able to see it. See **Gap C** below.

## 2. How that knowledge is represented

- **`BusinessRecord`** — one generic, polymorphic table for every real business entity (contact, item, transaction, goal, challenge, employee, location, appointment, campaign, document). Genesis's own internal data (orders, products) is computed live into this same shape on every read, never duplicated into the table.
- **`BusinessEvent`** — an append-only fact log. Every real thing that happened, timestamped, sequenced. Nothing is ever mutated in place here — only appended.
- **`getBusinessProfile()`** — the canonical assembled snapshot of current facts (identity, offerings + performance + trends, revenue, customers + segments, people, goals, challenges). The fact half of Business Understanding.
- **`Belief`** — one row per `(store, topic)`. Confidence is a number; maturity is a **label computed at read time from the raw evidence, never stored**. This is deliberate: a belief can never go stale in the database, because nothing about its maturity is cached — every read re-derives it from `evidenceCount`, when it was first seen, when it was last confirmed or contradicted.
- **`CognitiveOutput`** — everything J4 has ever said: an explanation, a recommendation, a noticed opportunity, an insight, a prediction. **`GenesisObservation`** sits on top of this purely as a presentation/dedup cache for the two states that need a persistent badge (urgent, opportunity) — it is never a second source of truth; the rule enforced in code is that nothing is ever shown as noticed unless a real `CognitiveOutput` already backs it.
- **`getBusinessUnderstanding(storeId)`** (`lib/businessModel/understanding.ts`) — **real and implemented**, closing Gap A. Assembles `getBusinessProfile()` + live `Belief`s + `getRecentDecisionOutcomes()` + up to 20 active `CognitiveOutput` rows into one `BusinessUnderstanding` object: `{ profile, beliefs, recentDecisions, activeThoughts, asOf }`. This is the real, current answer to "what does J4 know" — confirmed as the actual shared input to both Reason (`cognitiveLayer.ts`) and chat's data-answer path (`ai-actions.ts`), closing Gap B. It does **not** currently include the fifth category above (Growth Points/plan/trial) — that's Gap C.

## 3. How new information updates that understanding over time

- Every real thing that happens — a sync, an order, a chat-captured fact, a decision — lands on the `BusinessEvent` log. Consumers each track their own independent read position (`BusinessEventCursor`), so adding a new consumer of this history never requires replaying or coordinating with existing ones.
- **Learn** re-derives beliefs from raw evidence on every pass — never an incrementing counter someone could get out of sync. Three real detectors: the same insight recurring across 3+ distinct weeks, a decision pattern (repeated rejections, or repeated before/after measurements agreeing in direction), or the same event recurring on the same record across 2+ weeks. Cross a real threshold, and `upsertBelief` computes fresh confidence and writes it.
- The loop closes through **execution and measurement**: a recommendation gets approved → executed → measured (`PostExecutionMeasurement`) → that real outcome becomes evidence Learn's pattern detector can find later. Belief is never asserted from a single conversation; it's earned from repetition of real, measured outcomes.
- Reason itself is **stateless by design** — every field it's given is a fresh read on every call, nothing cached or carried between invocations. All the memory lives in Belief/BusinessRecord/BusinessEvent, never in the reasoning step itself. This matters for why a future J4 reasoning call can be swapped or improved without needing to migrate any "conversation memory" — there isn't any to migrate.

## 4. How J4 forms recommendations from that understanding

The real lifecycle, already named and frozen: **Observe → Explain → Recommend → Execute.** One call assembles facts + beliefs + recent decisions + what's already been said, and is explicitly instructed to weigh a fact and a thin, early-stage belief differently — a `well-established` belief can support a confident recommendation; an `early signal` should be mentioned cautiously, never used alone to justify one. Every recommendation that references a specific record or belief is validated server-side against something that actually exists — never trusted blindly from the model's own claim.

When a recommendation includes a concrete, executable action, it either runs immediately (if the owner has already granted standing authority for that exact action type) or becomes a real approval request the owner decides on — never a third option, never Genesis quietly doing something outside that path.

## 5. How this plugs into the existing platform without replacing it

It doesn't need to plug in — it already is the platform's reasoning layer, and nothing here proposes a parallel or competing system.

## Four real gaps — not architecture problems, coverage problems

**Gap A — CLOSED, `lib/businessModel/understanding.ts`.** *No single "what J4 currently understands" object exists.* Fixed: `getBusinessUnderstanding(storeId)` is real, combines facts + beliefs + recent decisions + active thoughts into one durable, nameable `BusinessUnderstanding` object. Confirmed in code, not just planned.

**Gap B — CLOSED, `app/dashboard/ai-actions.ts`.** *The conversational path was materially thinner than the recommendation path.* Fixed: chat's data-answer path is confirmed routed through `getBusinessUnderstanding()`, the same object Reason uses. A chat answer and a recommendation now draw on identical understanding.

**Gap C — CLOSED, 2026-08-05, `lib/businessModel/understanding.ts`.** The store's own relationship with the platform — Growth Points balance, current `Plan`, subscription status, Business Partner trial state — is real (the Growth Points economy's pricing froze 2026-08-05, a day after v1 of this document) and is now part of `BusinessUnderstanding`: a new `platformRelationship` field (`planId`/`planName`/`growthPointBalance`/`subscriptionStatus`/`businessPartnerTrialEndsAt`), assembled in the same `Promise.all` as the other four categories, zero new schema (every field already existed on `Store`). `cognitiveLayer.ts`'s and `ai-actions.ts`'s own ad hoc `store.growthPointBalance` fetches are both replaced with this field — the duplication is gone, closed the same way Gap A closed it for facts/beliefs. Verified live against a real store: a temporarily-patched plan/balance/subscription/trial state (reverted after) round-tripped through `getBusinessUnderstanding()` exactly.

**Gap D — OPEN, found 2026-08-05, corrects an overstated claim.** `J4_IDENTITY.md`'s "relationship continuity" principle uses the example *"we ruled this out six months ago because…"* and states this is *"a real, existing fact this system can already answer, not a new capability to build."* That overstates it. `getRecentDecisionOutcomes` — the function that would answer this — defaults to a **14-day window** (§1 above). `getEntityHistory` can pull a specific record's full unbounded timeline, but only if the caller already knows which record; recalling a past *decision by topic*, months back, isn't something `BusinessUnderstanding` supports today. Long-term *pattern* memory (`Belief`) is real and genuinely unbounded — a belief that solidified from evidence six months ago stays real today. Long-term *specific decision* recall is not. `J4_IDENTITY.md` has been corrected to reflect this distinction.

## What a J4 Foundation milestone should build next

Gaps A, B, and C are done — no further work. Only Gap D remains open, and it's a real, open product question, not an implementation default: how far back should decision-memory reach, and should it be a wider fixed window, or a real topic-searchable lookup instead of a time window at all? Not decided here; a real number or mechanism is Sean's own call, the same discipline every other real number in this project has followed. Until decided, `J4_IDENTITY.md`'s "six months ago" example reads as a real future capability being designed toward, not a description of what exists.

Explicitly *not* in scope: Tier 4 of the Business Intelligence Engine roadmap (Strategic/Opportunity Synthesis) stays deliberately emergent, per its own frozen status. No new Belief categories, no new detectors, no changes to Execute or the autonomy ladder — all already proven, none of it implicated by any of the four gaps above.

## Status

**J4's Business Understanding is now complete** for every gap that was scoped as this milestone's own work (A, B, C). Gap D remains real and open, explicitly a future product decision, not blocking this milestone's closure — the same way Tier 4 of the Business Intelligence Engine has always stayed deliberately emergent rather than blocking Tiers 1-3's own completion.

## What this document deliberately does not do

Doesn't propose new schema for Gap C — every field it needs already exists on `Store`. Doesn't propose a new AI call for either open gap (both are about *routing existing data differently*, not new reasoning). Doesn't decide Gap D's actual retrieval window or mechanism — a real product decision, not an implementation default, left to Sean. Doesn't design the "meeting with J4" screen itself — that's its own, later design pass, the same discipline this repo already holds every UI moment to. Doesn't touch Growth Credits, Execute, or the autonomy ladder.
