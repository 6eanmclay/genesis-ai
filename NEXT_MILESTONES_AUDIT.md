# What to build next — five candidates, audited

**Status: PARTLY EXECUTED 2026-08-23.**

- **D3 — BUILT** (`2a1ab9a`). One product per design, enforced by a partial unique index; a refused attempt costs no growth points.
- **PD4 — BUILT** (`6a76386`). A proactive message carries the proposal its own finding produced, never whichever is newest. J4 never decides it.
- **D1/D2 — contracted**, `PARTIAL_TURN_CONTRACT.md`. Ready to authorize.
- **D4 — contracted**, `D4_APPROVAL_RECOVERY.md`. One decision left.
- **Belief channel — CORRECTED.** This is a Genesis Language / Constitution decision, **not an engineering gap**. Listing it as a milestone candidate was my error: the belief architecture is complete and owner-facing, and the only open question is whether the FROZEN five-state vocabulary gains a sixth member. That is Sean's alone and the vocabulary stays untouched until he says otherwise.
- **Teaching / challenge / communication style — unchanged.** Product design, not authorization.

---

*Original audit follows.*

Audited against the repository as it stands, not against the roadmap documents.
Two of the five turned out to be much smaller than their documents imply, and
one turned out not to be a decision at all.

---

## 1. Partial-turn semantics (D1–D4)

### Current state

`runPlannedTools` runs the planned tools in order with **no `try`/`catch`**, and
`persistToolTurn` writes nothing until every tool has returned. A handler that
throws propagates: the route's outer catch emits `fallback` (and the Server
Action re-runs the whole turn); on the Server Action the throw leaves the action.
Either way no message and no execution row is written.

### Affected handlers — the ones with side effects before the turn ends

| Handler | Side effect | Idempotent on re-run? |
|---|---|---|
| `capture_business_fact` | writes a `BusinessRecord`, resolves observations | Yes — upsert |
| `manage_business_asset` | `store.update` (logo, hero) | Yes — same value |
| `request_image_change` / `_product_removal` / `_product_content_change` | creates an `ApprovalRequest` | Yes — supersedes its own pending row |
| `approve_pending_changes` | executes approved changes | Yes — status transition guards it |
| **`approve_design_as_product`** | **creates a real, buyable product** | **NO — twice creates two** |

Idempotency here is accidental rather than designed, which is why D3 is worth
answering even if D1/D2 are not.

### Exact implementation surface

- `lib/dashboard/runToolTurn.ts` — `runPlannedTools` (the loop), `RunToolsOutcome`
  (a new variant), `persistToolTurn` (writing a partial turn).
- `app/api/chat/route.ts` — the `run.kind !== "handled"` branch.
- `app/dashboard/ai-actions.ts` — the `decidedTool !== "edit_store_content"` branch.
- D3 alone: `lib/execution/executables/productFromDesign.ts`, nothing else.

### D4 — the approval race, and why it is genuinely harder than the one I just fixed

`performApproveGenesisAction` reads the row as `PENDING_APPROVAL`, calls
`execute(...)`, and only then marks it `EXECUTED`. Two concurrent calls both pass
the read.

I fixed a structurally identical race in proactive delivery today with a
transaction, and **that fix does not transfer**. Proactive delivery's three
writes are all database writes and complete in milliseconds. `execute()` does
real external work — image generation, provider APIs — and holding a database
transaction across it is not an option. That is precisely why D4 needs a claimed
state, and a claimed state needs a recovery policy for a process that dies
mid-execute.

Growth points are deducted per successful execution, so a double execution is
also a double charge.

### Decisions required — the smallest coherent set

**D1 — When a tool throws after an earlier one succeeded, what is recorded?**
(a) nothing, as today; (b) what succeeded, plus a sentence saying the rest did
not. *Recommend (b).*

**D2 — Does the streaming route still fall back after persisting?**
(a) no — the turn ends where it broke; (b) yes, with completed tools marked so
the re-run skips them (needs turn-level state that does not exist).
*Recommend (a).*

**D3 — May `approve_design_as_product` stay non-idempotent?**
(a) leave it; (b) the executable refuses a duplicate for the same design within a
window. *Recommend (b).* **Independent of D1/D2 and answerable alone.**

**D4 — What happens to an approval whose execution started and never resolved?**
(a) leave the race; (b) claim, revert only on a failed execution (a crash strands
the row); (c) claim with a recovery rule — timeout or a startup sweep
reconciling claimed rows against `ExecutionLog`. *No recommendation* — the choice
depends on how stuck work should surface on the review page, which is a product
question.

- **Credentials:** none.
- **Size:** D3 alone is small. D1+D2 medium. D4(c) is the largest single piece here.
- **Verification:** a handler stub that throws after a real mutation; concurrent
  approval attempts asserted at the row level. Both deterministic.
- **Safe to authorise immediately?** **D3 yes.** D1/D2 yes once decided. D4 no —
  it needs a recovery policy first.

---

## 2. PD4 — proactive proposals

### Current state, and the finding that changes the question

**Proposals are already created without the owner asking.** `runCognitiveReview`
writes `ApprovalRequest` rows (`cognitiveLayer.ts:826`), and the intelligence
cycle calls it unattended via `runOpportunisticAiReviewIfStale`. `getNextBestAction`
then reads those pending rows.

So autonomous *proposing* is existing, shipped behaviour. PD4 is not "may J4 act
on its own" — it is **"may a proactive message point at a proposal that already
exists."** That is a much smaller and much safer question than the contract
implied, and I would not have known without reading it.

The full chain already exists end to end: `ApprovalRequest` → `J4Proposal` card
(business-scoped since UI6) → `performApproveGenesisAction` (resolves the business
from the proposal's own row) → `execute()` → executable verification →
`ExecutionLog`.

### What would need to change

Small. A proactive finding would carry an `approvalRequestId`, and the
conversation would render the existing `J4Proposal` card beneath the message.
Nothing about approval, authorization or execution changes — the card is already
the surface, and it already binds the conversation's business.

The security model stays intact by construction: J4 never approves. The owner
approves through the same path they use today.

- **Dependencies:** UI6's message state vocabulary (shipped); `ProactiveDelivery`
  (shipped).
- **Credentials:** none for the plumbing. The proposals themselves come from
  `runCognitiveReview`, which does use a model — but this milestone does not add
  that dependency, it inherits an existing one.
- **Decisions required:** whether a proactive message may carry a proposal at
  all; and whether it should point at any pending proposal or only one the
  finding itself produced. The second matters — pointing at an unrelated pending
  proposal would be J4 changing the subject.
- **Size:** small.
- **Verification:** a proactive message with a proposal renders as `proposed`
  never `done`; approving through it goes through the existing path; the proposal
  and the message belong to the same business.
- **Safe to authorise immediately?** **Yes**, given the two decisions above.

---

## 3. UI6's three parked pieces

**Business context beside the conversation.** §7 calls it undesigned itself
("a real decision for whenever this phase actually starts"). Pure UX design; no
implementation state to report. **Not separable — it is a design task.**

**Navigable conversation history.** `StoreMessage` has no conversation id;
messages are one flat per-store stream read as the newest 50. Making history
navigable means deciding what a conversation *is* — a schema decision, then a UX
one. **Separable and independently buildable, but only after that decision.**

**Concise-summary replies.** The render half (making the existing
`changes: string[]` checklist primary) is buildable today. The prompt half
(shortening `content` to one lead sentence) needs a model to verify. **Not
separable:** shipping the render half alone produces a primary checklist sitting
under paragraphs of prose, which is worse than today. Blocked as a unit on
`ANTHROPIC_API_KEY`.

- **Decisions required:** what a "conversation" is (for history); the whole
  design (for business context). None for concise-summary — it is credential
  blocked, not decision blocked.
- **Safe to authorise immediately?** No, for all three.

---

## 4. Belief / Genesis Language channel

### This one is not what the note said

The belief architecture is **complete and owner-facing**: `lib/intelligence/learn.ts`
writes them, `getBeliefs` reads them with owner-scoping, `beliefReview.ts` exposes
`getReviewableBeliefs` / `contradictBelief` / `restoreBelief`, and
`/dashboard/understanding` renders `BeliefReview.tsx` so an owner can correct
what J4 believes. Provenance and maturity are carried throughout. That was U4 and
it shipped.

What is "unwired" is narrower than my own note claimed: **beliefs have no state
in the five-state Genesis Language vocabulary** (`GENESIS_STATE_META`: Peace,
Curiosity, Responsibility, Optimism, Concern). There is no ambient signal that
says "J4 has come to believe something about your business."

- **Remaining work:** decide whether beliefs deserve a channel at all; if so, a
  sixth state or a reuse of Curiosity, plus the detector that raises it.
- **Dependencies:** none — everything it would read exists.
- **Credentials:** none.
- **Decisions required:** whether the frozen five-state vocabulary gains a sixth
  member. That is a change to a **frozen** Constitution-level model, so it is
  emphatically yours.
- **Size:** small once decided.
- **Safe to authorise immediately?** **No, and it should not have been listed
  here at all.** This is a Constitution decision, not an engineering gap — the
  architecture is finished and the only open question is a change to a frozen
  vocabulary. Recorded as a correction rather than quietly dropped.

---

## 5. Teaching / challenge / communication style

`J4_IDENTITY.md`'s "deliberately unbuilt" list, audited item by item: the
three-level teaching framework, the confidence threshold for "worth challenging",
the tenure/competence signal that modulates teaching depth, and per-owner
communication-style preference as a `Belief`-eligible pattern.

**No existing contract covers any of them.** Each names a behaviour without
specifying when it fires or what it changes, and all four would be J4 changing
how it *talks* based on inferred judgements about the owner — the highest-risk
category of change in this product and the one least verifiable without a model.

- **Decisions required:** all of them, and they are genuine product design.
- **Safe to authorise immediately?** No. These need a design pass before a
  contract, not a contract before a build.

---

## Recommended order

1. **D3** — smallest, closes the one genuinely non-idempotent path, needs no
   other decision.
2. **PD4** — small, high value, and the audit showed it is safer than it looked.
3. **D1/D2** — once decided.
4. Everything else needs design, not authorisation.
