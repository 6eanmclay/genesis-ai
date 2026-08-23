# The draft-path field split — contract

**Status: CONTRACT CLOSED pending ONE confirmation (§6). Nothing implemented.**
2026-08-23. Sean's decisions of 2026-08-23 recorded in §0.

---

## 0. Decisions taken

| # | Decision | Status |
|---|---|---|
| 1 | Names are **`offering`** and **`intent`**. Not `productType`/`vision` — those are onboarding-field concepts and would blur source information against derived content. | **Approved** |
| 2 | **`offering` joins the business digest.** Implementation is in scope; *claiming it improves routing requires measurement afterward.* | **Approved** |
| 3 | Two nullable homes, **no backfill**. Null means "not known"; never infer historical values. | **Approved — but see §6** |
| 4 | **Both onboarding paths must be covered.** Do not invent values to eliminate nulls. | **Approved** |
| 5 | Full regression coverage, plus a separate validation case measuring whether `offering` changes J4's routing. Evidence, not assumption. | **Approved** |
| 6 | **Preserve the provenance distinction** — always be able to tell what the owner told us from what Genesis generated from it. | **Approved — and it changes §3** |

Definitions, fixed:

- **`offering`** — what the business sells or provides.
- **`intent`** — what the owner wants the business/brand to be or accomplish.
- **Owner intent → source information.**
- **`blueprint.brandIdentity.visionStatement` → derived storefront copy.**
- These are **not interchangeable and are never merged.**

---

## 1. What exists today, exactly

### 1a. `StoreDraft` — the owner's own words

| Field | Type | Set by | Required |
|---|---|---|---|
| `inputStoreName` | `String?` | CreateStoreForm | no |
| `inputProductType` | `String?` | CreateStoreForm | **no** |
| `inputVision` | `String?` | CreateStoreForm | **yes** ([ai-actions.ts:468](app/dashboard/ai-actions.ts#L468)) |

Owner-facing meaning, from the form: `inputProductType` → *"e.g. Performance gym
clothing"*; `inputVision` → *"Cozy rustic candle shop."*, labelled "your style,
audience, colors".

### 1b. `Store` — what survives confirmation

`name`, `description`, `tagline`, `businessCategories`, `revenueStreams`,
`brandPositioning`, `creativeDirection`. **No equivalent of either input.**

### 1c. Where the owner's answers are consumed

| Field | Consumed at | For what |
|---|---|---|
| all three inputs | [ai-actions.ts:519-523](app/dashboard/ai-actions.ts#L519) | the initial generation prompt, once |
| `inputProductType` + `inputVision` | [ai-actions.ts:4231](app/dashboard/ai-actions.ts#L4231) | `sourceHeroImageCandidate`, once at confirm, and only when `heroLayout === "split"` |
| `draft.description` | same line | **as a fallback for vision** — `inputVision ?? description ?? name` |

**That is the entire consumption.** After confirm they are unreachable.

### 1d. What J4 actually receives

[digest.ts:111-113](lib/businessModel/digest.ts#L111) carries `name`, `tagline`,
`categories[]`. **Not `description`, not `visionStatement`, nothing about what
the business sells.**

### 1e. The two onboarding paths are structurally different

[onboarding/actions.ts:70](app/onboarding/actions.ts#L70) and
[:100](app/onboarding/actions.ts#L100) create drafts as
`{ name: "New store", status: "onboarding_discovery" }` — **the experience-first
path sets neither input.** It builds an `ExperienceConcept` in `experienceState`
JSON: `productName`, `productDescription`, `businessModelSlug`,
`brandPositioning`, and a `CreativeDirectionOption`.

**Every one of those is generated copy, not an owner statement.** This matters in
§4.

---

## 2. The defect, stated once

> The owner answers two specific questions — what I sell, and what I want this to
> feel like. Both are used for one prompt and one image, then discarded. From
> confirmation onward every downstream reader sees only prose a model wrote, and
> the digest J4 reasons from does not carry even that.

---

## 3. Where the two facts live — REVISED BY DECISION 6

### 3.1 Why the Store-column shape does not satisfy decision 6

`Store.description`, `tagline`, `brandPositioning` and `businessCategories` carry
**no provenance of any kind**. A bare `Store.offering` column would be a fact
with no author, no stated-at, and no record of whether a model stood between the
owner and the value — in a codebase that shipped a provenance layer specifically
so that never happens again.

Decision 6 and decision 3 therefore pull against each other, and decision 6 is
the stronger requirement.

### 3.2 The mechanism that already exists

`BusinessRecord` carries the complete provenance vocabulary, shipped in the J4
Understanding milestone:

| Column | What it answers here |
|---|---|
| `provenance: OWNER` | the owner said it. Documented as *"authoritative about intent in a way nothing else is: only the owner knows what the owner is trying to do."* |
| `modelExtracted` | **whether a model stood between the owner and the value** — exactly the form-path / experience-path difference |
| `statedAt` | when the owner said it, distinct from when the row was written |
| `statedById` | which person said it |
| `provenanceDetail` | the concrete source — which onboarding path, which transcript |

And [entities.ts](lib/businessModel/entities.ts) states the extension contract
outright:

> *"Adding a new entity type later ... is a new entry here, nothing else: no
> change to BusinessRecord's Prisma model (already generic/JSON), the mapping
> contract, or reasoning.ts's core primitives."*

### 3.3 The recommendation

**`offering` and `intent` become two new entries in `ENTITY_REGISTRY`, not two
columns on `Store`.**

```
offering: { schema: OfferingSchema, label: "Offering" }
intent:   { schema: IntentSchema,   label: "Intent" }
```

Each is a singleton per store, using the existing
`@@unique([storeId, entityType, sourceProvider, externalId])` with a fixed
`externalId`. Schemas hold the owner's statement and nothing derived.

**What this buys, against the column shape:**

| | Store columns | Entity records |
|---|---|---|
| Migration | 2 new columns | **none** — registry entry only |
| Provenance (decision 6) | would need 6+ more columns to express | **already there** |
| Owner corrections | new mechanism | U4 owner-correctable beliefs already work |
| Provenance-aware reasoning | not wired | U6 already weighs OWNER vs INFERENCE |
| Null means "not known" | null column | **no row** — same meaning, no ambiguity |
| No backfill | satisfied | satisfied |

**This is the one item in §6 needing confirmation, because it reverses the
letter of decision 3 while serving decision 6.** Decision 3's substance — two
nullable homes, no backfill, null means not known — is preserved exactly.

### 3.4 What this must NOT duplicate

| Existing | Why `offering`/`intent` is not that |
|---|---|
| `brandIdentity.visionStatement` | **derived storefront copy**, model-written, for the store to *say*. `intent` is the **owner's instruction**, never rendered. |
| `businessCategories` / `revenueStreams` | closed-registry slugs for classification. `offering` is free text and never a filter key. |
| `Store.description` | the **public-facing** description. Unchanged by this. |
| `brandPositioning` | a positioning statement, already carried over. Unchanged. |
| `ExperienceConcept.productDescription` | one product's generated copy, not the business's offering. |

**Nothing is moved, rewritten, or deleted.**

---

## 4. How each path produces the two facts — DECISION 4

### 4a. Form path (`CreateStoreForm`)

| | Source | Provenance | `modelExtracted` |
|---|---|---|---|
| `offering` | `inputProductType` | `OWNER` | **`false`** — the owner's own typed words |
| `intent` | `inputVision` | `OWNER` | **`false`** |

`statedAt` = draft creation time. `statedById` = the confirming user.
`provenanceDetail` = `"onboarding_form"`.

**`inputProductType` is optional.** When the owner left it blank, **no `offering`
record is written.** Null is the honest answer and is not filled from
`description`, `name`, or the generated concept.

### 4b. Experience-first path

This path has **no owner-typed field at all** — it has a transcript and a
generated concept. They are not the same kind of thing, and only one of them is
admissible:

| Candidate source | Admissible? |
|---|---|
| `ExperienceConcept.productDescription` | **No.** Generated copy. Using it would be the exact error decision 6 forbids. |
| `CreativeDirectionOption.description` | **No.** Generated brand copy. |
| `experienceState.transcript` — the visitor's own turns | **Yes** — these are the owner's words. |

So: **`offering` and `intent` are distilled from the visitor's own transcript
turns, with `provenance: OWNER` and `modelExtracted: true`, `provenanceDetail`
naming the transcript.** That is precisely what `modelExtracted` exists to
record — *"a goal the owner typed and a goal a model distilled from a rambling
voice memo are both OWNER-provenance … but only one of them is the owner's own
words."*

**When the transcript does not actually contain a statement of what they sell or
what they want, no record is written.** A short conversation that jumped straight
to generation genuinely does not have this information, and inventing it from the
concept would launder generated copy into owner testimony.

### 4c. The rule both paths obey

> A record is written only when the owner asserted the thing. Generated content
> is never promoted into an owner-provenance record, on either path, under any
> fallback.

---

## 5. What changes downstream

| Consumer | Change |
|---|---|
| `ENTITY_REGISTRY` | two entries + two schemas |
| `confirmStoreDraftCore` | write the two records from the draft inputs |
| experience-first claim | distil from transcript, or write nothing |
| `profile.ts` `identity` | expose `offering` and `intent` **alongside** `description`, never merged into it |
| `digest.ts` | **add `offering`** (decision 2) |
| `sourceHeroImageCandidate` | read the records; **drop the `?? description ?? name` fallback chain**, which is what made vision and description interchangeable |
| `CONTEXT_TYPES` | **out of scope** — closed registry, a UI6 change |

### Explicitly out of scope

No change to `Store.description` or its generation. No change to `brandIdentity`
or the blueprint. No new onboarding questions. No backfill. No context-pane
entry. No change to `StoreDraft`'s three input columns.

---

## 6. Verification — DECISION 5

Every item below is a required assertion, each with a negative control.

**Carryover**
1. A draft with both inputs set, confirmed → **`offering` survives into the store's records**.
2. Same → **`intent` survives**.
3. Control: a draft with `inputProductType` null → **no `offering` record**, not a value derived from `description` or `name`.

**Consumers**
4. Both are available to `profile.ts` `identity`, and `description` is unchanged beside them.
5. **The digest includes `offering`** when a record exists.
6. Control: no record → the digest **omits** it rather than fabricating one from `description`.

**Data safety**
7. Null / no-record remains valid through `profile.ts`, `digest.ts` and the turn path.
8. **Existing stores are not backfilled** — a store whose draft predates this has no records and no invented ones.

**Both paths**
9. Experience-first onboarding does not lose the fields: a transcript containing the statements produces both records with `modelExtracted: true`.
10. Control: a transcript *without* them produces **no records**, and specifically does **not** source them from `ExperienceConcept.productDescription` or `creativeDirection.description`.

**Provenance (decision 6)**
11. Form path records assert `provenance: OWNER`, `modelExtracted: false`.
12. Experience path records assert `provenance: OWNER`, `modelExtracted: true`.
13. **`brandIdentity.visionStatement` remains derived copy** and is never read as, written from, or substituted for `intent`. Asserted at the source level with `codeOnly()`, and behaviourally: a store with a `visionStatement` and no `intent` record reports `intent` as **not known**.

**Separate, and not part of the implementation claim (decision 2)**
14. A live routing measurement, same fixture shape both sides, asking whether `offering` in the digest **changes J4's decisions**. Its result is reported as its own evidence. **The field existing is not a success claim**, and this contract does not assert an improvement in advance.

---

## 7. Split A — still open, still separate

`controlResult.reply` is handed to the content generator as *"Plan already
communicated to the user"*, so on the draft path the owner-facing sentence **is**
the generation spec, and UI6 piece 3 cannot compress it without starving the step
it feeds. That remains the named exception in `UI6_REMAINING_CONTRACT.md`.

**Not bundled here** — it alters what every draft turn feeds its content step and
deserves its own decision.

---

## 8. The single open item

Everything above is decided except one thing, and it exists only because
decision 6 arrived after decision 3:

> **Confirm: `offering` and `intent` as `ENTITY_REGISTRY` entity records
> (recommended — no migration, provenance already native), or as the two
> nullable `Store` columns as literally approved (which would need roughly six
> more columns to express the provenance decision 6 requires)?**

On confirmation this contract is closed and implementable.
