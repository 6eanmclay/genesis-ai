# J4's Understanding of a Business — architectural proposal

**Status: PROPOSAL. Nothing implemented.** 2026-08-24. No API credit, no live
model, no schema change, no production code.

Traced from the repository at `49fbb6e`, after One Canonical Understanding
closed. **That milestone is not reopened.** It solved *assembly*. This proposal
is about what is assembled.

The question it answers precisely:

> **What does J4 actually understand about a business?**

Today the honest answer is: **it depends which door the question came through.**

---

## 1. Current state — what J4 understands, and where it lives

### 1.1 Durable storage: 46 models, five roles

| Role | Models | Provenance? |
|---|---|---|
| **What the business IS** | `BusinessRecord` (17 entity types), `RecordRelationship`, `Store` (66 fields), `Product`, `ProductImage`, `SourcedProduct`, `SupplierEconomics` | **`BusinessRecord` only** |
| **What HAPPENED** | `BusinessEvent` (+`Cursor`), `ProductEvent`, `ExecutionLog`, `Order`, `PostExecutionMeasurement` | n/a — events carry their own source |
| **What J4 CONCLUDED** | `Belief`, `CognitiveOutput`, `GeneratedRecommendation`, `GenesisObservation` | confidence/evidence, not provenance |
| **What J4 PROPOSED or DID** | `ApprovalRequest`, `DelegatedAuthority`, `Task`, `ProactiveDelivery` | n/a |
| **The relationship with the platform** | `Plan`, `GrowthPointTransaction`, `AiUsageEvent`, `Referral` | n/a |

**This five-way split is sound and should be preserved.** It is the strongest
thing in the current model: facts, history, inference, intent and platform are
genuinely different kinds of thing and are already stored as such.

### 1.2 Business identity is split across three shapes, and only one has provenance

| Shape | Holds | Provenance fields |
|---|---|---|
| `BusinessRecord` | 17 entity types | **5** — `provenance`, `provenanceDetail`, `statedAt`, `statedById`, `modelExtracted` |
| `Store` columns | 12 identity/brand fields — `name`, `description`, `tagline`, `logoUrl`, `businessCategories`, `revenueStreams`, `brandPositioning`, `priorityAudience`, … | **0** |
| `Store.blueprint` JSON | 5 sections — `brandIdentity`, `homepageContent`, `storeContent`, `marketingAssets`, `designDirection` | **0** |

So the Business Fact Lifecycle — correction, supersession, history, OWNER
provenance — **covers one of the three places business identity lives.** A
business's `description` and its entire `brandIdentity` cannot be corrected,
superseded, attributed, or dated.

### 1.3 The blueprint has no single declared shape

`Store.blueprint` is `Json?`. Across the codebase it is cast to a locally
declared type in **13 files**:

- `BlueprintShape` — declared **10 times**, each a different partial view
- `Blueprint` — 2 more
- `BlueprintContextSubset` — 1 more

Each declaration ends `[key: string]: unknown`, so none constrains anything and
none knows about the others. **One JSON column, thirteen private opinions of its
shape.**

### 1.4 The expression problem — four "here is the business" payloads

Assembly is now canonical. **Expression is not.** Four distinct, hand-assembled
descriptions of the business reach a model, each with a different field
selection:

| # | Payload | Where | For |
|---|---|---|---|
| 1 | `renderDigest(digest)` | `chatTurnContext.ts:75` | routing |
| 2 | `payload` | `toolHandlers.ts:2071` | answering a data question |
| 3 | `contextForPrompt` | `cognitiveLayer.ts:471` | proactive reasoning |
| 4 | `currentStateForPrompt` | `ai-actions.ts:1289` | the content pipeline |

None derives from a declared shape. **Of 20 prompt-bearing files that inject
business facts, 8 use the canonical understanding and 12 read their own.**

This is the exact shape of the problem the last milestone solved, one layer up:
we fixed *assembling* the understanding four times and left *describing* it four
times.

### 1.5 Temporal understanding exists and is barely used

`BusinessEvent` is a real event log — `occurredAt`, monotonic `sequence`,
`processedAt` cursor, `recordId` linkage, `sourceProvider`. `BusinessRecord`
separates `statedAt` (when the source asserted it) from `syncedAt` (when we
wrote it). The Fact Lifecycle adds supersession, so "what did they used to sell"
is answerable.

**What consumes it:** the Insight Engine reads unprocessed events; the briefing
reads a window. **The canonical understanding carries no history at all** — it is
a snapshot with no "as of", no "what changed", no "how long has this been true".

### 1.6 Relationships: 8 kinds written, 1 read

`belongs_to`, `involves`, `located_at`, `blocks`, `supersedes`, `derived_from`,
`supplies`, `about` are projected on every sync from 9 entity types.
**`relationsByKind(storeId, "blocks")` is the only read in the codebase.**

### 1.7 Three entity types reach nothing

`transaction`, `design`, `shipment` are written by connectors or generators and
read by no consumer. A synced QuickBooks transaction is stored and never looked
at again.

---

## 2. What is canonical vs provider-derived vs presentation

Settled by the closed contract and unchanged here:

| | |
|---|---|
| **Canonical** | `getBusinessUnderstanding` — the one assembler. Identity, classification, offerings, revenue, customers, people, suppliers, connected systems and summaries, goals, challenges, assets, beliefs, decisions, commitments, blocked goals, active thoughts, platform relationship |
| **Provider-derived** | `getRevenue`, `computeInsights`, `getCustomerSegments`, `currentFacts`, … — they compute facts and may read the database freely |
| **Presentation** | A surface rendering one section, via `declaredRead("presentation", …)` |
| **Windowed** | A reasoning consumer needing a window the canon does not carry, via `declaredRead("windowed", …)` |

---

## 3. Proposed J4 Foundation model

**Reuse first.** Everything below is a promotion or a consolidation of something
that already exists. Nothing new is invented where something works.

### 3.1 The five layers, named

Already true in storage; not yet named in code:

```
FACTS        what is true of the business, and who says so
HISTORY      what happened, when, in order
INFERENCE    what J4 concluded, and how strongly
INTENT       what was proposed, approved, delegated, done
PLATFORM     the business's relationship with Genesis
```

**The reasoning boundary this draws:** a consumer may read facts and history
freely; it may read inference only alongside its confidence; it may never
present an inference as a fact. That rule exists in prose today
(`RecordProvenance`'s own comments) and in no type.

### 3.2 One declared shape for business identity

**Reuse `ENTITY_REGISTRY`.** The blueprint's five sections and the `Store`
identity columns become declared, schema-validated shapes rather than 13 local
casts — with the open question of whether they become entity types (gaining
provenance and lifecycle for free) or a validated `Blueprint` schema beside them.
**That is decision D1 below.**

### 3.3 One declared expression

**A single `BusinessContext` shape** — derived from the canonical understanding —
that every prompt-bearing consumer renders from. Consumers may select *less*;
none may hand-assemble its own field list.

The digest already proves the pattern: `UnderstandingDigest` is a declared
interface with `renderDigest`. This generalises it, and the four payloads become
four *selections* of one shape.

### 3.4 Temporal: the understanding gains an "as of"

`BusinessEvent` already carries everything needed. The canonical understanding
should carry, at minimum: **when it was assembled**, and **the sequence high-water
mark it reflects**. That is what lets a later consumer ask "what changed since"
without inventing its own cursor — and it is a precondition for the BI engine
rather than part of it.

---

## 4. Scope boundaries

### In

1. Name the five layers in code, with the reasoning boundary as a type.
2. One declared shape for business identity (per D1).
3. One declared `BusinessContext` expression; the four payloads become selections.
4. An `asOf` + event high-water mark on the canonical understanding.

### Out, explicitly

- **The Business Intelligence Engine.** This milestone gives it a model to reason
  over; it does not reason.
- **Reconciliation.** Already its own future contract (U4/U5).
- **Making J4 smarter.** No new detectors, beliefs, or proactive behaviour.
- **The relationship graph's 7 unread kinds** — see D4.
- **`transaction`/`design`/`shipment`** — see D4.
- **One Canonical Understanding, Verification Hardening, Business Fact
  Lifecycle.** Closed.
- **Any schema change** unless D1 requires one, which stops for approval.

---

## 5. Unresolved decisions — require approval

### D1 — Does business identity become entity types, or a validated blueprint?

**Evidence:** identity lives in 12 `Store` columns and 5 blueprint JSON sections,
neither with provenance; `BusinessRecord` has the whole lifecycle already.

| Option | Consequence |
|---|---|
| **Promote to entity types** | `description`, `brandIdentity` etc. gain provenance, correction, supersession and history for free. Cost: a real migration, and the storefront reads them on every render — a hot path now going through records |
| **Validate the blueprint in place** | One declared Zod shape replaces 13 casts. Cheap, no migration. Cost: identity still has no provenance and still cannot be corrected |
| Both, staged | Validate now, promote later. Cost: two changes to the same thing |

**No recommendation yet — this is the decision the milestone turns on**, and it
is genuinely a product question: *should an owner be able to correct the brand
story the way they can now correct what they sell?*

### D2 — Is the reasoning boundary enforced, or documented?

A type that makes "present an inference as a fact" impossible, versus a rule a
test asserts. **Evidence:** the codebase has done both before — `verify` required
by the compiler (enforced) versus the provenance-write discipline (asserted).

### D3 — Does `BusinessContext` replace the four payloads, or wrap them?

Replacing is honest and touches four call sites including the legacy content
pipeline. Wrapping is safer and leaves the field selections where they are.

### D4 — Do the unread relationships and unreached entity types come in scope?

7 relationship kinds and 3 entity types are written and never read.
**Recommendation: no** — they are capability ahead of use, and the BI engine is
the likely consumer. Naming them here without a consumer would be designing for
an imagined need.

### D5 — What does "supporting the BI engine" mean concretely?

Recommendation: exactly two things — **a declared model to reason over**, and **a
temporal anchor to reason from** (§3.4). Everything else is the engine.

---

## 6. Verification strategy

Following the pattern of the last three milestones: every gate paired with a
negative control that proves it can fail.

| Gate | Control |
|---|---|
| One declared shape for identity; no local blueprint casts remain | Reintroduce one; must fail |
| Every prompt-bearing consumer renders from `BusinessContext` | Hand-assemble a payload; must fail |
| The reasoning boundary holds — an inference cannot be rendered as a fact | Render one; must fail |
| The understanding carries `asOf` and a sequence mark | Remove it; must fail |
| Provenance unweakened | The existing suites |
| Fact Lifecycle untouched | `git diff` empty |
| Canonical assembly still singular | `verify-canonical-understanding` unchanged |

Plus: typecheck, **`npx next build` reported separately**, the shared runner, and
every own-infrastructure suite.

**Deterministic throughout. No live model required.**

---

## 7. What this deliberately does not claim

It does not make J4 smarter, and it should not be judged on whether J4 says
better things afterwards. It makes **what J4 knows** a declared, single,
provenance-bearing, time-anchored thing — so that the intelligence built on top
reasons from one model rather than four descriptions of one.
