# What is actually next — an honest position, not a manufactured milestone

**2026-08-23, after D1/D2, D3, D4 and PD4 all shipped.**

The approved backlog is empty. Rather than invent a milestone to fill the gap,
this records the real candidates with their true value, so the next decision is
made on evidence.

## The defect audit is clean

Every surface Sean named has been swept this session, and the sweeps that found
things have been turned into standing assertions rather than left as one-off
scripts:

| Surface | Result |
|---|---|
| Tenant isolation | `groupBy` guarded (was the one unguarded collection read); the guarded-operation list is now itself asserted |
| Business scoping | 4 defects fixed; every remaining read is store-scoped or structurally unable not to be |
| Authorization | `firstRefusedTool` over the whole planned turn, repeated inside the runner |
| Execution / idempotency | D3 (one product per design), D4 (claim + evidence recovery), proactive delivery transaction |
| Growth Points | No charge on a refused execution, none from recovery — both asserted |
| Approval state | D4; blast radius of the new `EXECUTING` status checked — every approval filter is explicit equality, none uses `not:` |
| Proactive delivery | 2 defects fixed (triple delivery, repeat after dismissal) |
| Provenance | Unchanged this session; its own suite passes |
| Conversation state | UI6 message state, D1/D2 partial turns, the emit fix |

**40/40 database suites.** No known defect remains.

## The candidates, ranked honestly

**1. Provider idempotency keys — LOW value, despite closing D4's residual window.**
The window is a process dying between provider success and `recordExecution`:
two adjacent statements. The only executable that registers with a provider is
`createProductFromDesignExecutable`, and D3's unique index already refuses the
duplicate it would produce. So this closes a millisecond gap on a path already
protected. Real, and not worth doing next.
*Also externally blocked for honest verification: Printful.*

**2. Live verification of everything shipped — HIGH value, blocked.**
Twelve days of work is verified deterministically and almost none of it against
a real model or a real provider. The routing suite's live half, the tool-result
loop, classification closing the handbook ask, and whether J4's proactive
sentences read well are all unanswerable without `ANTHROPIC_API_KEY`. This is
the largest genuine gap in confidence and no amount of further building reduces
it.

**3. UI6's three parked pieces — need design, not authorization.**
Business context beside the conversation (undesigned by §7's own admission),
navigable history (no threading model — what a "conversation" is has never been
decided), concise-summary replies (blocked as a unit on a model).

**4. Teaching / challenge / communication style — need design.**
Four items in `J4_IDENTITY.md`'s "deliberately unbuilt" list, each naming a
behaviour without specifying when it fires. All four would change how J4 talks
based on inferred judgements about the owner — the highest-risk category in this
product and the least verifiable without a model.

**5. The Genesis Language belief channel — a Constitution decision.**
Not engineering. The vocabulary is frozen.

## What I would say if asked

The buildable surface that does not need a product decision or a credential is
genuinely exhausted. The next most valuable thing is not more code — it is
`ANTHROPIC_API_KEY`, which converts several suites from "skipped, loudly" into
real evidence about behaviour nobody has yet observed.

Failing that, (3) and (4) are real product work, and both start with a design
pass rather than a contract.
