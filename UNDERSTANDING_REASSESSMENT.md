# J4's Understanding of Your Business — reassessment

**2026-08-24. Audit only.** Nothing implemented, no API credit, no live model.
Written against the code at `6d2dae5`, after Business Fact Lifecycle.

Evidence base: the repository, the closed contracts, the verification inventory,
and the recorded findings. **Not the old roadmap.**

Two claims I started to make and withdrew after checking are marked **[withdrawn]**
below, because a reassessment that only reports what it expected to find is not
an audit.

---

## 1. What is genuinely complete

| | Evidence |
|---|---|
| **The fact lifecycle** | Correction, supersession, preserved history, explicit contradiction targets. `factLifecycle.ts`, `verify-fact-lifecycle.ts` |
| **Provenance at every write** | Six kinds; all write sites pass it explicitly; `captureBusinessFact` now routed through `stateFact`, so owner testimony has one path |
| **Verification** | 33/33 executables read back; `verify` required by the compiler |
| **The entity registry** | 17 types, closed, schema-validated, `Object.hasOwn` guarded |
| **A typed relationship graph** | 8 kinds, 9 entity types projecting into `RecordRelationship` |
| **The canonical model exists** | `getBusinessUnderstanding` → `BusinessProfile`: identity, classification, offerings, revenue, customers, people, suppliers, connected systems |
| **Grounding** | `groundingRules`, `unsourcedCount`, digest sourcing counts — J4 can say how well-sourced a claim is |

**[withdrawn] "The digest omits revenue, customers and employees, so J4 cannot
see them."** It omits them, but `look_up_business_data` sends the **whole
profile**, and `buildChatDataContext` adds revenue, invoices, campaigns and
appointments on top. The digest's compactness is a deliberate routing/answering
split against a 2,400-character budget, not a blindness.

**[withdrawn] "Connector data never reaches the conversation."** Invoices,
campaigns and appointments do reach it — through `buildChatDataContext`, not
through the profile. Which is itself the finding in §2.1.

---

## 2. What is genuinely weak

### 2.1 "What J4 knows" is assembled more than once — CRITICAL

There is a canonical model, and then there are additions each consumer makes for
itself:

| Assembler | Adds beyond the canonical model | Used by |
|---|---|---|
| `getBusinessUnderstanding` → `getBusinessProfile` | — (it **is** the canonical model) | ~12 consumers |
| `buildChatDataContext` (`reasoning.ts:1193`) | revenue, invoice/campaign/appointment summaries, upcoming appointments | the `look_up_business_data` answer |
| `cognitiveLayer` (`:387-389`) | invoice, campaign, appointment summaries again | proactive reasoning |

**Measured duplication.** In a single `look_up_business_data` turn, the profile
performs 10 fetches and `buildChatDataContext` performs 6, and **`getRevenue` and
`getTopContacts` are computed by both** — the same figures, twice, in one turn,
both landing in the same payload sent to the model.

The file already warns against exactly this. `toolHandlers.ts:2015` refuses to
re-query the understanding because *"own understanding query is how a second
source of truth begins"* — and then the payload it builds does it anyway for
revenue.

**Why this is the critical one.** A third consumer inherits the canonical model
and silently knows *less* than the other two, unless whoever writes it remembers
which extra fetches to copy. That is not a hypothetical: it is how these two
diverged. Every capability that follows — reconciliation, the relationship graph,
teaching — has to be built once per assembler or it is built inconsistently.

### 2.2 No cross-source reconciliation — CRITICAL for the stated objective

J4 holds facts from six provenance kinds and has **no notion of them
disagreeing**. Contradiction is modelled only for `Belief`
(`beliefReview.ts` — `lastContradictedAt`, owner dismissal). For `BusinessRecord`
there is nothing.

The clearest instance sits inside one object:

- `profile.identity.offering` — what the owner says they sell
- `profile.offerings.items` — what is actually in the catalogue

**Nothing compares them.** `identity.offering` is read in exactly two places:
the digest, and a comment in `profile.ts` warning not to confuse it with
`offerings`.

So J4 can hold *"we sell hand-wound copper rings"* beside a catalogue of brass
cuffs and notice nothing. Noticing that is not a nice-to-have for a product whose
objective is understanding the business — it is close to the whole of it.

### 2.3 The relationship graph is written and not read — REAL, deferrable

8 kinds registered, 9 entity types projecting on every sync, and **exactly one
kind consumed**: `relationsByKind(storeId, "blocks")` in `understanding.ts:186`,
to build `blockedGoals`.

`belongs_to`, `involves`, `located_at`, `supersedes`, `derived_from`, `supplies`
and `about` are computed, indexed, stored — and never consulted by anything.

This is **capability built ahead of use**, not a defect. Nothing is wrong; J4
simply reasons over an eighth of a structure it maintains.

### 2.4 Six entity types never reach the canonical model — REAL, deferrable

`transaction`, `appointment`, `campaign`, `document`, `design`, `shipment` do not
appear in `getBusinessProfile` or `getBusinessUnderstanding`.

Three (`appointment`, `campaign`, `document`) reach consumers through the
per-consumer summaries of §2.1. Three (`transaction`, `design`, `shipment`) are
read by **nothing** outside the connector that writes them and the internal
mapper. A synced QuickBooks transaction is stored and never looked at again.

### 2.5 Runnable coverage — REAL, tracked separately

187 verification suites. **41 in the shared runner; 146 run only when somebody
chooses to.** `package.json` still has no `test` script. Of the nine
understanding-layer suites, four bring their own Postgres and run by hand.

Already recorded as separate critical infrastructure; **still not done**, and the
number has grown by three since it was recorded.

---

## 3. Critical vs deferrable

| | |
|---|---|
| **Critical** | §2.1 multiple assemblers — because it silently multiplies every future capability |
| **Critical** | §2.2 no reconciliation — because it *is* the stated objective |
| Real, deferrable | §2.3 unread relationship graph — capability ahead of use, nothing broken |
| Real, deferrable | §2.4 six unreached types — mostly connector data with no current consumer |
| Tracked separately | §2.5 the runner |

**Unchanged and untouched:** provider-blocked items (EasyPost read-back,
Stripe/PayPal grant state, `CLASSIFY_FIXTURE_URL`, `RESEND_API_KEY`), the
pre-existing lint warnings, and the unmeasured live items — the policy-refusal
branch, `offering` → routing, the 48/50 discrepancy, and whether J4 supplies
`supersedesRecordId` when correcting a plural fact.

---

## 4. Recommended next milestone

### **One Canonical Understanding** — then reconciliation on top of it

**The recommendation is to converge assembly first, and to contract
reconciliation separately rather than bundling it.**

**Why this order, stated as a prediction rather than a preference:** reconciliation
built today would be built against whichever assembler its author happened to be
looking at. The proactive path and the answer path would then disagree about
whether the business contradicts itself — which is a worse failure than not
noticing at all, because it is intermittent.

**Why not reconciliation first.** It is the more valuable capability and the one
that matches the objective. It is also the one with open product decisions (§6),
and it is cheap to build correctly *after* convergence and expensive to build
three times.

**Why not the relationship graph.** Nothing is broken, and 7 unread edge kinds
are a capability waiting for a reason. Reconciliation may well turn out to be
that reason — `supplies`, `about` and `derived_from` are exactly the edges a
disagreement would travel along — which is a further argument for doing
convergence and reconciliation first and letting them tell us what the graph is
for.

**Scope sketch, not a contract:** every consumer reads one assembled
understanding; per-consumer fetches move into it or are declared as deliberate
extensions with a reason; no figure is computed twice in a turn; a new consumer
inherits everything by construction. Deterministic throughout — **no live model
needed**.

---

## 5. Contract that should be created

**`CANONICAL_UNDERSTANDING_CONTRACT.md`** — to be written after the decisions in
§6 are taken, following the pattern of the last two: evidence, options,
consequences, recommendation, nothing chosen silently.

`RECONCILIATION_CONTRACT.md` follows it, separately.

---

## 6. Open decisions, required before any implementation

**None of these is answered here.**

### U1 — What is the canonical model *for*?

Every consumer, or the conversation path only? `getBusinessUnderstanding` has
~12 consumers with different needs — the logo proposer needs identity, the
proactive layer needs summaries. **Consequence:** "everything for everyone" makes
one expensive object every caller pays for; "conversation only" leaves the second
and third assemblers exactly where they are.

### U2 — Is a per-consumer extension ever legitimate?

If yes, it needs to be **declared** rather than incidental, the way
Verification Hardening made "unavailable" a declaration rather than a silence. If
no, the canonical object grows to the union of all needs.

### U3 — What is the cost ceiling?

The profile already performs ~10 fetches, and `getBusinessProfile` has previously
poisoned a shared test harness by fanning out. **Consequence:** folding more in
makes it heavier for every caller; the alternative is lazy sections, which
reintroduces "did this consumer remember to ask for it".

### U4 — Does reconciliation *store* a disagreement, or compute it live?

Stored means a new record kind and a lifecycle for it. Computed means it is
recalculated every time and can never be dismissed by the owner. **This one
interacts with the fact lifecycle just shipped and should not be answered
casually.**

### U5 — What does J4 do when it finds a disagreement?

Say it proactively, answer with it when asked, or ask the owner which is true.
This is a J4 identity question — the same shape as D5 in the last milestone, and
the closed decision there (*record, preserve, resolve explicitly*) is the obvious
precedent but not automatically the right answer for a disagreement between
**sources** rather than between **statements**.

---

## Files supporting this

- `lib/businessModel/understanding.ts:186` — the one relationship kind read
- `lib/businessModel/relationships.ts:53` — the eight registered
- `lib/businessModel/reasoning.ts:1193` — `buildChatDataContext`, the second assembler
- `lib/intelligence/cognitiveLayer.ts:387-389` — the third
- `lib/execution/toolHandlers.ts:2015` — the comment warning against exactly this
- `lib/businessModel/profile.ts:74` — the comment distinguishing `identity.offering` from `offerings`, the two things nothing compares
- `lib/businessModel/digest.ts:122` — the only other reader of `identity.offering`
- `scripts/verification-inventory.ts` — 187 suites, 41 in the runner
