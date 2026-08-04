# J4 Foundation — what J4 knows about a business

**Status: Frozen — v1. Approved by Sean, 2026-08-04.** The Business Understanding object this document names (§2, closing Gap A/B) is the canonical representation of what J4 knows about a business, going forward — every future capability (chat, the first meeting with J4, recommendations, Business Intelligence, automations, eventual proactive reasoning) starts from this same understanding rather than assembling its own. Explicitly one J4, not an intelligent-in-recommendations/shallow-in-conversation split — closing Gap B is what makes that true in the conversational path specifically.

## The finding this document has to lead with

This wasn't a blank-slate question. Before writing anything, I read every real file involved — `lib/intelligence/cognitiveLayer.ts`, `lib/intelligence/learn.ts`, `lib/businessModel/` (entities, reasoning, profile, sync), the real Prisma schema for `Belief`/`BusinessRecord`/`BusinessEvent`/`CognitiveOutput`/`GenesisObservation`, and `ARCHITECTURE.md`'s own "J4 Cognitive Architecture" and "Business Intelligence Engine" sections. What's there is not a prototype or a set of loose parts — it's a formally named, four-subsystem architecture (**Understand / Execute / Learn / Reason**), already frozen in `ARCHITECTURE.md`, already wired into real recommendation and chat flows, and already empirically tested (`J4_REASON_VALIDATION.md`, 6 real before/after scenarios against production data).

So this document's real job isn't to invent an architecture. It's to state the one that already exists clearly against your five questions, confirm it's the right foundation to build on, and name — precisely, not vaguely — the two real gaps that stand between what exists today and "the first meeting with J4" actually working the way you described it.

## 1. What J4 knows about a business

Two kinds of knowledge, kept deliberately separate — this separation is the architecture's own root rule, not a detail:

- **Facts** — current, verifiable state. Identity (name, tagline, brand story, mission, target audience), what's for sale and how it's performing, revenue, customers and real computed segments, team, suppliers, connected systems, stated goals and challenges, locations. Assembled by one real function, `getBusinessProfile()`.
- **Beliefs** — patterns Genesis has *learned*, not been told. Not opinions — claims backed by repeated real evidence, each carrying a confidence score and a maturity label (`early signal` → `an emerging pattern` → `well-established`, or `being reconsidered` if fresh evidence starts contradicting an established one).

A third, narrower category feeds recommendations specifically: **recent decision outcomes** — what the owner actually approved or rejected in the last 14 days, framed explicitly as fact, never blended with belief.

And a fourth: **what J4 has already said** — active recommendations, explanations, and noticed opportunities it's already surfaced, so a new review doesn't repeat itself or contradict a still-open conversation.

## 2. How that knowledge is represented

- **`BusinessRecord`** — one generic, polymorphic table for every real business entity (contact, item, transaction, goal, challenge, employee, location, appointment, campaign, document). Genesis's own internal data (orders, products) is computed live into this same shape on every read, never duplicated into the table.
- **`BusinessEvent`** — an append-only fact log. Every real thing that happened, timestamped, sequenced. Nothing is ever mutated in place here — only appended.
- **`getBusinessProfile()`** — the canonical assembled snapshot of current facts (identity, offerings + performance + trends, revenue, customers + segments, people, goals, challenges). This is the real answer to "what does J4 currently know" for the fact half — and it's already the shared input to both the recommendation engine and (partially — see the gap below) chat.
- **`Belief`** — one row per `(store, topic)`. Confidence is a number; maturity is a **label computed at read time from the raw evidence, never stored**. This is deliberate: a belief can never go stale in the database, because nothing about its maturity is cached — every read re-derives it from `evidenceCount`, when it was first seen, when it was last confirmed or contradicted.
- **`CognitiveOutput`** — everything J4 has ever said: an explanation, a recommendation, a noticed opportunity, an insight, a prediction. **`GenesisObservation`** sits on top of this purely as a presentation/dedup cache for the two states that need a persistent badge (urgent, opportunity) — it is never a second source of truth; the rule enforced in code is that nothing is ever shown as noticed unless a real `CognitiveOutput` already backs it.

## 3. How new information updates that understanding over time

- Every real thing that happens — a sync, an order, a chat-captured fact, a decision — lands on the `BusinessEvent` log. Consumers each track their own independent read position (`BusinessEventCursor`), so adding a new consumer of this history never requires replaying or coordinating with existing ones.
- **Learn** re-derives beliefs from raw evidence on every pass — never an incrementing counter someone could get out of sync. Three real detectors: the same insight recurring across 3+ distinct weeks, a decision pattern (repeated rejections, or repeated before/after measurements agreeing in direction), or the same event recurring on the same record across 2+ weeks. Cross a real threshold, and `upsertBelief` computes fresh confidence and writes it.
- The loop closes through **execution and measurement**: a recommendation gets approved → executed → measured (`PostExecutionMeasurement`) → that real outcome becomes evidence Learn's pattern detector can find later. Belief is never asserted from a single conversation; it's earned from repetition of real, measured outcomes.
- Reason itself is **stateless by design** — every field it's given is a fresh read on every call, nothing cached or carried between invocations. All the memory lives in Belief/BusinessRecord/BusinessEvent, never in the reasoning step itself. This matters for why a future J4 reasoning call can be swapped or improved without needing to migrate any "conversation memory" — there isn't any to migrate.

## 4. How J4 forms recommendations from that understanding

The real lifecycle, already named and frozen: **Observe → Explain → Recommend → Execute.** One call assembles facts + beliefs + recent decisions + what's already been said, and is explicitly instructed to weigh a fact and a thin, early-stage belief differently — a `well-established` belief can support a confident recommendation; an `early signal` should be mentioned cautiously, never used alone to justify one. Every recommendation that references a specific record or belief is validated server-side against something that actually exists — never trusted blindly from the model's own claim.

When a recommendation includes a concrete, executable action, it either runs immediately (if the owner has already granted standing authority for that exact action type) or becomes a real approval request the owner decides on — never a third option, never Genesis quietly doing something outside that path.

## 5. How this plugs into the existing platform without replacing it

It doesn't need to plug in — it already is the platform's reasoning layer, and nothing here proposes a parallel or competing system. The real job of a "J4 Foundation" milestone, given this, is not building new architecture — it's closing two concrete, already-identified gaps.

## Two real gaps — not architecture problems, coverage problems

**Gap A — no single "what J4 currently understands" object exists.** `getBusinessProfile()` assembles facts. Beliefs are always queried live and separately. Nothing today combines facts + beliefs + recent decisions + what's already been said into one durable, nameable thing outside of Reason's own transient, throwaway prompt context. If something *other* than a recommendation call — a UI screen, a chat opener — wants "what does J4 know about this business right now," there's nowhere to ask that question today.

**Gap B — the conversational path is materially thinner than the recommendation path.** When an owner asks J4 a direct question in chat, it answers from facts alone (`getBusinessProfile()` plus a narrower data-context helper) — it never sees beliefs, active recommendations, or recent decisions. Ask Reason to explain something and ask chat the same question, and you get two different depths of understanding from the same business.

**Why this is the real blocker, concretely, not abstractly:** the "meeting with J4" moment you described — opening by reflecting understanding back to the owner in conversation before asking anything — is exactly the conversational path. Today, that path can't do what you're asking it to do, because it's never been given the belief/insight layer to reflect. This isn't a UI gap. It's a data-access gap in the one function the opening conversation would call.

## What a J4 Foundation milestone should actually build

Given the above, deliberately small and closing exactly these two gaps — not a rewrite, not new detectors, not new schema:

1. **A new `getBusinessUnderstanding(storeId)` function** — facts (`getBusinessProfile`) + active beliefs with maturity + recent decision outcomes + active `CognitiveOutput`s, assembled once, in one place. This becomes the one real answer to "what does J4 know," reusable by the future meeting-with-J4 opener, a future understanding-facing dashboard screen, or anything else that needs it later — instead of every future consumer re-deriving its own subset the way chat and Reason each currently do.
2. **Route the conversational data-answer path through that same function**, replacing its current, separate, thinner context assembly — so a chat answer and a recommendation draw on the identical understanding, and the "I've already learned quite a bit..." opening line is something J4 can actually back up with real belief data, not just facts.

Explicitly *not* in scope here: Tier 4 of the Business Intelligence Engine roadmap (Strategic/Opportunity Synthesis) stays deliberately emergent, per its own frozen status — a felt need for new Reason logic is a signal Understand/Learn aren't rich enough yet, not a cue to build a fourth tier preemptively. No new Belief categories, no new detectors, no changes to Execute or the autonomy ladder — all already proven, none of it implicated by either gap.

## What this document deliberately does not do

Doesn't propose new schema. Doesn't propose a new AI call beyond what already exists (Gap A/B are both about *routing existing data differently*, not new reasoning). Doesn't design the "meeting with J4" screen itself — that's its own, later design pass, the same discipline this repo already holds every UI moment to (a confirmed design before any implementation). Doesn't touch Growth Credits, Execute, or the autonomy ladder.
