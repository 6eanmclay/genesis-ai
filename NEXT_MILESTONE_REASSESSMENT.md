# Repository reassessment — after Verification Hardening

**2026-08-24, second pass. Audit only.** No implementation, no API credit, no
live model. Written against the code at `e1c5dc0`.

Supersedes the first pass (2026-08-23), which is preserved in git history. The
old roadmap is not an authority here; the code, the verification inventory, and
the closed contracts are.

---

## 1. What is genuinely complete

| | Evidence |
|---|---|
| **Verification Hardening** | 33/33 executables verify; `verify` is a **required** interface member, so omission does not compile |
| — and it covers autonomous runs | verification sits inside `execute()` with no `actorType` condition, so J4's own acts are read back on the same terms as an owner's |
| **Three verification states** | `SUCCESS+true` / `WARNING+false` / `SUCCESS+false`, decoded in one place (`verificationLabel`), no fourth status, no migration |
| **Owner facts** (`offering`/`intent`) | `ownerFacts.ts`, entity-registry types, 53 assertions |
| **UI6** all three pieces | accepted on live evidence |
| **D4, U1–U6, M1–M9** | unchanged, previously closed |
| **Provenance discipline** | all 12 write sites pass explicit provenance |
| **Tool registries** | 19 declared = 19 policy = 17 handlers + 2 declared exceptions |
| **Authorization** | `firstRefusedTool` at three call sites, defence in depth |
| **The verification inventory** | 186 suites classified; its shared-runner count *calls* the runner's own decision, so it cannot disagree |

**Money and authority were swept this pass and found covered** — five suites over
the Growth Points ledger, `verify-approval-recovery` and `verify-autonomy-live`
over the authority path, and the engine's four named bypasses each
independently re-validated. No finding.

---

## 2. What remains genuinely weak or unverified

### 2.1 The 76 standalone suites still have no runner

`verification-inventory.ts --plan` **lists** them. Nothing **runs** them. There
is no `npm test` at all — `package.json` has `build`, `lint`, and
`test:e2e` (Playwright) and nothing else.

| Lane | count | runs by |
|---|---|---|
| shared runner | 41 | one command |
| standalone, no database | **76** | **nothing** |
| own infrastructure | 60 | by hand |
| named exclusions | 9 | by hand |

Half the problem closed last pass: we now *know* what exists. The other half —
that knowing is not running — is open, and it grows with every suite added.

### 2.2 Verification does not reach the surface owners actually read

`lib/j4/messageState.ts:60` derives message state from **`status` only**. It
never reads `verified`. So in the conversation — the surface an owner spends
their time in — a `SUCCESS` row reads `"done"` whether it was verified, or
merely not checkable.

**Stated honestly, the practical exposure today is near zero.** A *failed*
verification already reaches the owner, because it sets `WARNING` and
`messageStateOf` maps that to `failed`/`failed_retryable`. What does not reach
them is the difference between Verified and Verification unavailable on a
success — and exactly **one** action can currently return unavailable
(`integration.*.verify`), which is not a conversational action at all.

So this is a **latent** gap that grows as more unavailable cases appear, not a
live defect. It is recorded rather than escalated.

### 2.3 The fact model — unchanged and still the sharpest

From `J4_FACT_MODEL_FINDINGS.md`, deliberately not patched:

- `factCapture.ts:51-55` accepts `goal | challenge | employee | location`. If
  the owner says *"we sell something different now"*, **J4 has nowhere to put
  it.**
- **A Belief can be dismissed by the owner; a Fact cannot.** `beliefReview.ts:276`
  retires a belief as *"dismissed by the owner"*. No `BusinessRecord` has an
  equivalent. That is backwards: a Belief is J4's own inference, held tentatively
  by design; a Fact is often the owner's own testimony.
- **Three change mechanisms across seven types, and four with none** — goals use
  `status`, assets a supersession chain, `offering`/`intent` overwrite silently,
  `location` has nothing.
- Of 17 entity types, **3** are visible to the owner, via a pane that is
  read-only by deliberate UI6 decision.

### 2.4 `edit_store_content` still bypasses the engine

`app/dashboard/ai-actions.ts:2771` writes store content directly. Documented at
`ARCHITECTURE.md:128` as the single declared exception. **It is now the only
significant write path with no verification**, which is a sharper statement
after this milestone than before it.

### 2.5 Smaller, real

- **Two lint errors**, `app/dashboard/useJ4Talk.ts:355` and `:414` — *"This value
  cannot be modified"*, pre-existing from `6fcdeb8`. Errors, not warnings.
- **`"Upload Videos is coming soon"`** — `storeChatUnified.ts:36` promises a
  capability that does not exist.
- **`codeOnly` is duplicated in three suites** now. `ARCHITECTURE.md` says to
  move it to `scripts/lib/` on second use.

---

## 3. Architectural / product-critical versus safely deferrable

### Product-critical

| | Why |
|---|---|
| **2.3 the fact model** | J4 holds beliefs about a business that the person running it can neither see nor correct. Every future capability reasons from this model, so the cost of leaving it compounds |
| **2.1 the standalone runner** | 76 suites nobody runs is not a missing feature — it is a standing misrepresentation of how much is actually checked |

### Architecturally real, safely deferrable

| | Why deferrable |
|---|---|
| 2.4 `edit_store_content` | Documented, deliberate, and stable. Retiring it is a large change whose value is consistency, not a capability the owner lacks |
| 2.2 verification → conversation | Near-zero live exposure; grows only as unavailable cases appear |

### Safely deferrable

2.5 in full — real, small, and none of it blocks anything.

**Provider-blocked, and not defects:** the EasyPost label read-back, Stripe and
PayPal remote grant state, `CLASSIFY_FIXTURE_URL`, `RESEND_API_KEY`. **No API
credit is to be spent on these.**

**Still separate, still unmeasured:** the policy-refusal branch, `offering` →
routing (item 14), the 48/50 model-choice discrepancy.

---

## 4. Recommended next milestone

### First, and small: give lane 2 a runner

Before the milestone, not as part of it. `--plan` already produces the list; what
is missing is a command that runs it and reports **its own lane's** count. Hours,
no credit, and it protects everything after it — including the milestone below,
whose tests will land in that lane.

### The milestone: **the Business Fact Lifecycle**

Sean's own sequencing put the fact model second, and this pass finds nothing that
displaces it. The evidence is stronger than "the vocabulary is short".

**Why it has the highest leverage:**

- **Product value.** The one thing J4 is for is knowing the business. Today it
  can hold a wrong fact about what a business *sells* and the owner has no way to
  correct it. That is not a missing feature; it is the core relationship failing
  quietly.
- **Actual incompleteness — measured.** 4 of 17 types are conversationally
  writable. 3 of 17 are visible. 3 change mechanisms exist and 4 types have none.
  One correction path exists in the whole model, and it is on the *inferences*
  rather than on the *testimony*.
- **Architectural leverage.** Every capability downstream — the digest, the
  proactive layer, teaching, challenge, the belief channel — reasons from this
  model. Each one built before it is fixed inherits the defect.
- **Evidence available.** Entirely deterministic. Provenance, supersession, and
  correction are all database-level. **No live model needed.**

**Why not the alternatives.** `edit_store_content` buys consistency, not
capability. Verification-to-conversation has near-zero live exposure today.
Teaching and the belief channel are blocked on decisions, and both would be built
*on top of* the fact model — doing them first means building on the thing that
needs fixing.

The contract is `BUSINESS_FACT_LIFECYCLE_CONTRACT.md`. **Nothing is implemented.**

---

## Files supporting this

- `lib/execution/engine.ts` — verification inside `execute()`, no actorType condition
- `lib/execution/verification.ts` — three states, one decoder
- `lib/j4/messageState.ts:60` — derives from `status`, never `verified` (2.2)
- `scripts/verification-inventory.ts` — the lane counts (2.1)
- `package.json` — no `test` script (2.1)
- `lib/businessModel/factCapture.ts:51-55` — the four-type union (2.3)
- `lib/intelligence/beliefReview.ts:276` — the correction Facts do not have
- `lib/businessModel/ownerFacts.ts` — fixed `externalId`, overwrite on restate
- `app/dashboard/ai-actions.ts:2771` — the remaining unverified write path (2.4)
- `app/dashboard/useJ4Talk.ts:355,414` — two pre-existing lint errors
