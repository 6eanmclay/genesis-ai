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
casts. **D1 resolves this by role rather than by container**: the four fields J4
reasons from become entity types with provenance; the copy fields become a
validated `Blueprint` schema and stay configuration.

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

## 5. The five decisions — complete

Each carries the repository evidence, both options with real consequences, and a
recommendation. **D1 was left open in the first draft; it is answered here.**

---

### D1 — Does owner-editable identity become governed business fact?

**The question as posed:** should brand identity/story be a mutable business fact
with provenance, correction, supersession and history, the way `offering` now is?

#### The evidence changes the question

`brandIdentity` is one JSON blob holding **two different kinds of thing**, and
the split is visible in who reads them:

| Field | Read by | What it is |
|---|---|---|
| `brandStory` | `app/store/[slug]/page.tsx` — rendered as the storefront's "Our Story" section | **copy** |
| `missionStatement`, `visionStatement`, `brandPromise`, `coreValues` | the profile, shown back to the owner | copy, mostly |
| **`targetAudience`** | `cognitiveLayer.ts:476` | **a claim about the business** |
| **`brandPersonality`, `brandVoiceAndTone`** | `cognitiveLayer.ts:474-475`, `marketing/assets.ts:55` | **claims J4 reasons and generates from** |
| `uniqueSellingProposition` | `cognitiveLayer.ts:477` | **a claim about the business** |

Section-level counts make the same point: `homepageContent` has **30**
render-side references and is unambiguously presentation. `brandIdentity` has
**2**, and is mostly read to reason with.

**And the concept that matters most for reasoning has the least governance.**
"Who this business is for" exists only as `blueprint.brandIdentity.targetAudience`
— model-generated, reasoned over by the proactive layer, and uncorrectable.
Beside it sits `Store.priorityAudience`, a column **referenced by zero code**;
`getAudience()` is a different concept entirely (newsletter signup statistics).

#### Option A — identity becomes governed business data

**Consequences for understanding:** J4 could say *"you told me in March you sell
to gift buyers; your orders say otherwise"* — because the claim would have an
author and a date. Corrections would supersede rather than overwrite, so "who
they used to think their customer was" survives. `targetAudience` would join the
six owner-authoritative types and become correctable in conversation.

**Consequences for reasoning:** the proactive layer already reads
`targetAudience` to reason. Under A it would read it **with provenance** — able
to weigh "the owner stated this" differently from "a model generated it during
onboarding", which today it cannot distinguish at all.

**Consequences for memory:** identity gains history. Today a rebrand destroys the
previous positioning permanently.

**Costs, stated plainly:** a real migration. The storefront renders
`brandIdentity` on every page load, so a hot path would move from one JSON column
read to record reads. And **applied to the whole blob it is wrong** — `brandStory`
is page copy; giving it provenance and supersession is governance nobody needs.

#### Option B — identity stays blueprint configuration

**Consequences for understanding:** unchanged. J4 keeps reasoning from
`targetAudience` while being unable to say who claimed it, when, or whether the
owner ever agreed.

**Consequences for reasoning:** the reasoning boundary stays unenforceable for
these fields. A model-generated `targetAudience` and an owner-stated one are the
same string in the same blob — which is precisely the confusion the provenance
work was built to end, surviving in the one place it never reached.

**Consequences for memory:** none gained. A rebrand still destroys the previous
answer.

**Benefits:** cheap, no migration, no hot-path change, and it preserves a real
distinction — copy genuinely is configuration.

#### RECOMMENDATION — neither, and the evidence is why

**Split by role, not by container.** The container mixes facts and copy; deciding
per-container forces the wrong answer on half its contents either way.

| | Treatment |
|---|---|
| `targetAudience`, `brandPersonality`, `brandVoiceAndTone`, `uniqueSellingProposition` | **Option A.** Claims about the business that J4 already reasons from. They become owner-authoritative entity types with provenance, correction and history |
| `brandStory`, `missionStatement`, `visionStatement`, `brandPromise`, `coreValues` | **Option B.** Storefront and owner-facing copy. Editable, not governed. No provenance, no supersession |
| `homepageContent`, `storeContent`, `marketingAssets`, `designDirection` | **Option B**, unambiguously. 30 render references; this is presentation |

**Why this is not splitting the difference.** The test is the one the last two
milestones already established and that `insights.ts` was resolved by: *is the
owner the authoritative source, and does J4 reason from it?* `targetAudience`
passes both. `brandStory` passes neither — J4 does not reason from the story, it
renders it.

**What it costs:** four fields migrate, not a blob. The storefront's hot path is
untouched, because the storefront renders `brandStory` and the copy fields, which
stay exactly where they are.

**What it buys:** the answer to *"who is this business for"* gains an author, a
date, and a correction path — and the proactive layer that already reasons from
it can finally tell an owner's answer from a model's guess.

**A consequence worth stating rather than discovering:** this makes
`Store.priorityAudience` — a column no code references — either the home for the
migrated field or a dead column to be removed. **Removing it is a schema change
and is out of scope; it is named here and left alone.**

---

### D2 — Is the reasoning boundary enforced, or documented?

**Evidence.** This codebase has done both, deliberately. `verify` is a *required*
interface member so omission cannot compile (enforced). Provenance discipline at
write sites is asserted by suites, not by types (documented).

| Option | Consequence |
|---|---|
| **Enforced by type** | An inference cannot be rendered where a fact is expected. Strongest, and it reaches every future consumer for free. Cost: touches every payload shape |
| Documented + asserted | Cheap, and a new consumer can violate it until somebody notices |

**RECOMMEND: enforced**, and specifically at the `BusinessContext` boundary
(§3.3) rather than throughout — one shape, one place, every consumer inherits it.

---

### D3 — Does `BusinessContext` replace the four payloads, or wrap them?

| Option | Consequence |
|---|---|
| **Replace** | One declared expression; the four become selections. Touches four call sites, one of them the legacy content pipeline (`ARCHITECTURE.md:128`) |
| Wrap | Safer, and leaves four hand-assembled field lists in place — the problem renamed |

**RECOMMEND: replace, with one carve-out.** The content pipeline's
`currentStateForPrompt` describes a **draft** as well as a live store, and drafts
are not businesses yet. Replace the three reasoning payloads; leave the draft
path and say so.

---

### D4 — Do unread relationships and unreached entity types come in scope?

**Evidence.** 8 relationship kinds written on every sync, 1 read
(`relationsByKind(storeId, "blocks")`). 3 entity types — `transaction`, `design`,
`shipment` — read by nothing.

**RECOMMEND: no.** Capability ahead of use is not a defect, and the BI engine is
the likely consumer. Naming a shape for an imagined need is how the seven unread
kinds happened in the first place. **Left recorded, not scheduled.**

---

### D5 — What does "supporting the BI engine" mean concretely?

**RECOMMEND: exactly two things, and no more.**

1. **A declared model to reason over** — §3.1–3.3.
2. **A temporal anchor to reason from** — `asOf` plus the `BusinessEvent`
   sequence high-water mark the understanding reflects (§3.4).

Everything else is the engine. **If a proposed addition cannot be justified
without naming a specific intelligence feature, it belongs to that feature.**

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
