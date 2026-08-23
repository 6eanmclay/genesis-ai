# Work that started and did not finish

**Status: DECISION REQUESTED. Nothing here is implemented.**
Written 2026-08-23, after the Unified Intelligence audit. Sean asked for the
failure modes and the smallest set of decisions needed to choose the semantics,
without a policy being invented for him.

Two problems, both the same shape: something real happened, and then the thing
that was supposed to record or complete it did not. In both cases today's
behaviour is not a considered choice — it is what fell out of code written when
a turn ran one tool and an approval was clicked once.

---

## Problem 1 — a turn that half-ran

### What is true today

`runPlannedTools` (`lib/dashboard/runToolTurn.ts`) runs the planned tools in
order and collects their results. **Nothing is written down until every tool has
finished.** `persistToolTurn` — the merchant's message, the assistant replies,
the execution-log rows — runs only after the whole loop returns.

There is no `try`/`catch` around the loop. A handler that throws propagates:

- **On the streaming route**, the outer `catch` at `app/api/chat/route.ts:653`
  emits `{ type: "fallback" }` and closes the stream. The client then submits
  the same message to the Server Action, which runs **the entire turn again**.
- **On the Server Action**, the throw propagates out of the action to Next.

Either way: **no message is stored, no execution row is written, and the owner
is shown the result of a different code path.**

### The failure mode

Policy allows up to three tools per turn and at most one mutation, so a plan can
put a real state change ahead of a tool that throws. Four handlers write
something before the turn ends:

| Handler | What it does before returning |
|---|---|
| `capture_business_fact` | writes a `BusinessRecord`, resolves/creates observations |
| `manage_business_asset` | `store.update` — sets `logoUrl`, sets the hero |
| `approve_pending_changes` | executes approved changes against the live store |
| `approve_design_as_product` | creates a real, buyable product through `execute()` |
| `request_*` (three of them) | creates an `ApprovalRequest` the owner will see |

So: *"Set that as my logo, and what sold worst last month?"* — the logo is set,
the data question throws, nothing is persisted, and the owner is answered by the
legacy content pipeline. The logo really changed. Their conversation contains no
record that it did.

Two consequences worth separating:

1. **The record is lost.** The work happened and the conversation does not say
   so. This is the same class as a change J4 claims but did not make, arriving
   from the other direction.
2. **The work may repeat.** On the streaming route the fallback re-runs the
   whole turn, mutation included.

### How bad is (2) in practice

Better than it looks, and not by design. Most of these are idempotent by
accident of how they were written: `store.update` sets the same URL twice,
`capture_business_fact` upserts, and the three `request_*` handlers supersede
their own pending proposal rather than stacking a second one.

**`approve_design_as_product` is the exception.** It creates a product. Running
it twice creates two.

I have not observed this in production and am not claiming it has happened. The
window is real; how often a handler throws after a successful mutation is
unknown, because until this milestone nothing logged enough to tell.

### The decisions

**D1 — When a tool throws after earlier tools succeeded, what is recorded?**

- **(a) Nothing, as today.** The turn never happened as far as the conversation
  is concerned. Simple; keeps the fallback path exactly as it is. The owner's
  logo silently changed.
- **(b) Persist what succeeded, then say the rest did not.** The conversation
  matches reality. Costs a new `ToolTurnResult` shape for "this one threw" and a
  sentence to write for it.
- **(c) Persist what succeeded and stay silent about the failure.** Cheaper than
  (b) and I would argue against it — it is the "reported the something else as
  though it were the answer" failure this milestone spent itself removing.

**D2 — If (b) or (c), does the streaming route still fall back?**

Falling back after persisting means the Server Action re-runs the turn and the
mutation happens a second time. Not falling back means the owner gets a partial
answer and no second attempt.

- **(a) Persist and do not fall back.** The turn ends where it broke.
- **(b) Persist and fall back, having marked the completed tools so the re-run
  skips them.** More faithful, and needs turn-level state that does not exist.

**D3 — Is `approve_design_as_product` allowed to remain non-idempotent?**

Independent of D1/D2, and answerable on its own. A second identical
create-product-from-design in the same turn window could be refused by the
executable rather than by the turn machinery.

- **(a) Leave it.** The window is narrow.
- **(b) Make the executable refuse a duplicate** for the same design within some
  window.

### What I would recommend, clearly labelled as a recommendation

**D1(b), D2(a), D3(b).** D1(b) because the standing rule in this codebase is
that the record matches what happened. D2(a) because a second attempt that
silently re-runs a mutation is worse than an honest partial answer. D3(b)
because it is the only genuinely non-idempotent path and it can be fixed without
touching turn semantics at all — it does not need D1 or D2 decided first.

**None of this is built.** D3 is separable and could be done alone.

---

## Problem 2 — an approval executed twice

Adjacent, same shape, and found in the same audit. Including it because it is
the other place where in-flight work has no state.

### What is true today

`performApproveGenesisAction` (`app/dashboard/ai-actions.ts`):

1. reads the row, requiring `status: "PENDING_APPROVAL"`,
2. calls `execute(...)` — the real change,
3. **then** sets `status: "EXECUTED"`.

Between 1 and 3 the row still reads `PENDING_APPROVAL`. Two concurrent calls —
a double-click, an impatient retry, the J4 chat path and the Approve button at
once — both pass step 1 and both execute.

Growth points are deducted per successful execution, so a double execution is
also a double charge.

### Why I did not just fix it

The obvious fix is to claim the row before executing:

```
updateMany({ where: { id, status: "PENDING_APPROVAL" }, data: { status: <claimed> } })
if (count === 0) return not_found
```

That introduces a state which means *"execution started and we do not know how
it ended"*, and therefore a policy: what happens to a row stuck there when the
process dies mid-execute? Reverting on a timeout risks re-running a change that
did land; leaving it stuck strands the approval. That is a semantics decision,
which is what you told me not to invent.

### The decision

**D4 — What happens to an approval whose execution started and never resolved?**

- **(a) Leave the race.** No new state, no recovery policy. Double execution
  stays possible.
- **(b) Claim, and revert on a failed execution only.** Closes the double-click
  window. A crash mid-execute strands the row until somebody looks.
- **(c) Claim with a recovery rule** — a timeout, or a startup sweep that
  reconciles claimed rows against their `ExecutionLog`. Closes the window and
  self-heals; the most work, and the reconciliation itself needs to be right.

I have no strong recommendation between (b) and (c) without knowing how you want
stuck work surfaced, which is a product question about the review page rather
than an engineering one.

---

## What is not being asked here

- Nothing about the tool-result → model loop. That is blocked on
  `ANTHROPIC_API_KEY`, separately.
- Nothing about UI6 or the conversation view, though D2 touches what the owner
  sees when a turn breaks, and would be easier to answer after it.
