# D4 — an approval whose execution started and never resolved

**Status: AUDIT AND CONTRACT. NOT IMPLEMENTED.** 2026-08-23.
The smallest viable recovery model, with the decision isolated at the end. No
policy has been chosen here.

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

## The decision — and it is one decision, not four

**D4 — how does a claimed approval that never resolved come back?**

- **(a) Time alone.** A row `EXECUTING` for longer than N minutes returns to
  `PENDING_APPROVAL`. Simple, needs no new reads — and it can re-run a change
  that actually succeeded, because time says nothing about what happened.
- **(b) Evidence, then time.** Before releasing, look for an `ExecutionLog` row
  for that `executionId`. Present and successful → mark `EXECUTED` (it did
  happen). Absent → release to `PENDING_APPROVAL`. This is not a guess: the
  engine writes that row before the growth-point deduction, so its presence is
  real evidence the work completed. Costs one indexed read per stuck row.
- **(c) Never automatic.** A stuck row stays `EXECUTING` and is surfaced to the
  owner as "I started this and lost track of it" with a manual retry. Safest,
  and puts a system failure in front of the owner as their problem.

**My reading, offered as a recommendation and not acted on:** (b). It is the only
option that distinguishes "never ran" from "ran and we lost the answer", and that
distinction is the entire risk. (a) can double-execute — the exact defect being
fixed. (c) is honest but asks the owner to adjudicate an internal failure.

**Where the sweep runs, if (b):** at the start of `getPendingApprovals` — the
read the review page already makes — so recovery happens when somebody looks,
with no scheduler and no new entry point. That detail is part of the same
decision and I would not choose it separately.

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
