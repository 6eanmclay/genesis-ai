# D4 — an approval whose execution started and never resolved

**Status: DECISION-READY. NOT IMPLEMENTED.** 2026-08-23.

The recovery policy is now **resolved and argued** — option (b), evidence then
time — on two architectural facts that were not visible from the failure modes
alone. It awaits Sean's approval of that policy, not further analysis.

## The race, exactly

`performApproveGenesisAction` (`app/dashboard/ai-actions.ts`):

1. `reachableApproval(id, { status: "PENDING_APPROVAL" })` — reads the row;
2. `execute(definition.executable, input, ctx)` — the real change;
3. `approvalRequest.update` — sets `EXECUTED` (or leaves it pending on `FAILED`).

Between 1 and 3 the row still reads `PENDING_APPROVAL`. Two callers both pass
step 1 and both execute. Reachable from a double-click, an impatient retry, the
J4 chat path and the Approve button at once, or two devices.

`ApprovalRequest.status` today is `PENDING_APPROVAL | EXECUTED | REJECTED |
SUPERSEDED` — a plain string, no in-flight member.

## Why today's fixes do not transfer

**Not a transaction.** That fixed proactive delivery (`dd75a37`), where all three
writes are database writes finishing in milliseconds. `execute()` calls image
generation and provider APIs; a database transaction cannot be held across it,
and trying would hold a row lock for the length of a network call.

**Not a unique constraint.** That fixed D3 (`2a1ab9a`), where the *result* is a
row whose uniqueness is expressible — one product per design. Here the result is
an arbitrary side effect: a theme update, a provider registration, an email. There
is no row whose existence means "this approval already ran".

So D4 genuinely needs an in-flight state, and an in-flight state genuinely needs
a recovery rule. That is why it is a decision and the other two were not.

## What each failure mode actually costs

| Failure | Today | With a claim, no recovery | With a claim + recovery |
|---|---|---|---|
| **Double-click** | Both execute. Two thefts of the same change; two growth-point deductions | Second refused. Correct | Correct |
| **Process crash mid-execute** | Row stays `PENDING_APPROVAL`; owner retries; the change may apply twice | Row stuck in-flight forever; owner sees a card that can never be approved | Reconciled |
| **Network timeout to a provider** | `execute()` returns FAILED (or throws) → row stays pending → retry is safe *if* the provider was not actually reached | Same, plus a stuck row if the process died waiting | Reconciled |
| **Deliberate retry after failure** | Works — the row is still pending | Works, provided a FAILED execution releases the claim | Works |

**Growth points.** `lib/execution/engine.ts` deducts only on a non-`FAILED`
outcome, inside its own `try`, and deliberately under-charges on a ledger error.
So a double execution is a double deduction — real money — and a crash *before*
the deduction under-charges, which the engine already documents as the right way
to be wrong.

**Owner-visible state.** A stuck row is the part that matters most. Today's
review page reads `PENDING_APPROVAL` rows, so a claimed-but-unresolved approval
would either vanish from the list (invisible) or sit there un-approvable
(confusing). Neither is acceptable without a rule, which is the whole reason this
is not already built.

## The smallest viable model

**One new status: `EXECUTING`**, plus one nullable `claimedAt` timestamp.

- **Claim.** `updateMany({ where: { id, storeId, status: "PENDING_APPROVAL" },
  data: { status: "EXECUTING", claimedAt: now } })`. `count === 0` means somebody
  else has it → return `not_found`, which is already this function's answer for
  "there is nothing here for you". Atomic in one statement; no transaction held
  across the external call.
- **Resolve.** On success → `EXECUTED`. On `FAILED` → back to `PENDING_APPROVAL`
  with the `executionId` recorded, exactly as today.
- **Recover.** The open question below.

Every other property already holds: the business is resolved from the approval's
own row, `execute()` still does the verification, and the owner still decides.

## The decision, resolved: (b), evidence then time

Sean asked for the safest practical policy, argued against the architecture. Two
facts settle it, and neither was visible from the failure modes alone.

### Fact 1 — the caller can choose the executionId

`execute()` generates an `executionId` internally (`engine.ts:100`) **but accepts
one**: `opts.executionId`, documented there as "the executionId of a prior
PENDING row, to record this call as its". `ExecutionLog.executionId` is a real
indexed column.

This is what makes evidence-based recovery *exact* rather than a guess. The claim
can mint the id, store it on the approval, and hand it to `execute()`. Recovery
then asks a precise question — *is there an execution row for THIS attempt* —
instead of inferring from elapsed time.

Without this the honest answer would have been (c), because "has it been five
minutes" tells you nothing about what a provider did.

### Fact 2 — the execution row is written before the money moves

`engine.ts` calls `recordExecution(result)` (line 243) and only then
`deductGrowthPoints` (line 259), inside its own `try`, deliberately
under-charging on a ledger error. So an execution row's existence proves the work
completed, and its absence proves the deduction never happened.

That gives recovery a total order to reason against:

| Died after | Execution row | Points taken | Recovery does |
|---|---|---|---|
| run() completed, before recordExecution | no | no | **releases → owner retries → the provider work repeats** |
| recordExecution, before deduction | yes (SUCCESS) | no | marks `EXECUTED`; under-charged |
| deduction | yes | yes | marks `EXECUTED`; correct |
| run() failed | yes (FAILED) | no | releases; correct — retry is real |

### The answer to the question as asked

**"J4 starts an external execution, the database still says PENDING, and the
provider's outcome is unknown."** Under (b) the database never says `PENDING`
during execution — that is the defect. It says `EXECUTING` with an
`executionId`, and the provider's outcome stops being unknown the moment
recovery reads the execution row for that id. Unknown collapses to a real
question with a real answer, except in one window.

### The residual risk, stated rather than glossed

**One window remains unrecoverable: the process dies after the provider
succeeded and before `recordExecution` runs.** No evidence exists, recovery
releases the row, the owner retries, and the provider operation happens twice.

It cannot be closed from this side — closing it means an idempotency key at each
provider, which is per-connector work and a separate milestone. What can be said
honestly:

- The window is milliseconds between two adjacent statements, versus today's
  window which is the entire duration of the external call.
- Growth points are safe in it: no execution row means no deduction, so a repeat
  charges once in total.
- The only executable that registers with a provider is
  `createProductFromDesignExecutable`, and D3's unique index already refuses a
  second product for the same design — so the highest-stakes case is covered by
  work already shipped.

### Why not the others

**(a) time alone** — releases on elapsed time with no evidence, so it re-runs
changes that actually succeeded. That is the defect this milestone exists to
remove, reintroduced with a delay on it. Rejected outright.

**(c) never automatic** — safe, and it puts an internal failure in front of the
owner as a decision they cannot make: they have no way to know whether the
provider ran. It also strands the approval until somebody notices. Reasonable
only if Fact 1 were false.

### Where recovery runs

At the start of `getPendingApprovals` — the read the review page already makes.
No scheduler, no new entry point, and it happens exactly when somebody is looking
at the list a stuck row would otherwise be missing from. A row still `EXECUTING`
with no execution row after a short grace period (to avoid racing a live
execution) is released; one with a row is resolved to match it.

The grace period is the only tunable, and it guards nothing but a live in-flight
call — it is not a correctness parameter.

## Verification, once decided

- Two concurrent approvals of one request: exactly one executes; the other gets
  `not_found`; exactly one growth-point deduction. **The test must enter the
  race**, not check the state after one — a sequential version passes against
  today's code.
- A row left `EXECUTING` with a successful `ExecutionLog` reconciles to
  `EXECUTED` and does not re-run.
- A row left `EXECUTING` with no execution row returns to `PENDING_APPROVAL` and
  is approvable again.
- A `FAILED` execution releases the claim immediately, without waiting.
- Negative controls: the claim made non-atomic (read-then-write); recovery
  releasing a row whose execution succeeded; a stuck row never surfacing.

- **Credentials:** none. **Size:** medium — one migration, one function, one
  sweep, one suite. **Depends on:** nothing. **Blocks:** nothing.
- **Safe to authorize:** yes, once the decision above is made. Not before —
  shipping (a) and discovering it double-executed would be worse than the race.
