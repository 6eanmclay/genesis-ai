# J4 Foundation — what J4 knows about a business

**Status: v3, 2026-08-06 — a new real input channel, Business Assets, is now part of this foundation.** v2 (2026-08-05) closed Gaps A-C and left Gap D open. This pass adds no new gap — it documents a real, already-shipped capability (Business Assets M1-M5, `lib/businessAssets/`) that crossed a real threshold: uploads are no longer a file-storage feature bolted onto the side, they're a first-class way J4 forms new Business Understanding, on equal footing with a connector sync or a stated fact in chat. See the new **§3** below. Gaps A-D are unchanged from v2.

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

**And a sixth, real as of 2026-08-16 and part of Business Understanding from the start: what J4 can point at.** `currentAssets` — the asset currently holding each role, keyed by role. This is the difference between J4 knowing a logo *exists* and being able to *use* it. Before it, the only real answer to "what is the brand logo" was `Store.logoUrl`: a column that renders and cannot be referred to, versioned, or handed to a design step. Now `resolveCurrentAsset(storeId, "brand.logo")` returns a record with an id, an origin, and a supersession chain, which is what makes "put **that** logo on a hoodie" a resolvable sentence rather than a guess. Deliberately part of `getBusinessUnderstanding` rather than a separate lookup, for the reason stated at the top of `understanding.ts`: there is one answer to "what does J4 know", and what J4 can point at belongs in it.

## 2. How that knowledge is represented

- **`BusinessRecord`** — one generic, polymorphic table for every real business entity (contact, item, transaction, goal, challenge, employee, location, appointment, campaign, document, asset — see §3 for what each is and where it comes from). Genesis's own internal data (orders, products) is computed live into this same shape on every read, never duplicated into the table.
- **`BusinessEvent`** — an append-only fact log. Every real thing that happened, timestamped, sequenced. Nothing is ever mutated in place here — only appended.
- **`getBusinessProfile()`** — the canonical assembled snapshot of current facts (identity, offerings + performance + trends, revenue, customers + segments, people, goals, challenges). The fact half of Business Understanding.
- **`Belief`** — one row per `(store, topic)`. Confidence is a number; maturity is a **label computed at read time from the raw evidence, never stored**. This is deliberate: a belief can never go stale in the database, because nothing about its maturity is cached — every read re-derives it from `evidenceCount`, when it was first seen, when it was last confirmed or contradicted.
- **`CognitiveOutput`** — everything J4 has ever said: an explanation, a recommendation, a noticed opportunity, an insight, a prediction. **`GenesisObservation`** sits on top of this purely as a presentation/dedup cache for the two states that need a persistent badge (urgent, opportunity) — it is never a second source of truth; the rule enforced in code is that nothing is ever shown as noticed unless a real `CognitiveOutput` already backs it.
- **`getBusinessUnderstanding(storeId)`** (`lib/businessModel/understanding.ts`) — **real and implemented**, closing Gap A. Assembles `getBusinessProfile()` + live `Belief`s + `getRecentDecisionOutcomes()` + up to 20 active `CognitiveOutput` rows into one `BusinessUnderstanding` object: `{ profile, beliefs, recentDecisions, activeThoughts, asOf }`. This is the real, current answer to "what does J4 know" — confirmed as the actual shared input to both Reason (`cognitiveLayer.ts`) and chat's data-answer path (`ai-actions.ts`), closing Gap B. It does **not** currently include the fifth category above (Growth Points/plan/trial) — that's Gap C.

## 3. The entity registry — what J4 can represent, how it's related, and what's canonical vs. derived

Business Assets (`lib/businessAssets/`) is what prompted this section, but the questions it answers were already true of the whole foundation — Business Assets is just the first place they all had to be answered precisely at once.

**What entities J4 can currently understand.** `ENTITY_REGISTRY` (`lib/businessModel/entities.ts`) names **thirteen** real types as of 2026-08-18 (`design` and `socialAccount` joined after this section was written), each with its own Zod schema. Verified against every real write site in the codebase, not assumed from the type list alone — `contact` in particular turned out to be a real hybrid, corrected below:

- `item`, `transaction` — **always derived, never canonical.** Computed live from this store's own `Product`/`Order` rows on every read (`lib/businessModel/internalMapper.ts`), never persisted as their own `BusinessRecord`. `sourceProvider: "internal"`, no exceptions.
- `contact` — **a real hybrid, split by row, not by type.** A customer contact is derived live from `Order.buyerEmail` (`internalMapper.ts`, `sourceProvider: "internal"`) — the exact same "computed, never persisted" status as `item`/`transaction`. A supplier/vendor contact is canonical instead: written by a real connector sync (QuickBooks) or, as of Business Assets M5, a confident upload discovery (`sourceProvider: "genesis_upload"`). Chat itself has no direct new-contact capture today — verified: `factCapture.ts`'s `BusinessFactSchema` covers goal/challenge/employee/location only, not contact.
- `document`, `appointment` — canonical, connector-synced only (QuickBooks invoices, Google Calendar events respectively) — no chat or upload write path exists for either today. Business Assets deliberately keeps its own `asset` type separate from reusing `document` for this reason (see M1's own design note, restated below).
- `campaign` — canonical, from three real sources: Mailchimp sync, J4's own campaign planning triggered from chat (`lib/marketing/campaigns.ts`'s `planMarketingCampaign`, `sourceProvider: "genesis_chat"`), and now a confident upload discovery (`sourceProvider: "genesis_upload"`).
- `goal`, `challenge`, `employee`, `location` — canonical, from the owner telling J4 directly: chat's business-fact capture (`STORE_CHAT_BUSINESS_FACT`, `sourceProvider: "genesis_chat"`) or, as of Business Assets M5, a confident upload discovery (`sourceProvider: "genesis_upload"`).
- `asset` — new in Business Assets M1, always canonical. Every real photo/document an owner has uploaded: `fileType`, `category`, `storageUrl`, `originalFilename`, `summary`, `extractionConfidence`, and the same `relatedRecordId`/`relatedEntityType` relationship fields every other entity type uses. `sourceProvider: "genesis_upload"` always.

**How they're related.** One convention, stated once in `entities.ts`'s own top comment and never broken: any field named `xxxId` (single) or `xxxIds` (array) holds another `BusinessRecord`'s real id. `reasoning.ts`'s `findRelated` walks exactly this convention, and it still does. An asset's `relatedRecordId`/`relatedEntityType` is this same mechanism, not a special case invented for uploads.

**Superseded in part, 2026-08-22 — see §7.** The convention is no longer the whole relationship model. It could express THAT two records were connected and never WHAT the connection was, and it answered every reverse lookup by loading every record of all fifteen entity types into memory. Those id fields are now *projected* into typed, indexed `RecordRelationship` rows. They remain the source of truth; the table is a projection of them, not a second opinion.

**Canonical vs. derived knowledge — a real, load-bearing distinction, not a technicality.** Three tiers. Note this is a property of the *record*, not always the *entity type* — `contact`, above, is the real proof: two rows of the identical type, one derived, one canonical, distinguished only by `sourceProvider`.

1. **Canonical fact** — a real, persisted `BusinessRecord` row, written by a real source (a connector sync, a chat capture, an upload). This is what J4 was actually told or actually read. Source-attributed via `sourceProvider`, always.
2. **Derived fact** — computed fresh from other canonical data on every read (`item`/`transaction` always; a customer `contact` row). Correct by construction, never stale, never itself a write target — `sourceProvider: "internal"` is the tell.
3. **Learned pattern** — a `Belief`. Not a fact about the business at all; a generalization Learn produced from repeated real evidence, carrying its own confidence and maturity (§1). Never conflated with either tier above.

This is exactly why Business Assets M5 makes `item` an explicit exception: when classification confidently identifies a new *sellable product* in an uploaded file, it cannot write a canonical `item` record — `item` isn't canonical, it's derived from `Product`, so a direct write would be a phantom fact with no real product behind it. The only honest move is proposing a real `create_product` approval, which, once the owner approves it, creates the real `Product` row that `item` is *derived from* — canonical knowledge (the owner's decision to add the product) producing derived knowledge (the item record), in the correct direction. A new contact, employee, location, or campaign has no such derived layer in the way — those are canonical types with nothing else backing them, so a confident discovery is written directly, the same trust tier chat's own business-fact capture already uses.

**The confidence model: create, link, or ask.** One score per classification (`classifyAndExtractAsset`, `lib/businessAssets/classify.ts`), 0-1, answering *"how much real, usable business information did I actually extract"* — deliberately not *"how sure am I about my own read."* A live bug (found and fixed during M3) is why that distinction is stated explicitly here: a model confidently certain a file was unreadable noise once counted as *high* confidence, which is wrong — being sure there's nothing there is still nothing there. A threshold (`CONFIDENCE_THRESHOLD = 0.6` — a reasoned starting bar, explicitly not tuned from real usage data yet) gates three, and only three, outcomes:

- **Ask** — below threshold. `category` is stored as `"unclassified"`; any `relatedRecordId` or proposed new entity the model suggested is discarded even if one was offered. J4 asks a real, specific clarifying question in the same conversation turn, quoting what little it could tell, never a generic "I couldn't process this."
- **Link** — at/above threshold, and the file clearly and specifically matches a real existing record J4 already knows. `relatedRecordId`/`relatedEntityType` are committed; nothing new is created.
- **Create** — at/above threshold, no existing match, and the file clearly and specifically describes one new real entity. A canonical type (contact/employee/location/campaign) is written directly. A non-canonical type (product) becomes a real approval instead, and only when a concrete value the approval actually needs (a real price) was genuinely extracted — never fabricated just to satisfy the schema.

This ask/link/create shape isn't new to Business Assets — it's the same shape `ProductImageRequestSchema`'s own scope resolution already uses (a genuinely unresolved scope asks, a resolved one applies). Business Assets is the first place all three outcomes write real, persisted business knowledge rather than just a chat reply.

**How future uploads keep enriching this understanding.** The pipeline is closed-loop by construction, not by convention someone has to remember: `ingestBusinessAsset` (M1) stores the file and a raw asset record → `classifyAndExtractAsset` (M3/M5) reads the real content and asks/links/creates → `getBusinessProfile` (M5) surfaces every confidently-classified asset and every newly-created entity to whatever already reads the profile. That last step is what makes this genuinely self-extending: chat's data-answer path, Reason's recommendation/BI Engine pass, and any future "What J4 Knows" review UI all already read `getBusinessProfile()`/`getBusinessUnderstanding()` — a new asset or a new entity reaches all of them the moment it's written, with zero new wiring per consumer. Extending *what* J4 can learn from a file later (a new file type, a new proposable entity type) means extending `classifyAndExtractAsset`'s own schema and `ENTITY_REGISTRY` — never a second, parallel understanding system.

Explicitly deferred, named not forgotten (`lib/businessAssets/`'s own M1 plan): real video upload (the pipeline above is exactly what it plugs into once built); re-triggering classification from a clarifying-question reply; "legal"/"marketing" as first-class entity types (assets in these categories stay real and searchable without one — see the canonical-vs-derived framing above for why forcing a mapping that doesn't exist would be worse); tuning `CONFIDENCE_THRESHOLD` from real usage data.

### 3a. The two entities added since, and the designation layer (2026-08-18)

Recorded here because a foundation document that does not match the registry is worse than no document: a future session reads this to learn what exists.

**`socialAccount`** — canonical, connector-synced (Facebook, Instagram, TikTok). One row per connected account, carrying follower counts, engagement rate, audience demographics, recent daily metrics, and `topContent` with per-post reach/likes/comments/shares. It also carries `unavailableMetrics`: the field names a platform genuinely does not expose for that account, set explicitly by the connector that knows why, never inferred from a null. That distinction is the difference between "TikTok does not report reach" and "reach is zero", and it is the reason J4 can be honest about the shape of its own knowledge. **No account is connected yet** — see `SOCIAL_CONNECTIONS_SETUP.md` for the credentials and app-review work that gates it.

**`design`** — canonical, produced by `lib/design/createDesign.ts`. A design is `asset(s) + surface + arrangement`, and the record carries `assetIds`, the surface key, the arrangement, and the two outputs it produced (print file and mockup). `assetIds` is an array and follows the `xxxIds` convention, so `findRelated` traverses design-to-asset with no changes — a product made in Studio can answer where its artwork came from by walking real records rather than by convention.

**Roles and supersession, on `asset`.** An asset now carries `role` (what it is FOR, as against `category`, what it IS), `origin` (`uploaded` / `generated` / `backfilled`), two-way supersession, and generation provenance. This is what makes assets referenceable rather than merely stored:

- **Roles are open strings**, same discipline as every other categorical field here. `brand.logo`, `product.photo`, `storefront.hero`, `surface.garment.tshirt` are conventions, not an enum, and a new role is a new string at a call site.
- **Supersession links both ways.** A new logo takes the role; the previous holder points forward. So "the current logo" is a real query — holds the role, not superseded — rather than "whatever is newest", and "what did it look like before" still has an answer.
- **The distinction that matters to the storefront**: something a customer can buy is a `Product`; something that makes the store look better is an asset with a `storefront.*` role. Different objects, different approval paths, and J4 has to know which it just made.

**What this does NOT add.** No new Prisma model — `BusinessRecord` was already generic, so both entities and the whole designation layer are Zod plus one module, exactly as §2 promised. Every consumer of `getBusinessProfile()` / `getBusinessUnderstanding()` sees all of it automatically.

## 4. How new information updates that understanding over time

- Every real thing that happens — a sync, an order, a chat-captured fact, a decision — lands on the `BusinessEvent` log. Consumers each track their own independent read position (`BusinessEventCursor`), so adding a new consumer of this history never requires replaying or coordinating with existing ones.
- **Learn** re-derives beliefs from raw evidence on every pass — never an incrementing counter someone could get out of sync. Three real detectors: the same insight recurring across 3+ distinct weeks, a decision pattern (repeated rejections, or repeated before/after measurements agreeing in direction), or the same event recurring on the same record across 2+ weeks. Cross a real threshold, and `upsertBelief` computes fresh confidence and writes it.
- The loop closes through **execution and measurement**: a recommendation gets approved → executed → measured (`PostExecutionMeasurement`) → that real outcome becomes evidence Learn's pattern detector can find later. Belief is never asserted from a single conversation; it's earned from repetition of real, measured outcomes.
- Reason itself is **stateless by design** — every field it's given is a fresh read on every call, nothing cached or carried between invocations. All the memory lives in Belief/BusinessRecord/BusinessEvent, never in the reasoning step itself. This matters for why a future J4 reasoning call can be swapped or improved without needing to migrate any "conversation memory" — there isn't any to migrate.

## 5. How J4 forms recommendations from that understanding

The real lifecycle, already named and frozen: **Observe → Explain → Recommend → Execute.** One call assembles facts + beliefs + recent decisions + what's already been said, and is explicitly instructed to weigh a fact and a thin, early-stage belief differently — a `well-established` belief can support a confident recommendation; an `early signal` should be mentioned cautiously, never used alone to justify one. Every recommendation that references a specific record or belief is validated server-side against something that actually exists — never trusted blindly from the model's own claim.

When a recommendation includes a concrete, executable action, it either runs immediately (if the owner has already granted standing authority for that exact action type) or becomes a real approval request the owner decides on — never a third option, never Genesis quietly doing something outside that path.

## 6. How this plugs into the existing platform without replacing it

It doesn't need to plug in — it already is the platform's reasoning layer, and nothing here proposes a parallel or competing system.

## Four real gaps — not architecture problems, coverage problems

**Gap A — CLOSED, `lib/businessModel/understanding.ts`.** *No single "what J4 currently understands" object exists.* Fixed: `getBusinessUnderstanding(storeId)` is real, combines facts + beliefs + recent decisions + active thoughts into one durable, nameable `BusinessUnderstanding` object. Confirmed in code, not just planned.

**Gap B — CLOSED, `app/dashboard/ai-actions.ts`.** *The conversational path was materially thinner than the recommendation path.* Fixed: chat's data-answer path is confirmed routed through `getBusinessUnderstanding()`, the same object Reason uses. A chat answer and a recommendation now draw on identical understanding.

**Gap C — CLOSED, 2026-08-05, `lib/businessModel/understanding.ts`.** The store's own relationship with the platform — Growth Points balance, current `Plan`, subscription status, Business Partner trial state — is real (the Growth Points economy's pricing froze 2026-08-05, a day after v1 of this document) and is now part of `BusinessUnderstanding`: a new `platformRelationship` field (`planId`/`planName`/`growthPointBalance`/`subscriptionStatus`/`businessPartnerTrialEndsAt`), assembled in the same `Promise.all` as the other four categories, zero new schema (every field already existed on `Store`). `cognitiveLayer.ts`'s and `ai-actions.ts`'s own ad hoc `store.growthPointBalance` fetches are both replaced with this field — the duplication is gone, closed the same way Gap A closed it for facts/beliefs. Verified live against a real store: a temporarily-patched plan/balance/subscription/trial state (reverted after) round-tripped through `getBusinessUnderstanding()` exactly.

**Gap D — CLOSED 2026-08-18, `lib/businessModel/reasoning.ts`.** Sean's decision, and it was the open product question rather than an implementation default: specific-decision recall is **topic and context searchable, not windowed**. `findRelevantDecisions(storeId, query)` reads every decided proposal with no date filter, scores it against the owner's own words across summary, rationale, action type, target and topic key, and ranks by relevance with a small recency nudge (up to +0.1, halving about every three months) so a highly relevant decision from a year ago still outranks a barely relevant one from yesterday. Two measurements shaped it: `topicKey` is set on only 5 of 37 decided requests on the real store, so relevance had to come from the summary text rather than the key; and a genuinely irrelevant question returns nothing rather than the newest decision dressed up as an answer. `getRecentDecisionOutcomes` is unchanged and still windowed at 14 days, because "what has been settled lately" and "did we decide about X" are different questions and both are correct. Both conversational paths supply the search, so Gap B's rule holds. Verified end to end with a decision aged 210 days: the window could not see it, the search ranked it first, and J4 answered with the owner's own reasoning. Superseded note, kept for the record: this was re-verified as still open earlier the same day (`getRecentDecisionOutcomes` still defaults to `days = 14`, confirmed in `lib/businessModel/reasoning.ts`). Found 2026-08-05, corrects an overstated claim. `J4_IDENTITY.md`'s "relationship continuity" principle uses the example *"we ruled this out six months ago because…"* and states this is *"a real, existing fact this system can already answer, not a new capability to build."* That overstates it. `getRecentDecisionOutcomes` — the function that would answer this — defaults to a **14-day window** (§1 above). `getEntityHistory` can pull a specific record's full unbounded timeline, but only if the caller already knows which record; recalling a past *decision by topic*, months back, isn't something `BusinessUnderstanding` supports today. Long-term *pattern* memory (`Belief`) is real and genuinely unbounded — a belief that solidified from evidence six months ago stays real today. Long-term *specific decision* recall is not. `J4_IDENTITY.md` has been corrected to reflect this distinction.

## Coverage gaps — real, named, deliberately not architectural

A first-person self-review (2026-08-06), Sean asking J4 to name what it's still missing before adding more capability. These are distinct from Gaps A-D above: nothing here is a flaw in how understanding is assembled or represented — every one is an honest absence of *coverage*, in data this foundation would happily carry if it existed. Named here so the distinction (and the list) survives, not solved in this pass.

1. **Specific-decision recall beyond 14 days.** Gap D, above — pattern memory (`Belief`) is unbounded, a specific past decision by topic is not.
2. **Profitability.** Revenue is real and live; cost is not — nothing in this store's own commerce data ever produces a real expense record (`Transaction.type: "expense"` exists in the schema, nothing internal writes one). Blocked on a real accounting connection (QuickBooks) being connected with real data, not an architecture question.
3. **Inventory.** `Item.quantityAvailable` exists in the schema; nothing populates it. Already named as its own real product/schema decision in `ARCHITECTURE.md`'s Business Intelligence Engine section and `J4_IDENTITY.md`'s inventory principle (owner-controlled data, J4 provides insight on top of it) — restated here only so this document's own list of what J4 knows is honest about the omission.
4. **Unstructured facts inside an asset summary don't become structured, actionable memory — new, found in this review.** If an uploaded lease says it expires in December, that's understood as a sentence in `Asset.summary` the moment it's read — not a date J4 holds anywhere it could act on weeks later. J4 can tell you what a document says right now; it can't yet proactively resurface an obligation buried inside one. No schema or mechanism decision made here — named as real future `lib/businessAssets/` work, the natural next step after M1-M5, not required for this foundation to be considered solid today.

## What a J4 Foundation milestone should build next

Gaps A, B, and C are done — no further work. Only Gap D remains open, and it's a real, open product question, not an implementation default: how far back should decision-memory reach, and should it be a wider fixed window, or a real topic-searchable lookup instead of a time window at all? Not decided here; a real number or mechanism is Sean's own call, the same discipline every other real number in this project has followed. Until decided, `J4_IDENTITY.md`'s "six months ago" example reads as a real future capability being designed toward, not a description of what exists.

Explicitly *not* in scope: Tier 4 of the Business Intelligence Engine roadmap (Strategic/Opportunity Synthesis) stays deliberately emergent, per its own frozen status. No new Belief categories, no new detectors, no changes to Execute or the autonomy ladder — all already proven, none of it implicated by any of the four gaps above.

## Status

**J4's Business Understanding is now complete** for every gap that was scoped as this milestone's own work (A, B, C). Gap D remains real and open, explicitly a future product decision, not blocking this milestone's closure — the same way Tier 4 of the Business Intelligence Engine has always stayed deliberately emergent rather than blocking Tiers 1-3's own completion.

**Business Assets (§3) is real, shipped, and verified live** (M1-M5, `9ee8e9e` and earlier) — not a gap closure, a genuine expansion of how Business Understanding grows. It doesn't introduce a fifth gap: every consumer of `getBusinessProfile()`/`getBusinessUnderstanding()` sees uploaded knowledge automatically, by construction, not by a new integration each of them separately needed.

**A first-person self-review (2026-08-06) confirmed the foundation is architecturally solid** — nothing surfaced a flaw in how understanding is assembled, represented, or reaches its consumers. What it surfaced is real coverage, not architecture — see the four items above, carried forward as named future roadmap work, not blockers.

## Re-verification, 2026-08-18

Checked against the code rather than trusted, because this document was written on 2026-08-06 and the milestone that reopened it is "establish what J4 fundamentally understands".

**Still true.** Gap A closed: `getBusinessUnderstanding` is real and assembles facts, beliefs, recent decisions, active thoughts, platform relationship and current assets. Gap B closed: both conversational paths route through it (`app/dashboard/ai-actions.ts:2525`, `app/api/chat/route.ts:513`), so a chat answer and a recommendation still draw on identical understanding. Gap C closed: `platformRelationship` is present.

**Was out of date, now corrected above.** The registry had grown from eleven types to thirteen, and the entire asset designation layer — roles, supersession, `currentAssets` — existed in code and appeared nowhere in this document. For a document whose job is to state what J4 knows, that was the real defect found by this pass, not a missing capability.

**Still open, and still Sean's call.** Gap D. The window is verifiably 14 days. The question this document asked in August is unchanged and unanswered: how far back should specific-decision memory reach, and should it be a wider fixed window or a topic-searchable lookup rather than a window at all? Recorded as pending a decision rather than resolved by an implementation default, which is the discipline every other real number in this project has followed.

**Coverage gaps 2, 3 and 4 are unchanged** — profitability blocked on a real accounting connection, inventory on a product decision, and unstructured facts inside asset summaries still not promoted to structured memory. None is an architecture flaw.

## The remaining coverage gaps, as of 2026-08-18

Gaps A through D are closed. What is left is coverage, not architecture — data this
foundation would carry today if it existed. Listed in the order they would become
useful, with what each is genuinely blocked on.

**1. Beliefs are empty on real stores.** Measured, not assumed: Cubit & Coil has
0 beliefs against 44 assets, 15 offerings and 37 decisions. `getBeliefs` reads
them and `distillBeliefs` writes them, but nothing has ever run the write on a
real store. So J4 currently understands facts and decisions and has learned no
patterns. This is the largest honest gap in "what J4 understands", it is not
architectural, and it is the first thing the Business Intelligence Engine will
need — a scheduled or triggered distillation pass. Named here rather than fixed,
because scheduling is that milestone's own work.

**2. Profitability.** Revenue is real and live; cost is not. `Transaction.type:
"expense"` exists and nothing internal writes one. Blocked on a real accounting
connection carrying real data, which is an integration verification question, not
a model question.

**3. Inventory.** `Item.quantityAvailable` exists and nothing populates it. A
real product decision about owner-controlled data, already named in
`ARCHITECTURE.md` and `J4_IDENTITY.md`.

**4. Unstructured facts inside asset summaries do not become structured memory.**
If an uploaded lease says it expires in December, that is a sentence in
`Asset.summary` and not a date J4 holds anywhere it can act on later. J4 can tell
you what a document says when asked; it cannot resurface an obligation buried in
one. Real `lib/businessAssets/` work.

**5. Social understanding is modelled but unpopulated.** `socialAccount` carries
the full shape — content, reach, engagement, demographics, `unavailableMetrics` —
and the interpretation path is verified against a synthetic record. No account is
connected, so the category is empty on every real store. Blocked on credentials
and platform app review, not on anything here.

None of these is a flaw in how understanding is assembled, represented, or
delivered to its consumers. Every one is an absence of data.

## 7. Where a fact came from, and how facts relate (2026-08-22)

The "J4's Understanding of Your Business" milestone. Its audit finding is worth
keeping at the top, because it changed what the milestone was: **J4 already
understood a great deal.** `getBusinessUnderstanding` already returned identity,
classification, offerings, revenue, customers, people, suppliers, connected
systems, goals, challenges, locations, assets, social accounts, profitability,
obligations and audience, plus beliefs, decisions, open thoughts, the platform
relationship, designated assets and commitments — and it was already reused by
Reason, chat, campaigns, brand-logo proposals and the Office.

So the work was not teaching J4 more facts. It was the four things the structure
was missing: **where a fact came from**, **how facts relate**, **how old a fact
is**, and **whether J4's beliefs are visible to the person they are about**.

**Provenance.** Every canonical record now carries `provenance`,
`provenanceDetail`, `statedAt`, `statedById` and `modelExtracted`. Six kinds:
`CONNECTOR`, `OWNER`, `DOCUMENT`, `DERIVED`, `INFERENCE`, `GENERATED`. Five were
planned; `GENERATED` was found while wiring the write sites, because three of
them produce artifacts rather than claims and `INFERENCE`'s owner-facing label
("Something I concluded") would have been printed next to somebody's logo. An
inference might be wrong; a design J4 composed is a file, and hedging it would be
as dishonest as stating a guess flatly.

`persistSyncedRecords` turned out to be the single door every `BusinessRecord`
has ever been written through — twelve call sites, one function — so origin
became a required argument there and the type system now refuses a write that
cannot say where its facts came from. It is deliberately **not** derived from
`sourceProvider`: "quickbooks" plainly means `CONNECTOR`, but the same mapping
would have to decide what "genesis_chat" means, and it cannot — an owner's typed
sentence and a model's reading of a voice memo arrive through that identical
pipe.

**Nothing is backfilled.** A row written before this has `provenance: null`,
which is an honest unknown, and `modelExtracted` is nullable rather than
defaulting to `false` because `false` is itself a claim ("nothing interpreted
this") that a historical row is not entitled to make.

**Relationships.** `RecordRelationship` stores a closed vocabulary of kinds —
`belongs_to`, `involves`, `located_at`, `blocks`, `supersedes`, `derived_from`,
`supplies`, `about` — typed and indexed from both ends. Every kind but one is
backed by a reference field already in the registry; `supplies` is named as a
requirement with nothing populating it yet, and says so where it is defined.

Writing the projection map down surfaced what the convention had been quietly
over-matching: `shipment.orderId` holds an `Order` id, `asset.aiUsageEventId` an
`AiUsageEvent` id, `campaign.groupId` a provider's group — all end in `Id`, all
were scanned on every traversal, harmless only because cuids do not collide.

Projection **reconciles**. The first version only ever added, so an invoice whose
`contactId` moved from A to B left the edge to A standing forever. `projectedFrom`
names the record whose data maintains an edge — not a boolean, because the
reversed projections store the edge pointing the other way and neither endpoint
identifies who is responsible. An edge somebody *stated* has none, so a connector
re-sync never deletes a connection the owner drew by hand.

**Controlled writes.** `lib/businessModel/statements.ts` is the path a person
uses to state a fact or draw a connection. It accepts **no provenance**: a
caller who could pass `CONNECTOR` could make their own sentence read as
something QuickBooks published, and one such path destroys the value of every
honest one. Origin is derived from the actor. Authorization stays with
`requireStorePermission`; what that file owns is the data invariants — both ends
of a relationship really exist in this store, the type is registered, the shape
validates.

**Beliefs became visible.** `getBeliefs` had one consumer and it feeds prompts,
so J4 reasoned from conclusions the owner could not read or contradict. The
Understanding room now shows each claim with the real evidence behind it — four
tables resolved into the owner-facing summaries those rows already carry — the
dates that say whether it still holds, and a way to say "this isn't right".
Corrections are `DISMISSED`, never `RETIRED`: the system retires a belief when
evidence stops supporting it, and letting "the owner said no" read back later as
"it didn't generalise" would invite the opposite response. Durability reuses the
rule `upsertBelief` already had, so a correction survives the next distillation
pass without a new column — and is not a permanent gag, because genuinely
stronger evidence may raise the pattern again.

**Reasoning was told.** Provenance reached the database and stopped at the
serialiser: Reason was handed `goals.map((g) => ({ id: g.id, ...g.data }))`, the
fact with its origin stripped off. Facts now carry a compact `source`, the rules
for reading each kind actually present, and an honest count of what has none —
on Reason, streaming chat, and the non-streaming fallback alike, because both
chat paths draw on identical understanding or neither can be trusted. It is
**not** a weighting: no honest ranking exists between "the owner said so" and
"QuickBooks published it", and inventing one would be a fiction.

`blockedGoals` joins `BusinessUnderstanding` for the same reason everything else
in it is there. Typed relationships reasoning cannot see are an inert
representation, and the whole point of naming `blocks` was that J4 could finally
say "this is the thing standing between you and that".

**What this milestone deliberately did not do.** No new entity types — fifteen
exist and adding more without a business asking is manufacturing. No numeric
confidence model over the profile. No "confirm" button on a belief, because it
would have to move a confidence derived from real evidence. No rewriting a claim
into the owner's words, because a belief is derived and a typed sentence is
stated. And no part of the six-call unified-intelligence work
(`J4_UNIFIED_INTELLIGENCE.md`), which stays a separate milestone that this one
now feeds a clean input to.

**Externally blocked, stated rather than glossed.** Whether a real model reasons
*better* with any of this needs `ANTHROPIC_API_KEY`. Everything deterministic is
proved: what reaches the payload, what it says, what the prompts instruct, and
that unknown stays unknown.

## What this document deliberately does not do

Doesn't propose new schema for Gap C — every field it needs already exists on `Store`. Doesn't propose a new AI call for either open gap (both are about *routing existing data differently*, not new reasoning). Doesn't decide Gap D's actual retrieval window or mechanism — a real product decision, not an implementation default, left to Sean. Doesn't design the "meeting with J4" screen itself — that's its own, later design pass, the same discipline this repo already holds every UI moment to. Doesn't touch Growth Credits, Execute, or the autonomy ladder.
