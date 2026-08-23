# D1/D2 — partial-turn semantics, ready to authorize

**Status: SHIPPED 2026-08-23** (`54a272d`). Implemented as written, D1(b) + D2(a).
Supersedes Problem 1 of `PARTIAL_TURN_SEMANTICS.md`, which stated the failure
modes. This states the semantics. **D4 remains separate and is not assumed here.**

## What changed since that document

**D3 is solved** (`2a1ab9a`). `approve_design_as_product` — the one genuinely
non-idempotent handler — is now refused by a database constraint, and a refused
attempt costs no growth points. That removes the worst consequence of a re-run
turn and, importantly, **changes what D1/D2 have to protect against**: every
mutating handler is now safe to run twice.

That is worth being precise about, because it is the difference between "we must
never re-run a turn" and "re-running a turn is untidy but not harmful."

## The failure, restated exactly

`runPlannedTools` has no `try`/`catch`, and `persistToolTurn` writes nothing
until every tool returns. So when handler #2 throws after handler #1 mutated:

- the mutation is real and durable;
- no message, no assistant reply and no execution row exist;
- the streaming route emits `fallback`, the client re-submits, and the Server
  Action **runs the whole turn again**.

## Retry safety, handler by handler — the table D1/D2 depend on

| Handler | Mutates | Safe to re-run | Why |
|---|---|---|---|
| `capture_business_fact` | `BusinessRecord`, observations | **Yes** | upsert on (store, entity, external id) |
| `manage_business_asset` | `store.logoUrl`, hero | **Yes** | sets the same value |
| `request_image_change` | `ApprovalRequest` | **Yes** | supersedes its own pending row |
| `request_product_removal` | `ApprovalRequest` | **Yes** | supersedes its own pending row |
| `request_product_content_change` | `ApprovalRequest` | **Yes** | supersedes its own pending row |
| `plan_campaign` | `ApprovalRequest` | **Yes** | supersedes its own pending row |
| `create_design` / `create_composition` | `BusinessRecord` | **Yes** | a second design is additive, not corrupting |
| `generate_brand_logo` | asset + `store.logoUrl` | **Yes** | same value; a second generation costs points |
| `approve_design_as_product` | **Product** | **Yes, since D3** | unique index refuses the second; no charge |
| `approve_pending_changes` | executes approved changes | **Yes** | status transition guards each item |
| `answer_supplier_economics` | economics record | **Yes** | keyed upsert |

**Nothing in the tool surface is unsafe to re-run.** Two caveats, both real and
neither a correctness problem:

1. **Re-running costs growth points** where the handler generates (logo, design,
   composition). The owner pays twice for one request.
2. **`create_design` twice makes two designs.** Additive, visible, and the owner
   can delete one — annoying, not wrong.

## The semantics being proposed

**D1 — what is recorded.** Persist what actually succeeded, then say plainly that
the rest did not.

- The merchant's message is written.
- Each successful handler's reply is written, with its execution row, exactly as
  today.
- One further assistant message states that the remainder did not happen.
- The failed tool's execution row is `WARNING`, `retryable: true`, with the real
  cause in `logMessage` and the owner-facing sentence in the message — the split
  `approve_pending_changes` already uses.

**What the owner sees**, concretely, for *"Set that as my logo, and what sold
worst last month?"* with the second tool throwing:

> Done — that's your logo now.
>
> I couldn't get to the rest of that — nothing else changed. Ask me again and
> I'll pick it up.

Today they see neither sentence and the logo silently changed.

**D2 — the route does not fall back.** The turn ends where it broke.

The alternative is falling back and re-running, and although the table above says
that is now *safe*, it is not *honest*: the owner has already been told the logo
was set, and a re-run would tell them again. D2(a) also removes the double-charge
case, since nothing regenerates.

**Non-retryable handling.** A tool that throws is `retryable: true` by default —
nothing was recorded for it, so trying again is real. The exception is a throw
whose message indicates a permission refusal, which `approve_pending_changes`
already distinguishes: that is `retryable: false`, because repeating it sends the
owner into the same wall.

## Implementation surface

- `lib/dashboard/runToolTurn.ts` — a `try`/`catch` in the loop; a fourth
  `RunToolsOutcome` variant carrying the results so far plus the failed tool;
  `persistToolTurn` gains the "and the rest did not" message.
- `app/api/chat/route.ts` — the new variant persists and emits `done`, not
  `fallback`.
- `app/dashboard/ai-actions.ts` — the same variant persists and redirects.
- No schema change. No new state. **No dependency on D4.**

## Verification

- A stub handler that throws after a real mutation: the mutation is present, the
  first reply is stored, the "rest did not happen" message is stored, and the
  failed tool's execution row is `WARNING` + retryable.
- The route does not emit `fallback` for that turn (so the Server Action does not
  re-run it) — asserted at the emitted-event level.
- The retry-safety table above becomes assertions: each mutating handler run
  twice leaves the same end state. This is worth having on its own merits, and it
  is what makes the D2 decision checkable rather than argued.
- Negative controls: swallowing the failure silently; marking a permission
  refusal retryable; falling back after persisting.

- **Credentials:** none. **Size:** medium. **Safe to authorize:** yes.
