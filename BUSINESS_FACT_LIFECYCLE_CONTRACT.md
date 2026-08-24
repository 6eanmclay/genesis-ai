# The Business Fact Lifecycle — contract

**Status: PROPOSED. Nothing implemented.** 2026-08-24. No API credit, no live
model.

Evidence: `NEXT_MILESTONE_REASSESSMENT.md` §2.3 and `J4_FACT_MODEL_FINDINGS.md`.

**This contract is deliberately not a patch to `factCapture.ts`.** Adding two
entries to a discriminated union would close the visible symptom and leave every
finding below exactly as it is.

---

## 1. The problem, stated once

> J4 can hold a fact about a business — including what it sells — that the
> person running it can neither see nor correct.

Three specific shapes of it:

1. **No correction path.** A `Belief` can be dismissed by the owner
   (`beliefReview.ts:276`, *"dismissed by the owner"*). No `BusinessRecord` can.
   That is backwards: a Belief is J4's own inference, held tentatively by design;
   a Fact is often the owner's own testimony.
2. **No shared notion of change.** Goals carry `status`, challenges carry
   `status` + `resolvedAt`, assets carry a supersession chain, `offering`/`intent`
   overwrite silently on a fixed `externalId`, and `location` carries nothing.
   Three mechanisms, four absences.
3. **Almost nothing is visible.** 3 of 17 entity types reach the owner, through a
   pane that is read-only by deliberate UI6 decision.

---

## 2. What must be decided before implementation

These are **product decisions, not engineering ones**, and the milestone cannot
start without them. Each carries a recommendation and the evidence for it — none
is taken as settled.

### D1 — one correction mechanism, or per type?

**Recommend one.** A third pattern would make three, and the reason the current
three exist is that each was added for one type in isolation. One mechanism,
which types opt into.

### D2 — does correction preserve history?

**Recommend yes, by supersession.** *"They used to sell candles and now sell
rings"* is real business knowledge, and today `offering` destroys it on restate.
Assets already supersede rather than overwrite, so the pattern exists in-repo.

**The cost, stated honestly:** every reader must then ask for the *current* fact
rather than *the* fact, and a reader that forgets gets a superseded answer. That
is a real footgun and it is the price of not losing history.

### D3 — which types are conversationally writable?

Today 4 of 17, and the boundary looks accidental rather than chosen.
**Recommend deciding it as a property** — a type either accepts owner testimony
or it does not — rather than as a list that grows by whoever needed one.

### D4 — where does the owner see and change what J4 believes?

The context pane is read-only by an explicit UI6 decision: *"Context pane =
understand. Action surface = change."* **A correction surface is therefore new,
not an extension of the pane.** Recommend deciding whether it is a surface at
all, or whether correction happens only in conversation.

### D5 — what happens when the owner contradicts a fact mid-conversation?

Silently supersede, ask to confirm, or record both and flag the conflict.
**Recommend asking to confirm** for owner-stated facts, because a
misheard correction that silently replaces the truth is worse than one question.
This is a J4 identity question as much as a data one.

### D6 — do Facts and Beliefs converge?

Beliefs already have `lastContradictedAt` and an owner dismissal. **Recommend
NOT merging them** — they answer different questions and the provenance model
already distinguishes them — but recommend a **shared vocabulary** for held,
contested, and retired.

---

## 3. Scope, once decided

### In

1. **One correction mechanism**, per D1/D2, applied to the types D3 selects.
2. **`offering`/`intent` become correctable** through it — the case that exposed
   the gap.
3. **`factCapture` opens to the types D3 selects**, by the property D3 defines,
   not by a longer list.
4. **A "current fact" read** that cannot accidentally return a superseded one.
5. **Contradiction handling** per D5.
6. **Whatever surface D4 decides**, or none.

### Out, explicitly

- **The Belief model.** Untouched.
- **Verification Hardening.** Closed and accepted. Fact writes go through
  `stateFact`, not through `Executable`, so nothing here reopens it — but any new
  `Executable` this milestone adds inherits the required `verify()`.
- **`edit_store_content`.** Still its own decision.
- **Any live-model work.** The extraction that produces `ownerOffering` already
  exists and is not changed here.
- **New entity types** beyond what D3 selects.

---

## 4. Invariants this must not break

1. **Provenance stays explicit at every write.** All 12 sites pass it today and
   the audit found no exception; a correction path is a 13th site, not a licence.
2. **`OWNER` provenance still cannot be forged.** `stateFact` fixes it by
   construction. A correction mechanism must not become a way to assert
   provenance from a caller.
3. **`modelExtracted` still distinguishes typed words from distilled ones.** A
   correction made in conversation is `modelExtracted: true` unless the owner
   typed it into a field.
4. **Generated content is never promoted into owner testimony.** The rule in
   `ownerFacts.ts` §4c holds for corrections too — an owner *confirming* a
   generated suggestion is testimony; the suggestion arriving on its own is not.
5. **Absence still means "not known".** No backfill, no inferred history, no
   manufactured "current" value for a fact nobody stated.

---

## 5. Acceptance

**IMPLEMENTED / VERIFIED / LIVE-PROVIDER-BLOCKED stay separate**, as in the
previous milestone. A mechanism with no negative control is IMPLEMENTED.

1. An owner-stated fact can be corrected, and the correction is what every reader
   then sees.
2. Per D2, the superseded value is still retrievable — with a control proving a
   reader asking for the current fact **cannot** receive the superseded one.
3. `offering` and `intent` are correctable, and a correction carries `OWNER`
   provenance with the right `modelExtracted`.
4. A type D3 excludes **cannot** be written conversationally — asserted, not
   assumed.
5. Contradiction behaves as D5 decided, with a control entering the contradiction
   path rather than asserting it exists.
6. **Controls that break the real write**, as in Verification Hardening: a
   correction that did not land, a superseded row that still answers as current,
   a generated suggestion attempting to enter as testimony.
7. Source assertions use `codeOnly()` — and it moves to `scripts/lib/` first,
   since it is now duplicated in three suites.
8. Typecheck, **`npx next build` reported separately from any suite count**, the
   shared runner, and every suite this milestone touches.
9. New suites declare their lane and are reachable from it.

---

## 6. Before this milestone

**Give lane 2 a runner.** 76 standalone suites are listed by
`verification-inventory.ts --plan` and run by nothing; `package.json` has no
`test` script at all. This milestone's own tests will land in that lane, so the
runner should exist first. Hours, no credit.

---

## 7. Open — all of §2

**Six decisions, none taken.** This contract is not closed and is not
implementable until they are.
