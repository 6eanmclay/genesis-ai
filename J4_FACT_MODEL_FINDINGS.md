# J4 Foundation — fact-model findings

**Status: FINDINGS ONLY. No implementation, no contract, no decision taken.**
2026-08-24. Written because `offering`/`intent` exposed a gap that is wider than
the two fields that revealed it.

**This is deliberately not a patch to `factCapture.ts`.** The narrow fix — adding
two entries to a discriminated union — would work and would hide the finding.

---

## 0. What triggered it

`offering` and `intent` shipped 2026-08-23 as `BusinessRecord` entity types with
`OWNER` provenance. They are written once, at `confirmStoreDraftCore`.

`lib/businessModel/factCapture.ts:51-55` defines what J4 may record when an owner
states something mid-conversation:

```
goal | challenge | employee | location | none
```

**So if the owner says "we sell something different now", J4 has nowhere to put
it.** The fact exists, J4 reasons from it, and it cannot be changed by the person
it is about.

---

## 1. What entity types exist

17 in `ENTITY_REGISTRY`:

`contact`, `transaction`, `item`, `appointment`, `campaign`, `document`, `goal`,
`challenge`, `employee`, `location`, `asset`, `design`, `socialAccount`,
`shipment`, `commitment`, `offering`, `intent`

**Only 4 are writable from a conversation.** The other 13 arrive from connectors,
uploads, internal mapping, or — for `offering`/`intent` — a single onboarding
write.

## 2. Which are authoritative owner facts, and which are derived

Provenance is per-record, not per-type — the same type can arrive by several
routes. Measured at all 12 write sites:

| Provenance | Written by | Meaning |
|---|---|---|
| `OWNER` | `statements.ts` (fixed by construction), `ownerFacts.ts`, `ingest.ts`, meeting `listen.ts`, `toolHandlers.ts` | the owner said it |
| `DOCUMENT` | `classify.ts`, `commitments.ts` | read out of a file they gave us |
| `CONNECTOR` | `integrationExecutable.ts` | a connected system said so |
| `DERIVED` | `internalMapper.ts`, `composeForStorefront.ts` | arithmetic over rows we own |
| `GENERATED` | `assets.ts`, `createDesign.ts` | J4 made the artifact |
| `INFERENCE` | — | J4 concluded it |

`modelExtracted` cuts across all of them: whether a model stood between the source
and the record.

**This layer is in good order.** Every write site passes explicit provenance; the
audit found no exceptions.

## 3. How facts change over time — inconsistently

| Type | Lifecycle fields |
|---|---|
| `goal` | `status`, `identifiedAt` |
| `challenge` | `status`, `identifiedAt`, `resolvedAt` |
| `employee` | `status` |
| `asset` | `supersedesAssetId`, `supersededByAssetId` |
| `location` | **none** |
| `offering` | **none** |
| `intent` | **none** |

**Three different mechanisms and one absence.** Goals and challenges carry a
status; assets carry an explicit supersession chain; `offering`/`intent` carry a
fixed `externalId` so a rewrite silently overwrites the old value; `location` has
nothing at all.

For `offering`, overwriting is **lossy in a way the others are not**: the previous
answer is gone, so "this business used to sell X and now sells Y" — a fact a
business partner would obviously want — cannot be recovered.

## 4. How J4 knows what it currently believes

Two parallel systems, and they are **not the same thing**:

| | `BusinessRecord` (Facts) | `Belief` |
|---|---|---|
| What | a thing that is true of the business | a pattern learned from repeated evidence |
| Provenance | 6-value enum, per record | `confidence` + `evidenceCount` |
| Change over time | inconsistent (§3) | `lastConfirmedAt` / `lastContradictedAt` |
| **Owner can correct it** | **no general path** | **yes** — `beliefReview.ts:276`, retires with `"dismissed by the owner"` |

**A Belief can be dismissed by the owner. A Fact cannot.** That asymmetry is
backwards: a Belief is J4's own inference and is *held tentatively by design*,
while a Fact is often the owner's own testimony — and it is the one they cannot
revise.

## 5. What surfaces expose that knowledge

One: the UI6 context pane (`app/j4/J4Surface.tsx` → `CONTEXT_TYPES`), a closed
registry of **three** entries — goals, challenges, assets — that is **read-only
by construction**.

So of 17 entity types, 3 are visible to the owner, and none is editable there.
`offering` and `intent` are visible nowhere.

**J4 reasons from `offering` in the digest while the owner cannot see that it
does.** That is the "claims knowledge it doesn't have" risk inverted: knowledge it
*does* have, held invisibly.

## 6. What happens when the owner contradicts a fact

**Nothing designed.** There is no contradiction path for `BusinessRecord`.

What exists instead, and only in places:

- `goal` → `updateGoalStatus` executable can change status
- `challenge` → `resolveChallenge` executable
- `asset` → supersession chain
- `offering`/`intent` → silent overwrite via fixed `externalId`
- everything else → nothing

Beliefs, by contrast, have `lastContradictedAt` *and* an owner dismissal path.

**The gap in one sentence:** the system models contradiction for the things J4
inferred, and not for the things the owner told it.

## 7. Should `offering`/`intent` use a generalised mechanism?

**On the evidence, yes — and the generalisation is the real finding.**

They are not special. They are the first two entity types where "the owner stated
it, and may restate it" is the *whole* lifecycle, which made the missing
mechanism obvious. `location` has the same shape and the same absence.
`employee` has a `status` that only partly covers leaving.

The question is not "how do we let J4 write `offering`". It is:

> **What is the general mechanism by which an owner-stated fact is corrected,
> superseded, and shown back to them — and which entity types opt into it?**

Answer that and `offering`, `intent`, `location`, and the next one are covered.
Patch `factCapture.ts` and only `offering` is.

---

## 8. What a redesign would have to decide — for Sean, not answered here

1. **One correction mechanism, or per-type?** Assets use supersession, goals use
   status. A third pattern would make three.
2. **Does correction preserve history?** "Used to sell X" is real business
   knowledge. Overwriting destroys it; superseding keeps it and costs storage
   plus a "current" query everywhere.
3. **Which types are conversationally writable?** Today 4 of 17, and the boundary
   looks accidental rather than chosen.
4. **Where does the owner see and change what J4 believes?** The context pane is
   read-only by deliberate UI6 decision — *"Context pane = understand. Action
   surface = change."* A correction surface is therefore **new**, not an
   extension of the pane, and that decision should be made rather than drifted
   into.
5. **What happens on contradiction mid-conversation?** Silently overwrite, ask to
   confirm, or record both and flag the conflict. This is a J4 identity question
   as much as a data one.
6. **Do Facts and Beliefs converge?** Beliefs already have contradiction tracking
   and owner dismissal. Either Facts grow their own, or the two get a shared
   notion of "held, contested, retired".

## 9. Explicitly not recommended yet

No mechanism is proposed. The evidence supports the *problem statement*, not a
solution — and the six questions above are product decisions, not engineering
ones. Per the agreed order this comes **after** Verification Hardening.

**Not to be patched opportunistically in the meantime.** Adding `offering` to
`BusinessFactSchema` would close the visible symptom and leave §3–§6 exactly as
they are.

---

## Files supporting this

- `lib/businessModel/factCapture.ts:50-55` — the 4-type closed union
- `lib/businessModel/entities.ts` — `ENTITY_REGISTRY`, 17 types
- `lib/businessModel/ownerFacts.ts` — fixed `externalId`, overwrite-on-restate
- `lib/businessModel/statements.ts` — `stateFact`, provenance fixed by construction
- `lib/intelligence/beliefReview.ts:276` — the owner dismissal Facts do not have
- `prisma/schema.prisma:2170` — `Belief`, with `lastContradictedAt`
- `lib/j4/contextTypes.ts` — the 3-entry read-only registry
- `lib/businessModel/digest.ts` — where `offering` reaches J4's reasoning unseen
