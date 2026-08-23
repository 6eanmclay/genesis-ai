# The draft-path field split — contract before implementation

**Status: CONTRACT / DECISION PASS. Nothing implemented.** 2026-08-23.
Sean: contract first, review before implementation.

---

## 0. First, a correction to the framing

Two different splits came out of the UI6 work, and they are not the same thing.
Deciding the wrong one would leave the other in place.

| | **Split A — the reply field** | **Split B — the business description** |
|---|---|---|
| What is overloaded | `ChatControlSchema.reply` | what "the business is" on a live Store |
| Symptom | UI6 piece 3 cannot compress the draft reply | J4 reasons about the business from model-written prose |
| Raised by | me, from the prose measurement | Sean, 2026-08-23 |

**Sean's stated preference is B** — "separate the draft's business description
from the product/service description and vision". This document contracts B, and
keeps A on the table at the end because it is still real and still unfixed.

---

## 1. What exists today, exactly

### 1a. `StoreDraft` — the owner's own words

| Field | Type | Set by | Required |
|---|---|---|---|
| `inputStoreName` | `String?` | CreateStoreForm | no |
| `inputProductType` | `String?` | CreateStoreForm | no |
| `inputVision` | `String?` | CreateStoreForm | **yes** (`RecoverableError` at [ai-actions.ts:468](app/dashboard/ai-actions.ts#L468)) |
| `name` | `String` | both paths | — |
| `description` | `String?` | generation | no |
| `tagline` | `String?` | generation | no |

Owner-facing meaning, from the form itself:

- `inputProductType` → *"e.g. Performance gym clothing"* — **what you sell**
- `inputVision` → *"Cozy rustic candle shop." / "Dark luxury fitness brand."* —
  **the feel you want**, and the label says "your style, audience, colors"

**These are already distinct columns.** The split Sean is describing exists at
the draft layer. The problem is downstream.

### 1b. `Store` — what survives confirmation

| Field | Type |
|---|---|
| `name` | `String` |
| `description` | `String?` |
| `tagline` | `String?` |
| `businessCategories` | `String[]` |
| `revenueStreams` | `String[]` |
| `brandPositioning` | `String?` |

**There is no `inputProductType` or `inputVision` equivalent on `Store`.** The
owner's own two answers do not survive `confirmStoreDraftCore`.

### 1c. Where each is actually consumed

| Field | Consumed at | For what |
|---|---|---|
| `inputStoreName`/`inputProductType`/`inputVision` | [ai-actions.ts:519-523](app/dashboard/ai-actions.ts#L519) | the initial generation prompt, once |
| `inputProductType` + `inputVision` | [ai-actions.ts:4231-4232](app/dashboard/ai-actions.ts#L4231) | `sourceHeroImageCandidate`, once, at confirm — and only when `heroLayout === "split"` |
| `draft.description` | same line, as a **fallback for vision** | `inputVision ?? description ?? name` |
| `Store.description` | [profile.ts:246](lib/businessModel/profile.ts#L246) | `understanding.identity.description` |
| `blueprint.brandIdentity.*` | [profile.ts:247-253](lib/businessModel/profile.ts#L247) | `brandStory`, `missionStatement`, **`visionStatement`**, `brandPromise`, `coreValues`, `targetAudience`, `uniqueSellingProposition` |

**That is the entire consumption of the owner's two answers: one prompt and one
hero image.** After confirm they are unreachable.

### 1d. What J4 actually receives

The digest ([digest.ts:111-113](lib/businessModel/digest.ts#L111)) carries:

```
name, tagline, categories[]
```

**Not `description`. Not `visionStatement`. Not what the business sells** beyond
category labels. The routing digest that this milestone proved changes decisions
10 times out of 10 does not contain the business's own description at all.

### 1e. The second onboarding path has none of this

[onboarding/actions.ts:70](app/onboarding/actions.ts#L70) and
[:100](app/onboarding/actions.ts#L100) create drafts as:

```
{ userId | anonymousSessionToken, name: "New store", status: "onboarding_discovery" }
```

**The experience-first path never sets `inputProductType` or `inputVision`.** It
builds an `ExperienceConcept` in `experienceState` JSON instead, carrying
`productName`, `productDescription`, `businessModelSlug`, `brandPositioning`, and
a `CreativeDirectionOption` whose `description` is the brand's, not the product's.

**So the two onboarding paths produce structurally different drafts,** and any
contract that only handles the form path fixes half the product.

---

## 2. The actual defect, stated once

> The owner answers two specific questions — what I sell, and what I want this
> to feel like. Both are used for one prompt and one image, then discarded. From
> confirmation onward, every downstream reader — the understanding profile, the
> digest, J4's reasoning — sees only prose a model wrote, in a single
> `description` field, and the digest does not even carry that.

This is Sean's principle exactly: two pieces of information with different
semantic roles, collapsed into prose, with the model asked to infer the structure
back out.

---

## 3. Proposed contract

### 3.1 The fields

Two new nullable columns on **`Store`**, mirroring what `StoreDraft` already
holds:

| Field | Type | Meaning | Source of truth |
|---|---|---|---|
| `offering` | `String?` | **what the business sells**, in the owner's words | `StoreDraft.inputProductType` |
| `intent` | `String?` | **what the owner wants it to be** — style, audience, feel | `StoreDraft.inputVision` |

**Named `offering`/`intent`, not `productType`/`vision`, and deliberately.**
`vision` collides with `blueprint.brandIdentity.visionStatement`, which is a
different thing (see 3.2). `productType` reads like a classification and would
invite confusion with `businessCategories`. These names say whose words they are.

### 3.2 What this must NOT duplicate

| Existing | Why `offering`/`intent` is not that |
|---|---|
| `blueprint.brandIdentity.visionStatement` | **model-written brand copy**, for the storefront to say. `intent` is the **owner's instruction**, never rendered. Different author, different audience. |
| `businessCategories` / `revenueStreams` | **closed-registry slugs** for classification. `offering` is free text and never a filter key. |
| `Store.description` | the **public-facing** description, model-written, shown to customers. Unchanged by this. |
| `brandPositioning` | a positioning statement, already carried over. Unchanged. |
| `ExperienceConcept.productDescription` | one product's copy, not the business's offering. |

**Nothing is moved and nothing is rewritten.** Two columns are added that
currently have no home.

### 3.3 Existing drafts and existing stores

- **Both columns nullable, no default, no backfill required.** Every existing
  `Store` row stays valid with both null.
- **Existing drafts are untouched.** `StoreDraft` gains nothing; its three input
  columns already exist and keep their exact current meaning.
- **A one-time backfill is possible but is NOT proposed here.** For stores whose
  draft row still exists, `inputProductType`/`inputVision` could be copied
  forward. Drafts are deleted at confirm on some paths, so this would be partial,
  and a partial backfill makes "null" ambiguous — it would mean both "never asked"
  and "asked, but the draft is gone". **Recommend: no backfill. Null means not
  known, and J4 asking for what it's missing is a capability that already
  exists.**
- **The experience-first path leaves both null** until it is given the same two
  questions. That is honest and visible rather than silently inferred.

### 3.4 What changes downstream

| Consumer | Change |
|---|---|
| `confirmStoreDraftCore` | carry `inputProductType` → `offering`, `inputVision` → `intent` |
| `profile.ts` `identity` | add `offering` and `intent` alongside `description` |
| `digest.ts` | **add `offering`** to the digest. This is the highest-value single line in the proposal: J4 currently routes without knowing what the business sells. |
| `sourceHeroImageCandidate` | read `store.offering ?? draft.inputProductType`, dropping the `?? description ?? name` fallback chain |
| context pane registry | **optional, and a separate decision** — `CONTEXT_TYPES` is a closed registry and adding to it is a UI6 change, not this one |

### 3.5 What is explicitly out of scope

- No change to `Store.description` or its generation.
- No change to `brandIdentity` or the blueprint.
- No new onboarding questions on the experience-first path.
- No backfill.
- No context-pane entry.

### 3.6 How it would be verified

- **Migration-level**: both columns nullable; an existing row with both null
  still loads through `profile.ts`.
- **Carryover**: a draft with both inputs set, confirmed, produces a `Store` with
  both populated — and the negative control is a draft with `inputProductType`
  null producing `offering` null rather than a fallback.
- **Digest**: `offering` present when set, absent when null, and the digest does
  not fabricate one from `description`.
- **The fallback is gone**: assert `inputVision ?? draft.description ?? draft.name`
  no longer appears — that chain is what made vision and description
  interchangeable in the first place.

---

## 4. Split A, still open

Deciding B does not resolve A. On the draft path `controlResult.reply` is passed
to the content generator as `"Plan already communicated to the user"`, so the
owner-facing sentence **is** the generation spec, and UI6 piece 3 cannot compress
it without starving the step it feeds. That remains the named exception in
`UI6_REMAINING_CONTRACT.md`.

It is a smaller change than B — `ChatControlSchema` gains a `plan` field, the
prompt is told to write both, and two call sites read `.plan` instead of
`.reply`. **Not proposed here, and not bundled with B**, because it alters what
every draft turn feeds its content step and deserves its own decision.

---

## 5. The decision being asked for

1. **Split B as contracted above** — `offering` and `intent` on `Store`, no
   backfill, digest gains `offering`?
2. **The two names** — `offering`/`intent`, or different words?
3. **The digest line** — is adding `offering` to J4's decision context in scope,
   or does that want its own measurement first given how much this milestone
   turned on digest content?
4. **Split A** — decide now, defer, or leave as a documented exception?
