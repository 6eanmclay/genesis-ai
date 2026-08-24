# Repository reassessment — what actually remains

**2026-08-24. Audit only. Nothing was implemented, no API credit was spent, no
live model was called.** Written against the code at `c157b37`, not against the
roadmap documents. Where a roadmap label and the repository disagree, the
repository wins and the disagreement is named.

---

## 1. What is actually shipped

Each row is the code that exists, not the label that claims it.

| Capability | Code | Evidence |
|---|---|---|
| **D4 — approval recovery** | `lib/dashboard/approvalRecovery.ts` (138) | `D4_APPROVAL_RECOVERY.md`; evidence-then-time policy, `executionId` as durable attempt identity |
| **U1–U6 — understanding** | `lib/businessModel/provenance.ts` (219), `relationships.ts` (496), `statements.ts` (273), `reasoning.ts` (1240), `understanding.ts` (231) | Provenance columns on `BusinessRecord`; typed `RecordRelationship` rows; `stateFact` fixes provenance by construction |
| **M1–M9 — BI engine** | `lib/intelligence/`, `lib/sourcing/` | `BI_ENGINE.md` §15 is the acceptance record, closed at `66078f1` |
| **UI6 Piece 1 — context pane** | `lib/j4/contextTypes.ts` (105), `app/j4/ContextPane.tsx` (99) | Closed registry, owner-initiated, read-only by construction |
| **UI6 Piece 2 — conversations** | `lib/j4/conversations.ts` (131), `app/j4/ConversationPicker.tsx` | `conversationInBusiness` is the checked value on the turn path |
| **UI6 Piece 3 — concise replies** | `lib/dashboard/storeChatPrompts.ts` | Measured live: 4 sentences/718 chars/9 areas → 2/358/1 |
| **Message state** | `lib/j4/messageState.ts` (114) | Derived from the execution row only, never from prose |
| **BusinessRecord provenance** | `prisma/schema.prisma`, `RecordProvenance` enum | **All 12 write sites pass explicit provenance** — verified this audit, no exceptions |
| **Owner offering/intent** | `lib/businessModel/ownerFacts.ts` (229) | Entity-registry types, no migration; `verify-owner-facts.ts` 53 assertions |
| **Understanding / digest** | `profile.ts` (341), `digest.ts` (278) | `identity.offering`/`intent` sit beside `description`, never merged |
| **Execution** | `lib/execution/engine.ts` (327), 24 executables | `execute()` is the single gateway; four named, re-validated bypasses |
| **Authorization** | `firstRefusedTool` at 3 call sites | Streaming route, Server Action, **and** the shared runner — defence in depth |
| **Tool coverage** | 19 declared = 19 in `TOOL_POLICY` = 17 handlers + `take_me_there` + `edit_store_content` | Cross-checked this audit; no orphan on any side |
| **Routing safety** | `lib/execution/toolPolicy.ts` (417) | `droppedNoticeFor` / `policyRefusedEverything`; both callers share one gate |

---

## 2. What is incomplete

### A. Implementation gaps — the product genuinely cannot do this yet

**A1. The verification stage of the architecture is 3/24 implemented.**
`ARCHITECTURE.md` describes proposal → authorization → execution → **verification**.
`Executable.verify?()` is optional, and only three implement it:
`updateHero.ts`, `refineStorefront.ts`, `answerSupplierEconomics.ts`. The other
**21 never verify their own work**. `lib/execution/engine.ts:216` initialises
`let verified = false` and only overwrites it if `executable.verify` exists.

This is not cosmetic: `verified` is **owner-visible** at
`app/dashboard/ExecutionStatusCard.tsx:50`, which prints `(verified)`. Across the
whole codebase `verified: true` is written **once**, in
`app/api/onboarding/fulfillment/callback/route.ts:121`, against 36 `verified: false`.

The three that exist are real read-back checks — `refineStorefront.verify` re-reads
`store.theme` and reports every dimension that did not land. Twenty-one more would
be the same kind of work, not ceremony.

**A2. `offering` and `intent` are write-once and invisible to the owner.**
They are recorded at `confirmStoreDraftCore` and read into the profile and digest,
but:
- `lib/businessModel/factCapture.ts:51-55` — `BusinessFactSchema` accepts only
  `goal | challenge | employee | location | none`. **`capture_business_fact`
  cannot record an offering or an intent.** If the owner says "we actually sell X
  now", J4 has nowhere to put it.
- No owner-facing surface displays either (deliberately out of scope for the
  field split; the consequence is now real).

So J4 can hold a belief about what the business sells that **the owner can
neither see nor correct** — the exact failure class named in the audit brief.

**A3. The most-used owner-facing capability bypasses the execution engine.**
`edit_store_content` writes store content directly at
`app/dashboard/ai-actions.ts:2771` via `prisma.store.update` + `diffStoreChanges`,
not through an `Executable`. This is **documented and deliberate** —
`ARCHITECTURE.md:128` names it "the single declared exception, because the legacy
content pipeline is its implementation" — but the consequences are real: no
`verify()`, no engine authorization path, and a second diff/log implementation
parallel to the engine's.

**A4. Belief channel — unwired.** No code surfaces a Belief to the owner.
**A5. Teaching / Challenge — no implementation exists.** Design pass only.

### B. Validation gaps — built, but not exercised against a real model or provider

**B1. No single command runs the test suite.** 184 `verify-*.ts` files exist:

| | count | how it runs |
|---|---|---|
| database-backed, in the shared runner | 41 of 49 | `run-db-suites.ts` |
| bring their own server/Postgres | 59 | by hand, individually |
| no database at all | 76 | by hand, individually |

**"41/41" — the green signal used all session — covers 41 of 184.** The other 143
run only if somebody remembers. This is the single highest-leverage validation
gap and it costs no credit to close.

**B2. Source-level assertions mostly do not strip comments.** 39 true
source-text assertions across 8 suites; **1 of 8** (`verify-owner-facts.ts`) uses
`codeOnly()`. `ARCHITECTURE.md` already records this rule. It also says to move
`codeOnly` into `scripts/lib/` "the moment a second suite needs it" — a second
suite now does, and it was copy-pasted instead.
**Honest result: I swept for false greens and found none.** The one
comment-satisfied assertion, `verify-store-currency.ts:273`, is deliberately
checking that an explanation exists and says so. The exposure is structural, not
a live defect.

**B3. M5 / M6 are verified as reads, not as production coverage.** `BI_ENGINE.md`
§15 records this: whether any real order carries `shippingCostInCents`, and which
`Order.status` values actually occur in production, are unmeasured.

**B4. Live items — carried forward verbatim, see §5.**

### C. External blockers — nothing to build

| Blocker | Blocks | Note |
|---|---|---|
| `CLASSIFY_FIXTURE_URL` | Live classification, employee-handbook loop | `classify.ts` sends a URL for the model to fetch; a local file cannot substitute |
| Anthropic credit | Item 14, policy-refusal live exercise, routing re-run | Deliberately preserved |
| `RESEND_API_KEY` | Customer + owner notifications | **The code is built.** `lib/orders/notifyCustomerShipped.ts:33` degrades honestly and logs that the customer was not told |
| M2 | Sean's, untouched | — |

### D. Product / design decisions — genuinely need Sean

- **D1.** Should `offering`/`intent` get an owner-facing surface, and should
  `capture_business_fact` be able to write them? (A2 is blocked on this.)
- **D2.** Belief Constitution — a constitution decision, not engineering.
- **D3.** Teaching / Challenge — needs a design pass before any code.
- **D4.** Does `edit_store_content` stay outside the engine permanently, or is
  retiring the legacy pipeline a real milestone? (A3.)
- **D5.** `ThemeSchema`/`CompositionSchema` are hand-synced between
  `lib/dashboard/storeChatPrompts.ts` and `lib/execution/genesisActions.ts:260`.
  Now resolvable since the prompts moved to `lib/`. **Untouched as instructed.**

---

## 3. The old roadmap, audited

Against `NEXT_AFTER_D4.md` and `VISION.md`.

| Item | Classification | Why, from the repository |
|---|---|---|
| 1 — Live-model validation | **PARTIALLY COMPLETE** | Routing validated 48/50; classification blocked on a fixture URL |
| 2 — J4's Understanding (U1–U6) | **COMPLETE** | Five modules, 2,459 lines, provenance disciplined at all 12 write sites |
| 3 — BI Engine (M1–M9) | **COMPLETE** | `BI_ENGINE.md` §15 acceptance record; two open items recorded, not scheduled |
| 4 — UI6 | **COMPLETE** | All three pieces; Piece 3 accepted on live evidence. **Fully consumed** |
| 5 — Teaching / Challenge | **STILL VALID, needs design** | No code. Requires D3 first |
| 6 — Belief Constitution + channel | **STILL VALID, needs decision** | Channel unwired; the blocker is D2, not engineering |
| 7 — Integrations / operating layer / Growth Points | **PARTIALLY COMPLETE** | Connectors, execution, Growth Points ledger all exist. The *chapter* is not started |
| 8 — Final hardening / launch readiness | **NEEDS REDESIGN** | Written before U1–U6, M1–M9 and UI6. "Hardening" now means A1 and B1, which did not exist as concepts when it was written |
| `J4_WORKSPACE_ARCHITECTURE.md` | **OBSOLETE / SUPERSEDED** | By `GENESIS_SURFACES.md` (locked). Banner added `c157b37` |
| Social connections (Ch. 3–4) | **STILL VALID, deferred** | Built and paused by explicit decision |
| Mobile (Ch. 6) | **STILL VALID, not started** | `J4_APP_ROADMAP.md` frozen v1 |

**Is UI6 fully consumed? Yes.** All three pieces are implemented, and Piece 3's
prose acceptance was measured live rather than assumed.

**Do the following items still make sense? Item 8 does not.** It predates the
three milestones that have since shipped, and the things it would have hardened
are not the things that are now soft. Items 5 and 6 remain valid but are blocked
on decisions, not effort. Item 7 is a chapter whose infrastructure is already
built.

---

## 4. What the roadmap missed

Found by reading the code, not the documents.

1. **A1 — the verification stage.** No roadmap item covers it. It is named in
   `ARCHITECTURE.md` as part of the pipeline and is 12.5% built.
2. **B1 — 143 of 184 suites run only by hand.** No roadmap item covers it.
3. **A2 — a fact J4 holds that the owner cannot correct.** Created by the
   milestone that shipped yesterday; the natural completion of it.
4. **D5 — a hand-synced schema mirror** whose reason for existing was removed
   when the prompts moved.
5. **Two pre-existing lint errors**, `app/dashboard/useJ4Talk.ts:355` and `:414`
   — *"This value cannot be modified"*, from `6fcdeb8`. **Errors, not warnings.**
6. **`"Upload Videos is coming soon"`** — `lib/dashboard/storeChatUnified.ts:36`
   promises the owner a capability that does not exist. The only unbacked
   product promise found in the sweep.

**What the sweep did *not* find, stated because absence is evidence too:** zero
`TODO`/`FIXME`/`HACK` markers in `lib/` and `app/`; no placeholder behaviour
standing in for real work; no provenance write site missing an explicit
provenance; no orphan between the three tool registries; no false-green source
assertion.

---

## 5. Validation status, carried forward unchanged

Recorded as validation states, **not converted into defects**, because the
evidence does not say they are defects.

| Item | Status |
|---|---|
| UI6 Piece 3 live acceptance | **COMPLETE** |
| Routing safety defect | **FIXED** (`1e52963`) |
| Policy refusal branch | **NOT LIVE-EXERCISED** |
| 48/50 model-choice discrepancy | **UNRESOLVED** |
| Classification | **BLOCKED** on `CLASSIFY_FIXTURE_URL` |
| `offering` → routing (item 14) | **UNMEASURED** |

---

## 6. Recommendation

### Before the milestone: close B1 (small, no credit)

**Make one command run every suite.** 143 of 184 currently run only if
remembered, and the milestone below adds ~21 more assertions whose value depends
on being run. This is hours, not days: the runner already detects suites that
bring their own infrastructure (`run-db-suites.ts:65`), so what is missing is a
second lane for the 76 no-database suites and a named lane for the 59.

Do this first because it protects everything after it.

### The milestone: **complete the verification stage**

Contract level, not implemented.

**Why this one, against the four criteria:**

- **Product value — high.** This session's governing principle was *"never tell
  the owner something happened when the execution state says otherwise."* UI6
  applied it to how messages are rendered. A1 is the same principle at the
  layer underneath, where the execution state is *produced*. Today 21 of 24
  actions report success without ever re-reading what they wrote, and the owner
  sees `(verified)` missing without being told why.
- **Actual incompleteness — measured, not assumed.** 3 of 24. One
  `verified: true` in the entire codebase.
- **Architectural leverage — the highest available.** `verify()` already exists
  on the `Executable` interface and the engine already calls it. Nothing is
  designed; 21 gaps are filled against a contract that is already load-bearing.
- **Evidence available — fully deterministic.** Every verification is a database
  read-back. **No API credit, no live model, no external dependency.**

**The contract:**

1. Every `Executable` in `lib/execution/executables/` implements `verify()`.
2. `verify()` re-reads persisted state and compares it against what the input
   asked to change — the shape `refineStorefront.verify` already uses, reporting
   *which* fields did not land rather than a bare boolean.
3. An executable that genuinely cannot verify (an outbound side effect with no
   readable trace) **declares that explicitly** rather than omitting the method,
   so "not verifiable" and "nobody implemented it" stop looking identical.
4. The owner-facing surface distinguishes **verified**, **unverified**, and
   **not verifiable** — three states, not a present/absent flag.
5. Every `verify()` gets a negative control: break the write, confirm
   verification fails.

**Explicitly not in it:** no change to `edit_store_content`'s path (that is D4),
no change to `genesisActions.ts` (D5), no new executables, no redesign of the
engine.

### What can safely wait

- **Item 14, policy-refusal live exercise, routing re-run** — all need credit;
  none blocks the milestone above.
- **Classification** — externally blocked.
- **Teaching/Challenge, Belief channel** — blocked on D2/D3, which are decisions.
- **Social, Mobile** — deferred by explicit decision.
- **The `useJ4Talk.ts` lint errors and the "coming soon" string** — real, small,
  and not worth a milestone.

### If the answer were validation instead

It partly is — B1 is validation work and is recommended **first**. But B1 alone
does not close a product gap, and A1 does. The honest sequence is: make the
suites runnable, then make execution verifiable.

---

## Files and paths supporting this conclusion

- `lib/execution/engine.ts:216-225` — `let verified = false`, overwritten only if `executable.verify` exists
- `lib/execution/executables/` — 24 files; `verify()` in `updateHero.ts`, `refineStorefront.ts`, `answerSupplierEconomics.ts`
- `app/dashboard/ExecutionStatusCard.tsx:50` — `verified` is owner-visible
- `app/api/onboarding/fulfillment/callback/route.ts:121` — the only `verified: true`
- `lib/businessModel/factCapture.ts:51-55` — the closed set that excludes `offering`/`intent`
- `app/dashboard/ai-actions.ts:2771` — the store write outside the engine
- `ARCHITECTURE.md:128` — that bypass, declared
- `scripts/run-db-suites.ts:65` — the own-infrastructure detector B1 would build on
- `lib/dashboard/storeChatUnified.ts:36` — "Upload Videos is coming soon"
- `app/dashboard/useJ4Talk.ts:355,414` — two pre-existing lint errors
- `lib/execution/genesisActions.ts:260` — the hand-synced schema mirror (D5, untouched)
