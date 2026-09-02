# The Business Intelligence Engine

*Specification — 2026-08-18. Written after auditing what already exists, before
writing any new code.*

The goal, in Sean's words: J4 moves from **"I understand your business"** to
**"I continuously understand what is happening in your business, and I tell you
what matters."**

The word doing the work is **continuously**. Understanding is already built and
verified (see `J4_FOUNDATION.md`). What this milestone adds is a heartbeat.

---

## 0. The finding that governs this milestone

**The six-stage engine is already built. It is the trigger that is missing.**

Every stage Sean named — collection, change detection, interpretation, insight,
recommendation, notification/action — exists as real, deterministic code in
`lib/intelligence/`. None of it is speculative and none of it needs designing
from scratch.

But the cycle only ever starts for a store with a **connected external
integration**, and no real store has one. So on Cubit & Coil — a store with real
products, real assets, real decisions — the engine has effectively never run.

This is why the milestone is not "build a BI engine". It is **"connect the
engine that exists to the data J4 already has"**, which is exactly the starting
point Sean specified.

---

## 1. The lifecycle, mapped to what exists

| Stage | Where it lives | Status |
|---|---|---|
| **Collection** | `scheduler.ts` `runDueSyncs()` (connectors) + Stripe/PayPal webhooks (native commerce) | Built. The native path writes `BusinessRecord` + `BusinessEvent` inside the same transaction as the sale. |
| **Change detection** | `changeDetection.ts` — record-level rules + time-based sweeps | Built. Provider-independent by construction; reads only canonical entity fields. |
| **Interpretation → Insight** | `insights.ts` `computeInsights()` | Built. 100% deterministic, no AI. Named thresholds, real computed numbers. |
| **Recommendation** | `cognitiveLayer.ts` `runCognitiveReview()` → `nextBestAction.ts` | Built. The only AI stage. |
| **Notification / Action** | `notify.ts` → `GenesisObservation`; `ApprovalRequest` for action | Built. A second, higher gate on top of the insight threshold. |
| **Learned belief** | `learn.ts` `distillBeliefs()` → `Belief` | Built. Deterministic generalization; re-derived from evidence every pass. |

The separation Sean asked for — observed fact vs. detected change vs. inferred
insight vs. recommendation vs. learned belief — **is already the storage model**,
not something this milestone has to impose:

```
BusinessRecord        observed fact     what is true, as reported by a source
BusinessEvent         detected change   what changed, and when, in sequence
Insight               inferred insight  a computed judgement about significance
GeneratedRecommendation / ApprovalRequest   what J4 proposes doing
Belief                learned belief    a pattern across time, with confidence
GenesisObservation                      what crossed the bar to interrupt the owner
```

Each is a distinct table with distinct provenance. Nothing here merges them, and
nothing writes a row of one kind from an assumption of another.

---

## 2. The three real defects

Found by reading the code, not inferred. Each is stated with its evidence.

### Defect 1 — The cycle is gated behind connector syncs

`lib/intelligence/scheduler.ts:94` adds a store to `touchedStoreIds` **only**
inside the successful-connector-sync branch. Line 134 then runs the entire
downstream chain inside `for (const storeId of touchedStoreIds)`:

```
computeInsights → notifyFromInsights → distillBeliefs → runOpportunisticAiReviewIfStale
```

A store whose whole business is native Genesis commerce — storefront orders,
products, customers, assets, decisions — **never enters that loop**. It has no
`StoreIntegration`, so it is never "touched", so nothing downstream ever runs on
a schedule for it.

This is the highest-value defect, and fixing it is the whole first slice.

### Defect 2 — Learn cannot see decisions made in conversation

All three belief detectors filter on `topicKey: { not: null }` (`learn.ts:124`,
`:194`, `:198`). `topicKey` is set only by the AI-recommendation proposal path
(`genesisAutonomy.ts:147`); a proposal originating in chat leaves it null.

Measured on the real store last session: **`topicKey` is set on 5 of 37 decided
requests.** Learn is structurally blind to the other 32.

**This corrects what I reported at the close of the Foundation milestone.** I
said `distillBeliefs` had never run on real data. That was wrong — it is
reachable with no connector at all, via `/dashboard` load →
`runOpportunisticAiReviewIfStale` → `runCognitiveReview` → `distillBeliefs`
(`cognitiveLayer.ts:379`). The zero-belief result is not "it never ran"; it is
"it ran, and 32 of 37 decisions were invisible to it." That is a more specific
and more fixable problem than the one I named.

### Defect 3 — Insight coverage follows connector-shaped data

`getRevenue` reads `BusinessRecord` of `entityType: "transaction"`. Native
checkouts **do** write those (`app/api/webhooks/stripe/route.ts:134`,
`app/api/checkout/paypal/return/route.ts:176`), so revenue trend genuinely works
on first-party sales. But the overdue-invoice and low-inventory sweeps read
entities only a connector populates today.

**This is a data-availability gap and stays one.** No synthetic invoices, no
inferred stock levels. Those insights stay silent until a real source exists,
which is correct behaviour rather than a bug.

---

## 3. The extension seam

Sean's requirement: accounting, inventory, social, orders, customers and future
integrations must plug in as they authenticate.

**That seam already exists and needs nothing new.** A source contributes by
writing canonical `BusinessRecord` rows through `persistSyncedRecords`. Change
detection reads only canonical entity fields, so a QuickBooks invoice and a
future Xero invoice produce the identical event through the identical rule. Add
a connector and every downstream stage — detection, insight, notification,
belief — begins working on it with no change to any of them.

The one thing this milestone must not do is add a second path for first-party
data. Native commerce already writes canonical records. It should be **read by
the same engine**, never given an engine of its own.

---

## 4. Honesty rules

Binding on every stage:

1. **Never fabricate.** An insight with no data is silence, not a placeholder.
2. **Never promote across kinds.** An insight does not become a belief by being
   repeated in prose; only `learn.ts` may generalize, and only from counted
   evidence.
3. **A belief carries its confidence and its evidence,** and is re-derived
   rather than patched, so it cannot drift from what the evidence shows.
4. **Correlation stays correlation.** `PostExecutionMeasurement`'s non-causal
   framing is carried into belief text verbatim.
5. **Silence is a valid output.** A cycle that finds nothing worth saying says
   nothing, and that is a success, not a failure.

---

## 5. The smallest useful slice — M1: the engine runs on first-party data

**One change in scope: make the intelligence cycle reachable for a store with no
connected integrations.**

What it does:

- A new `getStoresDueForIntelligence(limit)` selects stores by **unconsumed
  `BusinessEvent` activity**, using the existing `BusinessEventCursor` consumer
  mechanism — not by integration status. A store is due because something
  happened in it, which is the honest definition of due.
- `runIntelligenceCycle(storeId)` runs the **existing, unmodified** chain:
  `computeInsights → notifyFromInsights → distillBeliefs`.
- `/api/cron/sync` calls it after `runDueSyncs()`, for due stores, whether or not
  any connector ran. Stores already processed by a sync this pass are not
  processed twice.

What it deliberately does **not** include:

- No new insight types, no new thresholds, no new AI call, no new tables.
- No BI dashboard or reporting surface.
- No accounting, inventory or social work.
- No change to routing, Studio, Office, the creative pipeline, composition, the
  product catalog, the colour system, the asset system, connector architecture or
  decision recall.

**Honest expected outcome.** M1 makes revenue trends, cancellation trends and
event-recurrence beliefs start computing on real first-party data, and lets
notifications fire without a connector. It will **not** on its own produce
decision-pattern beliefs — those need Defect 2 fixed. Saying so up front is the
point; a slice that quietly under-delivers is worse than a small one that states
its limits.

### The queue after M1

- **M2 — Learn sees conversational decisions.** Give chat-originated proposals a
  derived `topicKey` so the 32 invisible decisions become countable evidence.
  This is the direct fix for the zero-belief result.
- **M3 — Cadence.** One daily cron pass is the current heartbeat. Whether
  "continuously" should mean more often than daily is a product decision, not a
  technical one.
- **M4 — Sources, as they authenticate.** Each is a connector, not an engine
  change.

M1 is small on purpose. It is the difference between an engine that is built and
an engine that is running.

---

## 6. M1 as built (2026-08-18)

**Status: IMPLEMENTED and live-verified (2026-08-21).** `verify-intelligence-cycle.ts` passes in `run-db-suites`, and `verify-business-memory-live.ts` proves Learn runs against a real database — unconditionally, and before Reason.

The selection semantics are proved and accepted
(`scripts/verify-intelligence-selection.ts`, 11/11, no database required). The
end-to-end check (`scripts/verify-intelligence-cycle.ts`) is **written and not
yet run**: this workstation has no reachable database — no local Postgres, and
production credentials are scrubbed from the sandbox environment. It runs when a
production/cloud database environment is available.

Nothing about the implementation is to be changed on account of that. An
unverified claim is recorded as unverified; it is not a reason to redesign
working code. The `--run` path stays unrun for now — it performs the real
recommendation stage and can incur a paid model call.


| File | Change |
|---|---|
| `lib/intelligence/cycle.ts` | New. `selectDueStoreIds` (pure), `getStoresDueForIntelligence`, `runIntelligenceCycle`, `runDueIntelligenceCycles`. |
| `lib/intelligence/scheduler.ts` | Its post-sync block now calls `runIntelligenceCycle`. The connector path and the first-party path are the same code, not two copies of the same intent. |
| `lib/intelligence/insights.ts` | One line: `INSIGHT_ENGINE_CONSUMER` exported, so store selection reads the cursor the Insight Engine already advances instead of inventing a second progress marker. |
| `app/api/cron/sync/route.ts` | Runs the first-party pass after the sync pass, skipping only stores whose sync succeeded. |

No migration, no new table, no new model, no new insight type, no new AI call.

**A store is due because its highest `BusinessEvent.sequence` is beyond the
`insight-engine` cursor.** That is the existing mechanism, and it is what makes
re-processing impossible: `computeInsights` advances the cursor at the end of a
pass, so the same events cannot select the store again. New activity moves the
head, and the store becomes due again. A store with nothing new is never in the
batch at all.

The boundary Phase 1 drew still holds. The cursor decides *when* a store is
processed; `processedAt` still decides what the Insight Engine treats as
unprocessed. Nothing in M1 can change what the engine concludes.

**Deferred, recorded, not attempted here:** the `topicKey` limitation is **M2**.
`runIntelligenceCycle` carries a note at the `distillBeliefs` call saying so, so
the next person to wonder why beliefs stay thin finds the answer at the call
site rather than in a document.

---

## 7. M2 — Learn sees decisions made in conversation

**Specification. Not implemented.**

The goal: the 32 of 37 decided requests that carry no `topicKey` become
countable evidence, so Learn can form beliefs from what the owner actually
decides in conversation rather than only from the small slice J4 proposed
itself.

Nine sites create an `ApprovalRequest` without a `topicKey`
(`app/api/chat/route.ts:777`, `:880`, `:1701`;
`app/dashboard/ai-actions.ts:2893`, `:3035`, `:3171`, `:3703`, `:4093`, `:5484`).
`genesisAutonomy.ts` and `cognitiveLayer.ts` set one; the conversational paths
never do.

Auditing the consumers turned up two constraints that decide the design.

### Discovery 1 — `topicKey` is owner-visible text

`learn.ts:220` renders it verbatim into a belief the owner reads:

> The owner has declined proposals about **"declining_repeat_purchases"**
> 2 time(s); consider a different approach before proposing this again.

So a structural key is not an option. `action:update_product` would surface as
*"The owner has declined proposals about 'action:update_product'"* — a database
row read aloud. The existing convention is a short, readable,
`lowercase_snake_case` slug naming the underlying idea, and M2 must match it.

### Discovery 2 — `topicKey` also drives a permanent mute

`storefrontSuggestionGate.ts:96` blocks J4 from ever raising a topicKey the
owner rejected. That file's own stated principle is that **"being asked is not
the same as volunteering"** — it exists to govern J4's initiative, not the
owner's requests.

But its lookup matches every `ApprovalRequest` with that key regardless of who
originated it. So the moment chat proposals carry topicKeys, an owner who asks
for a hero change in chat and then declines the result would **permanently
silence J4's own hero suggestions** — a regression created entirely by M2, in a
file M2 is otherwise not about.

The fix is one clause: scope that lookup to proposals J4 volunteered. The
existing discriminator is `cognitiveOutputId` — set on J4-originated proposals,
null on conversational ones. (`decisionMode` does not work for this: it is
`"human"` for both, because it records who approves, not who proposed.)

### The derivation

Deterministic, no AI call, matching the intelligence layer's own discipline. The
key names **the kind of ask**, built from `actionType` and the meaningful
qualifier already present in `input`:

| Proposal | topicKey |
|---|---|
| `update_product` changing description | `product_description_rewrite` |
| `update_product` changing price | `product_price_change` |
| `update_product_image` | `product_image_replacement` |
| `delete_product` | `product_removal` |
| `create_product` from an upload | `new_product_from_upload` |

**Keyed by the kind of ask, not by the record.** Two declines about different
products are genuine evidence about the kind of suggestion the owner does not
want; keying per product would almost never reach the threshold of 2, and the
belief it eventually formed would be about one item rather than about the owner.

**Excluded:** the revert path (`ai-actions.ts:5484`). Undoing something is not a
proposal pattern, and counting it as one would teach Learn a preference that was
never expressed.

### Scope

- Give the eight conversational proposal sites a derived `topicKey`.
- Scope the storefront gate's rejection lookup to J4-originated proposals.
- A pure test for the derivation: stable across wording, readable, and never
  colliding with the model-authored semantic namespace.

**Not in M2:** no change to `learn.ts`, no new detector, no new threshold, no
change to decision recall, no new table, no AI call.

### The backfill question — Sean's call

The 32 existing decisions can be given topicKeys by the same derivation, since
it reads only `actionType` and `input`, both already recorded. That is
derivation from existing evidence, not fabrication.

It is still a write to historical rows, so it is proposed rather than assumed.
Without it, beliefs stay empty until two new decisions of the same kind
accumulate naturally — which is honest, just slower.

### M2 as built (2026-08-18)

**Status: IMPLEMENTED AND ACCEPTED. Regression suite 34/34, typecheck and lint
clean — accepted as sufficient for the implementation.**

**The backfill is PENDING production/cloud database verification**, recorded on
exactly the same footing as M1's end-to-end cycle check: written, not run, and
not to be run until a real database environment is available. Nothing about the
implementation is to change on account of that.

| File | Change |
|---|---|
| `lib/intelligence/topicKeys.ts` | New. `deriveTopicKey` — the one canonical derivation — and `planTopicKeyBackfill`. |
| `lib/intelligence/proposalOrigin.ts` | New. `isVolunteeredByJ4` / `volunteeredByJ4`, the single shared statement of who may teach J4 a preference. |
| `lib/intelligence/learn.ts` | Rejection detection now runs through `planRejectionBeliefs` (pure, extracted, behaviour unchanged) with the origin rule applied. |
| `lib/dashboard/storefrontSuggestionGate.ts` | Its rejection lookup counts only proposals J4 volunteered. |
| `app/api/chat/route.ts`, `app/dashboard/ai-actions.ts` | Eight conversational proposal sites derive a topic key. The revert path is deliberately excluded. |
| `scripts/backfill-topic-keys.ts` | Dry-run by default; `--apply` writes. |
| `scripts/verify-topic-keys.ts` | The regression suite. |

**A prior deliberate decision was superseded, not overwritten.** `ai-actions.ts`
carried an explicit `topicKey: null` with a Phase 5 comment explaining that
telling "a real business issue" from "a direct instruction" needed either a
second Claude call or heuristic classification, and that an honest null beat a
guess. That reasoning was correct and is now met on its own terms: the
derivation is neither a model call nor a heuristic, and returns null wherever no
honest name exists. The comment at that line records the supersession rather
than pretending the earlier decision was never made.

**What changed is not the standard for naming a decision — it is that the name
no longer has to carry "is this a real finding?".** That question is now
answered separately, by origin, at the only two places it matters: belief
formation and J4's own initiative.

---

## 8. M3 — Genesis records what happens inside it

**Status: IMPLEMENTED. Regression suite 31/31, plus M1 (11/11) and M2 (34/34)
still passing. Typecheck and lint clean.**

### The gap it closed

Exactly three places wrote a `BusinessEvent`: connector syncs, the Stripe
webhook and the PayPal return. The only first-party event in the entire system
was `transaction.created`.

So a store with no sales had **no events**, was therefore never selected, and
M1's cycle never ran for it. The engine was reachable only through the one door
that requires revenue. A second consequence: even a store with sales only
re-ran the cycle after the *next* sale, so a trend crossing a week boundary was
never evaluated in between.

That is also why the previously-queued M3 ("is daily often enough?") was the
wrong next step. Cadence was never the gate — selection was.

### What it does

| File | Change |
|---|---|
| `lib/intelligence/executionEvents.ts` | New. `mapExecutionToEvent` (pure), `recordExecutionEvent`, and the sink seam. |
| `lib/execution/engine.ts` | One call on the success path, after the outcome is recorded. |
| `scripts/verify-execution-events.ts` | The regression suite. |

A successfully executed Genesis action writes one canonical event through the
same `writeBusinessEvents` every other producer uses. No new table, no new
pipeline, no second event log, no migration.

**`item` is the only entity mapped today**, covering the five product actions.
Storefront, brand and marketing actions return **null** — not because they don't
matter, but because no canonical entity represents "the storefront" in
`ENTITY_REGISTRY`, and inventing one to make them fit would put a shape into the
event log that no consumer can reason about. That is the same honest-null
discipline `deriveTopicKey` uses. When a storefront entity genuinely exists,
`ITEM_ACTIONS` is where it lands.

**SUCCESS only.** PENDING has not happened yet, WARNING means the executable's
own `verify()` could not confirm it, PARTIAL is by definition unclear. An event
is a claim about reality, so only the unambiguous outcome earns one.

### Acceptance criteria, as proved

| Criterion | Proof |
|---|---|
| Exactly one event per successful execution | §1 — one write, canonical entity/type/summary, execution recorded as provenance |
| Zero events for failed executions | §2 — FAILED, PENDING, WARNING and PARTIAL each write nothing |
| No event without an honest canonical mapping | §3 — five unmapped actions, a null action type, and a null store all write nothing |
| Written only after successful execution | §4 — plus the call site sits after `recordExecution`, unreachable from the catch path |
| Idempotent per execution | §5 — three calls, one event; a different execution still writes; a throwing sink never throws into the execution |
| M1 consumes the resulting event | §6 — a store with no sales becomes due, and the consumed event never selects it again |
| No feedback loop | §7 — twelve hourly passes with an autonomous action in the loop settle at one execution, two events, and a store at rest |

### Boundary held

Uploads, chat decisions and general owner activity emit nothing. Those are a
separate event-source milestone, to be evaluated once this plumbing is proven
against a real database.

**Live-verified since (2026-08-21):** M3's emission by
`verify-business-memory-live.ts` §§1–4 and M2's backfill by
`verify-bi-reads-live.ts` §1. M4's detector runs against real Postgres but its
observation lifecycle carries no assertion — recorded as *path exercised,
lifecycle unasserted*. **No production backfill has been run and no paid path
executed.**

---

## 9. M4 — the continuous engine notices what J4 already knows how to see

**Status: IMPLEMENTED. Acceptance suite 28/28; M1 (11/11), M2 (34/34) and M3
(31/31) still passing. Typecheck and lint clean.**

### The gap it closed

M1 and M3 made the cycle run for a store with no connectors. It then had almost
nothing to say: of five insight detectors, four read connector-only data and the
fifth needs two weeks of sales. A pre-revenue store got a working engine and
silence.

Meanwhile `evaluateStorefront` — which reads **only** products and assets, no
connector, no sales — had exactly one caller: the chat handler, when the owner
asked. J4 could form a real opinion about the store, but only if invited to.

### What it does

| File | Change |
|---|---|
| `lib/intelligence/storefrontReadiness.ts` | New. `planStorefrontReadinessInsight` (pure), `governanceFor`, `detectStorefrontReadiness`. |
| `lib/intelligence/insights.ts` | One more detector in the existing `Promise.all`. |
| `lib/intelligence/notify.ts` | One entry in the existing `NOTIFY_WORTHY` map. |

`evaluateStorefront` is untouched. The suggestion gate is untouched. The
notification path is untouched — there is no second notification system because
there is no new notification code at all. **This adds no new capability; it
gives an existing one a second caller.**

### The correctness requirement that shaped it

The gate's cooldown starts the moment J4 raises the insight, so on the very next
cycle the gate says no. Had that silenced the insight, `notifyFromInsights`'
resolve sweep would have seen it missing and marked the observation **RESOLVED**
— quietly retracting something still true, seven days before J4 was allowed to
say it again.

So the gate decides whether to **start** saying something. It never decides
whether to keep a true thing said. An insight already standing keeps being
produced for as long as the condition holds (T5).

### Grounded, never inferred

Every string is either counted from real rows or quoted verbatim from
evaluateStorefront's own reading. Nothing here reads an order, a transaction or
a revenue figure, and T6 asserts the absence of sales language in both the
summary and the metrics. Sean's rule for pre-revenue stores holds: J4 may name a
real storefront problem with no sales data, and never infers sales performance
from its absence.

### Governance mapped honestly

Each finding is gated under the action it is really about, using M2's canonical
topic keys so the gate's previously-rejected and learned-preference lookups
match the keys a real proposal would carry. `products_missing_photos` maps to
`update_product_image`, which the gate **deliberately excludes** from
governing — its own comment: "product-level work the owner is usually mid-flow
on... Governing those would suppress useful, unrelated help under a rule written
for redesigns." Forcing it under a redesign cooldown to make the mapping tidy
would have broken the gate's stated intent.

### Live database verification — where M1–M4 actually stand (2026-08-21)

M1's end-to-end check, M2's backfill and M3's emission have all since run
against a real database and pass. **M4's detector has since been closed too** —
`verify-readiness-lifecycle-live.ts` asserts the observation lifecycle end to
end, which the earlier "path exercised" wording was deliberately holding open.

Still true, and unchanged: **no production backfill was run and no paid path
executed.**

---

## 10. M5 — "What did I actually keep?"

**Status: IMPLEMENTED. Acceptance suite 34/34; M1 (11/11), M2 (34/34), M3
(31/31) and M4 (28/28) still passing. Typecheck and lint clean.**

### The gap it closed

`Product.costInCents` was already real and populated (onboarding captures a
self-supplied cost; Printful variants carry the partner's own). `getProfitSummary`
already computed real profit, honestly, with N-of-M coverage. It had exactly one
caller: the Analytics page.

So an owner could ask J4 *"I sold $400 of candles — what did I keep?"* and get
nothing, while the number sat computed one page away. The same shape of gap M4
closed for the storefront: a capability built for one surface, invisible to J4.

### What it does

| File | Change |
|---|---|
| `lib/businessModel/profitability.ts` | New. `summarizeMarginCoverage`, `computeItemMargin`, `planProfitability` (all pure) and `getProfitability`. |
| `lib/businessModel/profile.ts` | One field on `BusinessProfile`. |
| `lib/dashboard/storeChatUnified.ts` | One paragraph telling J4 how to answer honestly. |

`getProfitSummary` and `getItemPerformance` are reused unmodified. Analytics is
untouched and reads the identical number it always did. No detector, no insight
type, no UI, no cost-capture flow, no accounting connector.

### The rule the whole milestone turns on

**A missing cost is never zero, and an unknown profit is never $0.**

`getProfitSummary` honestly returns `0` when no order has a known cost, because
it summed nothing. Passing that straight through as "you made $0" would state a
fact we do not have — and would report a candle business as pure profit. So
`profitInCents` is **null** at zero coverage, and a product with no recorded
cost has a null margin that cannot be read as free.

### Two questions, two shapes, deliberately

"What did I keep overall?" is answered by `getProfitSummary` verbatim — the same
number the owner sees on Analytics, so J4 can never contradict their own
dashboard. "What do I make on this product?" is answered as **unit economics**
(price, cost, what you keep per sale), never as a rival per-product total.

This corrects the acceptance criterion originally proposed ("store-level and
per-product answers agree"). They genuinely cannot: `getProfitSummary` reads
Order rows all-time and counts a refunded order's amount as revenue, while
`getItemPerformance` reads canonical transactions net of refunds over a window.
Reconciling them would mean changing `getProfitSummary`, which would change
Analytics. Publishing one total and one per-unit view means there is no second
total to contradict the first — proved by T6, which asserts no per-product row
carries a profit field at all.

### Honest by construction

- Cost never leaks between products, never comes from price, never from category (T5).
- Selling below cost reports a real negative number rather than being floored at zero (T8).
- A free product yields a null ratio rather than Infinity, while its real loss is still reported (T7).
- J4 is told not to raise profitability unprompted and never to ask the owner to
  go enter missing costs — per Sean's decision, the honest-null discipline holds
  and nagging does not.

---

## 11. M6 — J4 understands obligations, not just income

**Status: IMPLEMENTED. Acceptance suite 33/33; M1 (11/11), M2 (34/34), M3
(31/31), M4 (28/28) and M5 (34/34) still passing. Typecheck and lint clean.**

### The gap it closed

`Order` already carried `fulfillmentStatus`, `fulfilledAt`, `carrier`,
`trackingNumber` and `createdAt`, and `getFulfillmentBreakdown` already counted
fulfilled vs unfulfilled — for the Analytics page, its only caller.

None of it reached J4. `mapOrdersToTransactions` sets `status: order.status`,
which is **payment** state on a different axis entirely, so the canonical
transaction J4 sees says money arrived and never says whether anything shipped.
An owner asking "does anyone need a package?" got nothing while the `Order` row
held the tracking number.

### What it does

| File | Change |
|---|---|
| `lib/businessModel/obligations.ts` | New. `planObligations` (pure) and `getObligations`. |
| `lib/businessModel/profile.ts` | One field on `BusinessProfile`. |
| `lib/dashboard/storeChatUnified.ts` | One paragraph holding the four distinctions apart. |

`getFulfillmentBreakdown` is reused unmodified; Analytics, the Orders UI, the
connector architecture and M1–M5 are untouched (verified as zero-line diffs).

### Four facts that look alike and are not

```
status: "paid"        money arrived
status: "refunded"    money went back — no package is owed
fulfillmentStatus     the OWNER'S OWN RECORDED ACKNOWLEDGMENT, never
                      evidence that anything physically shipped
trackingNumber        a real label was bought with real money — not
                      delivery, and not the same as marked fulfilled
```

They are separate fields and none is derived from another. J4 is instructed to
say *"you haven't marked this fulfilled"*, never *"you haven't shipped this"* —
the owner may well have posted it on Tuesday and not told Genesis. An order can
carry a label **and still be outstanding**, and that combination is named
plainly rather than resolved in either direction (T5).

### Bucketing that cannot silently drop an order

Every unfulfilled order lands in exactly one of `outstanding` (paid),
`refundedUnfulfilledCount`, or `otherUnfulfilledCount` — and T3 asserts the
three sum to `getFulfillmentBreakdown`'s own `unfulfilledCount`. An unpaid order
is not an obligation, and a payment status this module has never seen is named
rather than assumed.

### No threshold, by design

Age is raw days. T8 asserts no judgment word ("late", "overdue", "urgent",
"delayed") appears in any value or field name. A 45-day wait and a 1-day wait
differ only by number; J4 judges them in conversation, because shipping norms
differ by business and a threshold is a detector wearing a different hat.

`oldestWaitingDays` is null when nothing is outstanding — not 0, which would
read as "shipped today" — and empty means "nothing is waiting on you", never
"everything has shipped", which the data cannot support.

### Privacy

`shippingAddress` is never selected from the database at all. T6 pins the
outstanding-order field set to exactly buyerEmail, productName, orderedAt,
daysWaiting, labelPurchased and carrier, and asserts nothing address-shaped
appears anywhere in the serialized output.

---

## Live database verification — done (2026-08-21)

`scripts/verify-business-memory-live.ts` is the consolidated live pass, focused
on the property the layer turns on rather than re-testing arithmetic that is
already pure and proved: **facts → events → insights → recommendations →
observations → beliefs**, with Belief as the persistent understanding layer and
never a second source of truth.

What it proves against real Postgres: an owner's economics answer becomes exactly
one `BusinessEvent`, idempotent per execution and pointed at the owned record;
the three kinds of answer stay three different facts; adoption reaches the
pipeline too, inside the same transaction as the product; repeated evidence
distils into a `Belief` whose `evidenceRefs` are all real rows; `recordId` and
`entityType` survive re-derivation and are read back by `getEntityHistory`; no
ungrounded belief can exist; no supplier figure reaches a belief; and one
business never learns another's lesson.

**One external boundary found and recorded rather than worked around:**
`runIntelligenceCycle` ends with the AI recommendation stage, so a harness with
no provider credentials cannot complete a pass. What that proves anyway is the
property worth having — **Learn runs before Reason and unconditionally, so a
business's memory does not depend on an AI provider being reachable.** The
beliefs asserted there were distilled during a pass that then failed.

### The reads — done (2026-08-21)

`scripts/verify-bi-reads-live.ts` closes the three that were left, against real
Postgres. Its subject is deliberately narrow: the **reads**, never the
arithmetic, which the M2, M5 and M6 suites already prove pure.

**The backfill, as an operator would run it.** Six `ApprovalRequest` rows
covering every branch, and the dry run is asserted on *every field of every
row* rather than on `topicKey` alone — a dry run that wrote anything at all is
a dry run that lied, and which field it touched is not knowable in advance.
`--apply` writes the two derivable keys, leaves the bookkeeping action, the
unmapped action and the empty `update_product` null, and does not overwrite a
hand-authored key. Re-running writes nothing.

**A refunded order is a loss, not revenue.** Four orders where every wrong
reading lands on a different number, so the expected value discriminates rather
than merely matching: the correct answer is **-100**, refund-as-revenue gives
+3,900, refund-excluded-entirely gives +2,500, and unknown-cost-as-zero gives
+2,200. Both wrong readings were **executed as negative controls** and produced
exactly +3,900 and +2,200 — the suite fails when it should.

**An unknown cost is an exclusion.** A store with nothing costed returns
`null`, never `0`: zero reads as "broke even", which is a claim nobody made.

**The address stays out.** Every obligations fixture carries a real shipping
address in the row, and the assertion is that no part of it appears anywhere in
the serialized answer — not that `shippingAddress` is absent from the `select`,
which is readable from the source and proves nothing about what came back.
Real `status` values bucket as designed: paid+unfulfilled is owed, refunded is
counted apart, and an unrecognised status is counted and **named**, never
assumed owed.

### The original list, for the record

Every milestone below was proved at the logic level and **none had been exercised
against a live database**. Recorded together here, to be handled in one
consolidated pass alongside connector authentication, per Sean's decision.

| Milestone | What remained unverified | Now |
|---|---|---|
| M1 | `scripts/verify-intelligence-cycle.ts` — store selection, cursor advance and non-reprocessing against real rows | **Verified** — passes in `run-db-suites`, and `verify-business-memory-live.ts` proves Learn runs live |
| M2 | `scripts/backfill-topic-keys.ts` — dry run and `--apply`, never executed | **Verified** — `verify-bi-reads-live.ts` §1, both modes |
| M3 | Real `BusinessEvent` emission from a real execution, and its Prisma dedupe query | **Verified** — `verify-business-memory-live.ts` §§1–4 |
| M4 | `detectStorefrontReadiness` against a real store, and the observation lifecycle | **Verified** — `verify-readiness-lifecycle-live.ts` covers the full lifecycle: raise, keep-saying, resolve, recur with the same row identity, and stop when the finding stops being true |
| M5 | `getProfitability`'s reads, and real cost coverage on production products | **Verified against real rows** — `verify-bi-reads-live.ts` §2. Coverage *on production data* is a separate, still-open question |
| M6 | `getObligations`' reads, and which real `Order.status` values actually occur | **Verified against real rows** — `verify-bi-reads-live.ts` §3. Which statuses occur *in production* is still unmeasured |

Two things that table must not be read as claiming. **No production backfill has
been run** — `--apply` is proved against a throwaway database, not against
Sean's own store. And the M5/M6 rows prove the reads, not production coverage:
whether any real order carries `shippingCostInCents` is still unknown, and stays
honestly unknown rather than assumed.

---

## 12. M7 — what an order actually costs to fulfil

**Status: IMPLEMENTED. Acceptance suite 32/32; M1 (11/11), M2 (34/34), M3
(31/31), M4 (28/28), M5 (34/34) and M6 (33/33) still passing. Typecheck and lint
clean.**

### The gap it closed

`Order.shippingCostInCents` is written by a real EasyPost label purchase — real
money, spent through Genesis — and was read by **nothing**. Not Analytics, not
`getProfitSummary`, not J4.

```
Cedar Candle          $32.00
product cost         −$18.00
USPS label           −$12.00   ← recorded, and ignored everywhere
                      ───────
M5 reported:          +$14.00
Reality:               +$2.00
```

A 7× overstatement on a number already in the row, and the number an owner
prices from.

### What it does

| File | Change |
|---|---|
| `lib/businessModel/profitability.ts` | `planNetOfPostage` (pure), a `netOfPostage` block, three per-product fields, and one order read in `getProfitability`. |
| `lib/dashboard/storeChatUnified.ts` | One paragraph keeping the two figures apart. |

`getProfitSummary`, the Analytics page, `shipping.ts` and M6 are **untouched** —
verified as zero-line diffs. The order read lives in `getProfitability`, not in
`getProfitSummary`, which is what keeps Analytics identical.

`planProfitability`'s new `orders` parameter is optional, so M5's own shape and
behaviour are unchanged when it is absent — M5's suite passes unmodified (T7).

### One variable changes, deliberately

M7 uses the same order basis M5 uses and subtracts recorded postage, so
**net = M5's profit − postage** whenever coverage is complete — asserted
directly by T6. That makes the gap between the two numbers explainable to an
owner in one sentence.

It also means M7 knowingly inherits one quirk of `getProfitSummary`: a refunded
order's amount still counts as revenue. Correcting that here would make M7
differ from M5 in two ways at once and leave nobody able to explain the
difference. It is inherited deliberately, stated plainly, and left for whoever
revisits refund handling as its own change.

### Nothing is estimated

An order contributes only when **both** its product cost and a real postage
charge were recorded. T4 covers the most tempting wrong answer: two orders of
the same product, one with a $12 label and one without — the second stays out,
at both store and product level. T2 asserts free shipping is never assumed. A
missing postage cost is an exclusion, never a zero.

Payment-processor fees appear nowhere (T9), because Genesis does not store them
— and J4 is told to say so rather than imply the figure is final.

### Naming, and a test that earned its keep

The figure is `profitAfterRecordedCostsInCents`, never "net profit", and the
block carries a `PROFIT_BASIS` string in the data itself — "after recorded
product costs and recorded postage; excludes payment-processing fees and every
other unrecorded expense" — because a number whose scope lives only in prose
gets quoted without its scope (T11).

The per-product field is named `keptAfterRecordedCostsInCents` rather than
"profit". **M5's own T6 caught the first naming**: it guarantees no per-product
field reads as a profit total, so the store-level figure stays the only total.
The M5 test was left exactly as written and the M7 field was renamed — the test
did precisely the job it was written for.

T10 proves M5's path is untouched behaviourally, not just textually: the
`profitSummary` handed in is frozen, asserted unmutated, and the resulting store
block is compared against `summarizeMarginCoverage` computed independently from
the same input with no M7 data involved.

### Live verification — the read done, production coverage still open

`getProfitability`'s `Order` read is **verified against real rows**
(`verify-bi-reads-live.ts` §2): postage is counted for every order that recorded
a label, including the refunded one and the one whose product cost is unknown,
because that money was spent either way.

What is still open is a different question, and it stays open: **whether any
production order has `shippingCostInCents` recorded at all is unknown.**
Coverage may legitimately be "none" until a real label is bought, and "none" is
the honest answer the code already gives rather than a gap to be filled.

---

## 13. M8 — J4 can see interest, not just purchases

**Status: IMPLEMENTED. Acceptance suite 29/29; M1–M7 all still passing (251
assertions across eight suites). Typecheck and lint clean.**

### The gap it closed

`NewsletterSignup` is written by the **live storefront**
(`app/store/[slug]/actions.ts`) — a real stranger typing their email into a real
store — and was read by exactly one dashboard page. It reached neither
`BusinessProfile` nor the chat payload.

And contacts are derived from **orders only** (`deriveContactsFromOrders`), so
J4's entire notion of "customer" is built from purchases. Someone who gave the
business their email but hadn't bought did not exist in J4's understanding at
all.

For a pre-revenue store that is not a minor omission. A signup is the only
evidence a real stranger wanted something. J4 looking at 14 subscribers and no
sales could only say "you have no customers" — true, and deeply misleading.

### What it does

| File | Change |
|---|---|
| `lib/businessModel/audience.ts` | New. `planAudience` (pure) and `getAudience`. |
| `lib/businessModel/profile.ts` | One field on `BusinessProfile`. |
| `lib/dashboard/storeChatUnified.ts` | One paragraph keeping subscribers apart from customers. |

M8's entire footprint is those three files plus its suite. The marketing page,
`internalMapper`, the storefront action, `getCustomerSegments`, `getTopContacts`
and M1–M7 are untouched.

### Counts and timestamps only

`createdAt` is the **only** column selected — no email address is read from the
database at all, so none can reach a prompt (T3 asserts the serialized output
contains no `@` and that no field could hold one). Per Sean's decision, and
because Genesis cannot email subscribers today anyway.

### Two rules the suite defends

**A subscriber is never a customer.** Nothing is merged into contact records,
counted toward revenue or orders, or fed into segments. T4 asserts no field
claims a purchase, order, revenue or spend.

**Zero signups is an absence of evidence, not evidence of no interest.** Every
field goes null and `daysSinceMostRecent` is null rather than 0 — 0 would read
as "someone signed up today" (T2). An owner told "no interest" by their own
business partner, on the strength of an empty table, is being handed a
conclusion the data cannot support.

### No rate, no threshold

Raw timestamps are handed over so J4 judges pace in conversation — four signups
in a week for a new store is a different situation from four in a year. T7
asserts a quiet store and a busy one are reported in exactly the same shape,
with no rate, growth or judgment field between them.

The timestamp list is capped at 20, newest first, while `subscriberCount` stays
the true total and `firstSignupAt` stays the true oldest — a bounded list must
never quietly become a wrong count (T6).

### Live database verification — done (2026-08-21)

`getAudience`'s read is **verified against real rows**
(`scripts/verify-audience-recall-live.ts`), including the property the narrow
`select` exists for: three real subscriber addresses are in the database and none
of them appears anywhere in the serialized answer. Emptiness is asserted as
emptiness — `daysSinceMostRecent` is `null`, never `0`, because "nobody has
signed up in 0 days" reads as "somebody signed up today". Two businesses, two
different counts, neither borrowing the other's.

---

## 14. M9 — J4 remembers what the owner told it

**Status: IMPLEMENTED. Acceptance suite 26/26; M1–M8 all still passing (277
assertions across nine suites). Typecheck clean; M9 adds no lint warnings.**

### The gap it closed

Every read of `StoreMessage` in the codebase was a recency window — five call
sites, all `orderBy createdAt desc, take N`, with the chat window at 50. There
was **no search over conversation history anywhere**. Anything the owner said
more than fifty messages ago was unreachable forever, while sitting in the
database.

And `capture_business_fact` only accepts goal, challenge, employee and location,
so "my wax supplier raised prices 12% in June" had no home either: not a goal,
not a challenge, and gone from the window within a week of normal use.

**This was Gap D's twin, unclosed.** The rule set then — "topic/context
searchable rather than constrained by a fixed time window… keep recency as a
ranking signal, not a hard cutoff" — was applied to decisions and never extended
to the conversation those decisions came out of.

### What it does

| File | Change |
|---|---|
| `lib/businessModel/conversationRecall.ts` | New. `rankStatements` (pure) and `findRelevantMessages`. |
| `app/api/chat/route.ts` | One call, one payload key. |
| `app/dashboard/ai-actions.ts` | The same, so both paths recall identically (Gap B's rule). |
| `lib/dashboard/storeChatUnified.ts` | One paragraph on quoting the owner's own words. |

**Zero changes to `reasoning.ts` or decision recall.** The tokeniser is
independent by design: `reasoning.ts`'s own is private and its stopword list is
tuned for decision phrasing.

Deterministic throughout — no embeddings, no model classification, no
summarisation, no new entity type, no detector, no UI.

### The two decisions, as built

**Owner messages only.** The query filters on `role: "user"`, exported as
`OWNER_MESSAGE_ROLE` and asserted by the suite. T4 makes the point sharply: the
scorer has no notion of role and would happily score J4's own words if handed
them — which is exactly why the filter is load-bearing rather than incidental.

**Verbatim recall.** Text is returned byte-identical: not trimmed, not
truncated, not tidied. T5 asserts leading and trailing whitespace survive.
Quoting someone's own sentence back to them is the whole value; a paraphrase at
the retrieval layer would launder what they actually said.

### A real bug the suite caught

The first stopword list omitted auxiliaries, so *"what **did** my wax supplier
do about prices"* matched *"What **did** I make last week?"* at relevance 0.25 —
a confident recall of something entirely unrelated. `reasoning.ts` strips those
for the same reason; this list simply had not. Exactly the failure mode T2
exists to prevent, caught before it ever reached a prompt.

### Live database verification — done (2026-08-21)

`findRelevantMessages`' read is **verified against real rows**
(`scripts/verify-audience-recall-live.ts`). A statement made 200 days ago is
still recalled, which is the unbounded recall this milestone exists for; an
unrelated question recalls nothing rather than the newest message dressed up as
an answer; and J4's own reply sitting one day after the owner's decision is never
quoted back as the owner's words, because the read takes only their messages.
One business never remembers another's conversation, including concurrently.

---

## 17. Slice 1b — the cheap evaluation stops paying for the expensive one (2026-09-02)

**Written before implementing, as the boundary check.**

### What the first production tick measured

`intelligence.cycles` ran 209,067ms. **206,390ms of it — 98.7% — was six
`cognitive_review` calls to claude-opus-4-8**, 28.9s to 38.9s each, $0.9145 for
the tick. Everything else — five deterministic stages across seven stores —
cost **~2,677ms, about 380ms per store**.

So the cadence problem was never throughput. Sixteen stores of deterministic
evaluation is about six seconds of work. What does not fit in a daily
invocation is sixteen Opus reviews.

### The boundary

| Task | Lane | Stages | Stamps `lastIntelligenceAt` |
|---|---|---|---|
| `intelligence.cycles` | recompute | insights, notify, learn, staff_policy_gap, speak | **yes**, on full success |
| `intelligence.aiReview` | outbound | the existing `runOpportunisticAiReviewIfStale`, then speak | **never** |

`outbound` is deliberate and is not a new idea: it is already defined as the
lane for work that "makes third-party calls on its own initiative" and that "an
invocation running out of time should lose before it loses a customer's
receipt". A 34-second, 15-cent model call is exactly that. It also puts the
whole maintenance lane — including the `ops.alerts` watchdog — ahead of it.

### The state transitions, and why they cannot duplicate anything

1. **Deterministic pass completes** -> `lastIntelligenceAt` advances. No AI
   review is required for it to advance, which is the whole point.
2. **Any deterministic stage fails** -> no stamp, store stays due, retried.
3. **AI review succeeds or fails** -> `lastIntelligenceAt` is untouched. A
   review failure can no longer erase a good deterministic evaluation, and a
   review success can no longer be what makes one "count".
4. **AI review due-ness comes from `ExecutionLog`**, unchanged: the last SUCCESS
   of `genesis.recommendations.generate` older than `STALE_REVIEW_MS`, or none.
   **No `lastAiReviewAt` column is added** — the audit found the existing
   evidence sufficient, and a second timestamp would be a second answer to a
   question already answered.

**No duplicate reviews.** Three independent guards, all pre-existing: the outer
selection, the 24h gate inside `runOpportunisticAiReviewIfStale`, and the
5-minute PENDING claim against a concurrent run. The gate stays inside the
function, so even a wrong selection cannot produce a second review.

**No duplicate findings.** Observations still upsert on `(storeId, dedupeKey)`,
`observationFromReview` is unchanged, and `resolveMissingObservations` is still
scoped to `AI_REVIEW_PREFIX`. Nothing about the recommendation or observation
lifecycle moves.

**No duplicate speech.** `speakNewFindings` only speaks a finding with no open
`ProactiveDelivery`. It runs at the end of both tasks — which preserves today's
behaviour, where a review's findings are spoken in the same pass that produced
them — and running it twice says nothing twice.

### What is deliberately NOT changed

The six stages keep their implementations, their order relative to each other,
and their failure semantics. This is a scheduler and lifecycle separation. No
intelligence logic is redesigned, no detector is added, and no threshold moves.

---

## 16. Slice 1 — the engine is woken reliably (2026-09-02)

**Scoped, not yet built when this was written.** The audit that produced it found
that sections 1-14 are substantially correct: the lifecycle exists. What does not
happen is it RUNNING.

### The two findings

**The cycle task was starved by the scheduler.** `intelligence.cycles` had no
recorded run while eleven other tasks ran the same day. Not specific to it: see
ARCHITECTURE.md's *a scheduled task declares its minimum, not its worst case*
for the general defect and the fix. `sourcing.discovery` was the second victim
and the arithmetic predicted both before production confirmed them.

**Nothing makes a quiet business due.** `getStoresDueForIntelligence` selects on
unconsumed `BusinessEvent` activity, and every writer of that table is
action-originated — a connector sync that returned changes, an execution, a
sale, a product adoption. Time alone produces no event, so a store whose data
has not moved is never re-evaluated. At audit time `storesDueNow` was 0 across
all 16 production stores, the newest connector-sourced event was a month old,
and 54 of 95 ACTIVE observations had not been re-confirmed in over 14 days —
J4 was showing owners findings it had not checked, and could not retract them
because the thing that would retract them does not run.

### What Slice 1 does, and what it deliberately does not

It makes the scheduler capable of running the cycle, and makes elapsed time a
reason for a store to be due. `Store.lastIntelligenceAt` and its exact
semantics are recorded in ARCHITECTURE.md rather than here, because the field
is a fact about a Store and outlives this milestone.

It does NOT make the time-based detectors independent of connector syncs. That
is Slice 2, approved in principle and deliberately not started: establishing
that the scheduler can wake J4 reliably comes first, because a new detector
that nothing runs is worth nothing.

It does NOT touch observation identity or resolution semantics, and it does not
clean up the six legacy `GenesisObservation` rows whose `dedupeKey` carries no
sweep prefix (two are raw cuids) and which therefore no current sweep can ever
resolve. Those are recorded as cleanup debt, last confirmed 2026-07-27 to
07-30, and are left alone.

**`sourcing.discovery` is explicitly disabled by this slice.** It was
`enabled: always` and never ran, because it declares the entire invocation
budget and something always runs before it. Fixing the scheduler would have
started it — the only task that makes third-party calls on its own initiative —
as a side effect of unrelated work. Preserving its OBSERVED behaviour therefore
required changing its DECLARED state, and that is stated here rather than
slipped in. Turning it on is its own decision, with its own review.

---

## 15. The milestone, closed (2026-08-21)

**Status: COMPLETE within the approved scope.** Closed at `66078f1`, after four
approved increments. This section is the acceptance record; the sections above
are the design, and none of them is superseded.

### What is complete and verified

| | Evidence |
|---|---|
| Discovery and the economics refresh run unattended | A fifth stage on the existing scheduler (`app/api/cron/sync/route.ts`), `verify-sourcing-schedule.ts` |
| A real ceiling on supplier cost | `lib/sourcing/sourcingBudget.ts`, `verify-sourcing-budget.ts` — refused *before* the request, so a stopped pass writes nothing partial |
| Belief as persistent business memory | `verify-business-memory-live.ts` — grounded beliefs, real `evidenceRefs`, record identity surviving re-derivation |
| Real `BusinessEvent` emission and its dedupe | `verify-business-memory-live.ts` §§1–4 — one event per execution, idempotent, pointed at the owned record |
| The three BI reads | `verify-bi-reads-live.ts` — 37 assertions against real Postgres |
| Regression, typecheck, build | `verify-regressions.ts` ALL PASS; `tsc --noEmit` 0 errors; `next build` compiled |
| The database-backed harness | `run-db-suites.ts` 13/13 |

### What remains open — and stays open

These are **recorded, not scheduled**. None of them is a gap to be closed by
expanding this milestone, and a future contributor should not treat this list as
a to-do that authorises new scope.

- ~~**M4's observation lifecycle is unasserted.**~~ **Closed 2026-08-21** —
  `verify-readiness-lifecycle-live.ts`. The lifecycle turned out to be subtler
  than "raise once, do not repeat": a standing finding **keeps** being produced
  for as long as it is true, because `notifyFromInsights` resolves anything
  missing from the current set. Suppressing a still-true finding as "already
  said" would silently retract it the very next cycle. The suite asserts both
  halves, including that an empty cycle really does resolve it.
- **M5 and M6 are verified as reads, not as production coverage.** Whether any
  real order carries `shippingCostInCents`, and which `Order.status` values
  actually occur in production, are both still unmeasured — and stay honestly
  unknown rather than assumed.
- ~~**M8 and M9 are open.**~~ **Closed 2026-08-21** —
  `scripts/verify-audience-recall-live.ts` exercises both reads against real
  rows, across two businesses, with the privacy property each was written for.
- **No production backfill has been run.** `backfill-topic-keys.ts --apply` is
  proved against a throwaway database only.

### Externally blocked

**The Printful live-API check**, unchanged and unweakened.
`scripts/check-printful-economics-live.ts` remains the legitimate read-only
path. Per Sean's explicit instruction, the blocker is not to be worked around by
weakening production credential encryption, creating fake production data, or
adopting a Printful product to manufacture a passing test.

### Two harness facts worth not rediscovering

**`PGLiteSocketServer.maxConnections` defaults to 1.** Three suites were
recorded here for months as an unfixable PGlite limitation; the real cause was
the server refusing the second pooled client, and the error — "Server has closed
the connection" — names whichever query happened to be second, never the pool
that opened it. Production was never involved.

**Two suites this harness cannot honestly run** are excluded and named rather
than left failing: `verify-stripe-webhook-e2e` (needs a running Next server) and
`verify-catalog-browser` (brings its own Postgres and server, must run
unelevated). Both have their own documented entry points.

### One thing this document must keep saying

Nothing in this milestone converts an absence into a value. A missing cost is an
exclusion, never a zero; a store with nothing costed reports `null`, never "broke
even"; an unrecognised order status is counted and **named**, never assumed to be
an obligation. The suites assert those three sentences directly, and the
profitability fixture is built so that every wrong reading lands on a different
number rather than on a missing one.
