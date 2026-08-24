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

## 2. The six decisions — evidence, options, consequences

**Nothing here is chosen on Sean's behalf.** Each carries the evidence found in
the current implementation, every option with its real consequence, and a
recommendation. Sean's steer of 2026-08-24 is recorded against each; where the
repository agrees, it is cited; where it adds a constraint he did not have, that
is said plainly.

---

### D1 — the correction mechanism, and which types it covers

**Evidence — three mechanisms exist today, each added for one type in isolation:**

| Mechanism | Type | Shape |
|---|---|---|
| a `status` field in the JSON payload | `goal`, `challenge`, `employee`, `transaction`, `appointment`, `campaign`, `document`, `shipment` | mutate the record in place |
| an explicit supersession chain | `asset` | write a new record, point the old one at it |
| fixed `externalId`, silent overwrite | `offering`, `intent` | the unique constraint turns a restate into an update |
| nothing at all | `location`, `contact`, `item`, `design`, `socialAccount`, `commitment` | — |

**Options**

| | Consequence |
|---|---|
| **One mechanism, types opt in** | One thing to learn, one thing to test, one place a bug can hide. Requires deciding what `status` means for types that already use it — see the constraint below |
| Per-type mechanisms | A fourth pattern joins three. Every future reader must know which type behaves how; this is the state that produced the finding |
| Extend `status` everywhere | Cheapest, and wrong for `offering`: "what we sell" has no `resolved` or `active` state, it has a *previous value* |

**A constraint the repository adds, and it matters:** `status` is **already in
use for something else** on eight types. A `goal` marked `achieved` has not been
*corrected* — it was true and now it is done. Overloading `status` to also mean
"this was wrong" would make those two indistinguishable, which is the same class
of collapse the previous milestone removed from `verified: false`.

**RECOMMEND: one mechanism — supersession — and it is additive.** `status`
keeps meaning *what became of this in the world*; supersession means *this is no
longer what we believe*. A goal can be `achieved` **and** superseded by a
restatement, and those are different facts.

---

### D2 — does correction preserve history?

**Evidence — the pattern already exists and is fully worked out.**
`lib/businessModel/assets.ts:75` carries both readers, and its own comment gives
the reason:

> *"Held-and-not-superseded, not merely newest. Those coincide today, and stop
> coinciding the moment anything writes history out of order (a backfill, an
> import, a restored asset). Asking the real question costs nothing now and does
> not need revisiting then."*

`resolveCurrentAsset` answers *the current one*; `listAssetsByRole` answers
*all of them, superseded included*.

**Options**

| | Consequence |
|---|---|
| **Preserve, by supersession** | *"They used to sell candles and now sell rings"* stays answerable — real business knowledge, and exactly the kind of thing a partner should know. Cost: every reader must ask for **current**, and one that forgets gets a stale answer |
| Overwrite | What `offering` does today. Simple, and it destroys the previous answer permanently. No migration recovers it |
| Keep an audit log separately | History survives but is not reasoned over — a second store of truth, which is the duplication this codebase removes elsewhere |

**The footgun, measured rather than asserted.** 10 call sites use the asset
readers. One caller — `lib/design/composeForStorefront.ts:57` — reads
`entityType: "asset"` directly with **no supersession filter**. I checked whether
that is a bug: it is not. It gathers candidate photos, and a superseded photo is
still a photo the business owns. **So the distinction is real, both answers are
legitimately wanted, and in practice the named-reader pattern has held.**

**RECOMMEND: preserve, by supersession** — with the mitigation the asset code
already demonstrates: a `resolveCurrent…` reader and a `list…` reader, named so
that choosing wrong is visible at the call site rather than silent.

---

### D3 — which entity types accept owner testimony

**Evidence — the current boundary is 4 of 17, and it looks accidental. Mapping
every type by who actually writes it makes a principled line appear:**

| Group | Types | Who is authoritative |
|---|---|---|
| **Owner testimony** | `goal`, `challenge`, `employee`, `location`, `offering`, `intent` | **the owner** — only they know what they want, who works there, what they sell |
| Connector-owned | `transaction`, `appointment`, `campaign`, `document`, `shipment`, `socialAccount` | the connected system. QuickBooks, Google Calendar, Mailchimp, EasyPost |
| Platform-derived | `contact`, `item` | arithmetic over rows this platform owns (`internalMapper.ts`) |
| Generated artifacts | `asset`, `design` | J4 made them |
| Document-extracted | `commitment` | a file the owner supplied |

**Options**

| | Consequence |
|---|---|
| **A type accepts testimony iff the owner is its authoritative source** | A property, not a list. `offering`/`intent` join because they are owner answers; a QuickBooks transaction does not, because the fix belongs in QuickBooks — correcting it here would create a fact that the next sync silently overwrites |
| Open everything | An owner "correcting" a synced transaction gets a change that survives until the next sync and then vanishes. Worse than refusing: it looks like it worked |
| Add `offering`/`intent` only | Closes today's symptom, leaves `location` — which has an owner author and no mechanism — exactly as it is |

**A nuance worth stating:** a type can have several provenance routes.
`employee` and `location` are also written by `classify.ts` with `DOCUMENT`
provenance. That is fine — provenance is per record, not per type — and it means
"accepts testimony" is about whether an *owner-stated* record is meaningful, not
about excluding other sources.

**RECOMMEND: the property, giving exactly six types** — `goal`, `challenge`,
`employee`, `location`, `offering`, `intent`. Two more than today, and the two
added are the ones with an owner author and no way to speak.

---

### D4 — where the owner sees and changes what J4 believes

**Evidence — the pane is read-only by construction, not by convention.**
`lib/j4/contextTypes.ts` states it:

> *"READ-ONLY BY CONSTRUCTION, not by convention. A reader is a pure function of
> an already-fetched BusinessUnderstanding. It cannot write, cannot reach a
> database, and cannot create an approval, because it is handed a value and
> returns strings."*
>
> *"Context pane = understand. Action surface = change."*

And it shows **3 of 17** types: goals, challenges, assets.

**Options**

| | Consequence |
|---|---|
| **Correction in conversation only** | No new surface. Uses the relationship J4 already has, and the owner corrects the way they stated it — by saying so. Nothing to design, nothing to keep in sync. Cost: a fact the owner has never discussed stays invisible |
| A new correction surface | Everything visible and editable. Cost: it is genuinely new — the pane cannot host it without reversing an explicit UI6 decision — and it is a second place business state changes, which is the thing the execution architecture exists to avoid |
| Make the pane editable | **Directly contradicts a frozen decision.** Not recommended without reopening UI6 |

**RECOMMEND: conversation only for this milestone**, and treat a correction
surface as its own later decision. The evidence for this is that the milestone's
actual defect — *"we sell something different now"* has nowhere to go — is a
**conversational** failure. A surface would be additional scope solving a
different problem, and the pane's read-only guarantee is worth more than the
convenience.

**Sean's steer was "treat the correction surface as new functionality".** This
recommendation agrees and goes one step further: new, and **not in this
milestone**.

---

### D5 — what happens when an owner contradicts an existing fact

**Evidence — today, nothing happens, because nothing looks.**
`toolHandlers.ts:253` writes every capture with `externalId: randomUUID()`:

```ts
[{ entityType, externalId: randomUUID(), data: parsed.data }]
```

**So a second statement creates a second record.** Say *"our goal is to reach
1,000 customers"* twice and the business has two goals. Nothing detects that they
are the same goal, and nothing detects that a new one contradicts an old one.

**Options**

| | Consequence |
|---|---|
| Silently supersede | Matches `offering` today. A misheard correction replaces the truth with no trace and no question |
| **Ask to confirm** | One question before replacing owner testimony. Costs a turn. The precedent exists — `buildScopeClarification` already asks "which product did you mean?" and, critically, **escalates rather than repeating** when the answer is still ambiguous |
| Record both, flag the conflict | Nothing is lost and nothing is decided. J4 then holds two contradictory facts and must reason with both — which is the state this milestone exists to end |

**RECOMMEND: ask to confirm, for owner testimony only.** A model's reading of a
rambling sentence is exactly the thing that should not silently overwrite what
somebody said last month. `buildScopeClarification` is the shape to follow,
including its anti-loop rule.

**And a bound worth setting now:** confirmation applies when a NEW statement
contradicts an EXISTING one. A first statement about something J4 knows nothing
about is not a contradiction and must not ask.

---

### D6 — do Facts and Beliefs converge?

**Evidence — both already model retirement, differently, and each fits its own
subject:**

| | `BusinessRecord` (Fact) | `Belief` |
|---|---|---|
| retirement | none | `status` ACTIVE/RETIRED, `retiredAt`, `retiredReason` |
| owner disagreement | none | `beliefReview.ts:276` — `"dismissed by the owner"` |
| contradiction over time | none | `lastContradictedAt` vs `lastConfirmedAt` |
| strength | provenance — *who said it* | `confidence` + `evidenceCount` — *how much supports it* |

**Options**

| | Consequence |
|---|---|
| **Keep separate, share vocabulary** | Each keeps the semantics that fit it. A Fact is retired because it stopped being true; a Belief because the evidence stopped supporting it. Shared words — *held, contested, retired* — let one reader speak about both |
| Merge into one model | A Fact would inherit `confidence`, which is meaningless for something the owner stated: their testimony is not 70% likely. And a Belief would inherit provenance, which is already answered by `evidenceRefs` |
| Leave fully divergent | Today. Two vocabularies for the same idea, and the asymmetry that started this milestone |

**RECOMMEND: keep separate, share vocabulary.** `retiredReason` is plain text
*"not a rigid enum"* by deliberate design, and its existing values already read
naturally for facts too — so the shared vocabulary can be adopted without
touching the Belief model at all.

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
   construction — *"NOT from the caller. This is the invariant the whole file
   exists for."*

   **A finding this audit turned up, which the milestone should resolve rather
   than inherit:** `captureBusinessFact` (`toolHandlers.ts:253`) does **not** go
   through `stateFact`. It calls `persistSyncedRecords` directly and passes
   `provenance: "OWNER"` as a parameter — a second door on the invariant
   `statements.ts` exists to hold. Not a security hole (both are server-side and
   the value is correct), but it is the *shape* of one: two ways to assert owner
   testimony, only one of which cannot be told to lie.

   Since this milestone is the one that changes how owner testimony is written,
   routing `captureBusinessFact` through `stateFact` belongs to it — small, and
   it makes the invariant true at every door rather than at most of them.
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

## 6. The standalone runner — tracked separately, and NOT required here

Sean asked whether the runner is required for this milestone's acceptance gates,
or whether it is separate infrastructure. **Checked rather than assumed: it is
separate, and this milestone does not need it.**

**The evidence.** This milestone's suites divide by what they need:

| What it tests | Lane | Runs today? |
|---|---|---|
| correction, supersession, provenance on real rows | 1 — shared runner | **yes**, `run-db-suites.ts` |
| the contradiction path end to end | 1 — shared runner | **yes** |
| a fan-out through `getBusinessProfile` | 3 — own Postgres | yes, by hand, like `verify-owner-facts.ts` |
| pure boundary logic, no database | 2 — standalone | **no runner** |

Everything load-bearing is database-backed and lands in lane 1, which has a
command. Only pure boundary logic would land in lane 2 — and that can be folded
into a lane-1 suite instead, at the cost of a little speed, if it comes to it.

**So the runner does not gate acceptance and must not expand this milestone.**
It stays a **separate critical infrastructure item**: 76 suites listed by
`verification-inventory.ts --plan` and run by nothing, in a repository whose
`package.json` has no `test` script at all. That number grows with every suite
added, including the ones this milestone writes — which is an argument for doing
it soon, not for doing it here.

**Recorded as its own item, not a prerequisite.**

---

## 7. Status — presented, awaiting approval

**All six decisions are presented with evidence, options, consequences and a
recommendation. None is taken.** This contract closes when Sean approves or
amends them, and is not implementable before that.

Two of the recommendations differ from what a reasonable reading of the steer
might assume, so they are flagged rather than buried:

- **D1** recommends supersession be **additive to `status`, not a replacement**,
  because `status` already means something else on eight types and a goal that
  was *achieved* is not a goal that was *wrong*.
- **D4** agrees the correction surface is new functionality and recommends it be
  **out of this milestone entirely**, because the defect that motivated the
  milestone is conversational.
