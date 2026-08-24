# Verification Hardening — contract

**Status: CONTRACT. Nothing implemented except the inventory (§8), which was
authorised separately as the evidence base.** 2026-08-24. No API credit spent,
no live model called.

Evidence base: `NEXT_MILESTONE_REASSESSMENT.md` and
`scripts/verification-inventory.ts`. **Not the old roadmap.**

Everything below is investigated. Where the investigation contradicted an
expectation — including mine — the finding is stated rather than smoothed over.

---

## 1. What verification means

The lifecycle is **proposal → authorization → execution → verification**. Each
stage answers a different question, and the last one is the only stage that asks
about the *world* rather than about the *call*:

| Stage | Question |
|---|---|
| proposal | what is being asked for? |
| authorization | is this actor allowed to ask? |
| execution | did the operation run? |
| **verification** | **is the state now what was asked for?** |

**Successful execution and persisted truth are different claims.**

- *Successful execution* — `run()` returned. No exception was thrown.
- *Persisted truth* — the store, product, order or record now holds the value
  the input asked for, confirmed by reading it back.

Execution success is evidence *about the call*. Persisted truth is evidence
*about the business*. Only the second supports telling an owner their storefront
changed.

**The failure this closes.** A write can return without throwing and still not be
the thing that was asked for: a field name that did not map, a JSON merge that
dropped a key, a value coerced on the way in, a row updated where another was
meant, a write into a stale transaction. None of these throw. Every one of them
produces a green `SUCCESS` today.

**What verification is not.** It is not a correctness judgement about content.
Read-back can confirm the tagline the owner approved is the tagline now stored; it
cannot confirm the tagline is any good. Confusing the two would make `verified`
a claim the system cannot support.

---

## 2. Which classes require read-back, and which do not

The rule: **read-back is required wherever the executable writes persisted state
this platform can read.** Where there is no such state, read-back is not imposed.

The investigation looked for the second category and **found no executable that
writes nothing readable.** All 24 either write rows directly or write through a
module that does. The two with an external leg still write local rows.

So the classes below are not "which ones can be verified" — they are **what the
read-back has to compare**, which differs, and that difference is the design work.

| Class | Read-back required | What it compares |
|---|---|---|
| **A — input-valued writes** | yes | stored value **equals** the input value |
| **B — merge-into-JSON writes** | yes | the **subset of keys the input named** equals the input |
| **C — row-creating writes** | yes | the row **exists**, is linked to the right parent, and carries the input's values |
| **D — derived-state writes** | yes | the stored state equals the **rule's** output for that input |
| **E — provider-backed** | yes, **local half only** | the local row; the remote leg is declared unverifiable (§6) |

**Nothing legitimately escapes read-back.** What varies is what "matches" means,
and Class E is the only one where a genuine half is out of reach.

---

## 3. Verified-state semantics

### What exists today

`lib/execution/engine.ts:214-227`:

```ts
const outcome = await executable.run(input, ctx);
let verified = false;
let status: ExecutionStatus = outcome.partial ? "PARTIAL"
  : (outcome.redirectUrl || outcome.pending) ? "PENDING" : "SUCCESS";

if (executable.verify) {
  const v = await executable.verify(input, ctx);
  verified = v.ok;
  if (!v.ok) status = "WARNING";
}
```

`verified: true` is written **once in the entire codebase**
(`app/api/onboarding/fulfillment/callback/route.ts:121`), against 36
`verified: false`.

**`verified: false` currently carries two meanings, and nothing distinguishes
them:**

1. *verification ran and failed* — which **cannot appear on a `SUCCESS` row**,
   because a failing `verify()` sets `WARNING`;
2. *no `verify()` exists* — the real meaning, for 21 of 24 executables.

`verified` is owner-visible: `app/dashboard/ExecutionStatusCard.tsx:50` prints
`(verified)`. So for 21 actions the owner sees its absence and cannot tell
"nobody checked" from "checked and fine".

### What each state must mean after this milestone

| State | Means | What the owner should understand |
|---|---|---|
| `verified: true` | a read-back ran and the state matched | *"I changed it, and I looked again to be sure."* |
| `verified: false` + `WARNING` | a read-back ran and the state **did not** match | *"Something did not take. Here is which part."* |
| **third state** (§3.1) | read-back is not possible for this operation, **by declaration** | *"Done. This one I can't re-check from here."* |
| `verified: false` + `SUCCESS` | **must become unreachable** | — |

The last row is the point of the milestone. A `SUCCESS` row that wrote readable
state and was never re-read may not present as plain success.

### 3.1 The third state

An executable that genuinely cannot verify a leg **declares it, with a reason**,
rather than omitting the method. Silence must stop being the way both "not
possible" and "not implemented" are expressed, because that is exactly why 21
gaps were invisible.

**`WARNING` keeps its current meaning** — the operation ran and something is off —
and gains a real population, since today almost nothing can produce it.

### 3.2 Verification must not run against an outcome that has not landed

The engine currently calls `verify()` regardless of outcome kind, so a `PENDING`
outcome would be verified immediately and a failure would flip it to `WARNING`.
**No executable returns `pending`, `redirectUrl` or `partial` today**, so this is
latent rather than live — but it is a trap laid for the first one that does, and
the contract closes it: verification runs only for outcomes claiming to have
landed.

---

## 4. The 21, grouped by execution and state type

Not 21 identical defects. Five groups, each with one verification shape.

### Class A — input-valued writes (5)

The input *is* the value: `updateTheme` writes `data: { theme: input }`,
`storeEdit` writes `data: { name: input.name, tagline: …, description: … }`.

`updateTheme`, `storeEdit`, `updateStoreIdentity`, `updateBrandIdentity`,
`updateDesignDirection`

**Read-back:** re-read the field, compare to the input. Exact. The cheapest and
least ambiguous group; a good place to start and prove the pattern.

### Class B — merge-into-JSON writes (6)

The write merges input into an existing blueprint: `updateSeo` and
`updateStoreContent` both write `data: { blueprint: updatedBlueprint }`.

`updateSeo`, `updateStoreContent`, `updateHomepageContent`, `updateSectionOrder`,
`updateMarketingAssets`, `updateBrandLogo`

**Read-back:** re-read the blueprint and compare **only the keys the input
named**. Comparing the whole object would fail on untouched keys and is the
mistake to avoid — the same "touch flags" reasoning the chat pipeline already
uses to avoid false diffs.

### Class C — row-creating writes (5)

`productFromDesign`, `products`, `productImages`, `updateProductImage`,
`communicateFinding`

**Read-back:** the row exists, is attached to the right parent, and carries the
input's values. `products` and `productImages` also **delete**, so verification
covers absence as well as presence — a delete that silently matched nothing is
the same defect from the other side.

### Class D — derived-state writes (3)

The value is computed by a rule from the input: `orders` writes
`fulfillmentStatus: nowFulfilled ? "fulfilled" : "unfulfilled"`.

`orders`, `updateGoalStatus`, `resolveChallenge`

**Read-back:** compare against the **rule's** expected output for that input, not
against the input. These are also the group where re-running the rule inside
`verify()` would be circular — the check must read the persisted row.

### Class E — provider-backed (2)

`shipping` (EasyPost), `storePublish` (Stripe, PayPal)

Both **also write local rows** — `order` and `store` respectively — so the local
half is verifiable. See §6.

---

## 5. The reference pattern — the 3 that already do this

`refineStorefront.verify` is the model to copy:

```ts
async verify(input, ctx) {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: ctx.storeId }, select: { theme: true } });
  const stored = (store.theme as Theme | null) ?? DEFAULT_THEME;
  const missing: string[] = [];
  for (const change of input.changes) { … }
```

Three properties worth naming, because they are what makes it real:

1. **It re-reads from the database.** It does not trust a value returned by `run()`.
2. **It reports which fields did not land**, not a bare boolean — so `WARNING`
   can tell the owner something specific.
3. **It compares against what the input asked for**, not against what the write
   thought it did.

`updateHero.verify` adds a fourth: it is honest about what it cannot cover. Its
own comment says verification "only confirms the value round-tripped" — which is
why a separate ownership check on the image URL exists *before* the write. **Some
guarantees belong before execution, not in verification.**

`answerSupplierEconomics.verify` adds a fifth: it verifies **per fact**, because
the write is per fact, and demands nothing the owner did not state.

---

## 6. Provider-backed operations

The remote leg of `shipping` and `storePublish` cannot be confirmed by reading
this platform's own database. That is a real limit, not an excuse — and both also
write local rows.

**The contract:**

1. **Verify the local half.** `shipping` writes an `order`; `storePublish` writes
   a `store`. Both are readable and must be read back.
2. **Declare the remote half unverifiable, with a reason** (§3.1). Not silence.
3. **Never let the local half's success imply the remote half.** A verified
   `order` row does not mean EasyPost accepted the label; saying so would be the
   same lie in a new place.
4. **Do not build provider round-trip verification in this milestone.** It needs
   live credentials, which are out of scope, and would make an architecture
   milestone depend on external state. Where a provider already returns a
   confirmable identifier the write persists, reading that identifier back is
   part of the local half — no new provider call.

---

## 7. Engine SUCCESS semantics

**Is `run()` returning without throwing sufficient to establish `SUCCESS`?**

**No.** Today it is the entire test, and for 21 of 24 executables nothing else
ever happens. `SUCCESS` renders green (`lib/execution/statusDisplay.ts:10`) and
is the state on which the owner is told their business changed.

**The contract:**

1. `SUCCESS` requires **either** a passed read-back **or** a declared reason why
   read-back is not possible. Returning without throwing is necessary, not
   sufficient.
2. An executable that writes readable state and neither verifies nor declares is
   **a programming error**, caught by a test rather than by an owner.
3. `ExecutionStatus` values stay as they are —
   `SUCCESS | WARNING | FAILED | PENDING | PARTIAL`. **No new status.** The third
   verification state is a property of verification, not a sixth execution
   status; conflating them would put "we couldn't check" into the same field as
   "it didn't work".
4. Verification runs only for outcomes claiming to have landed (§3.2).

---

## 8. The suite problem

**184 verification suites exist and no single command executes every applicable
one.** `scripts/verification-inventory.ts` now reports this authoritatively:

| Lane | count | how it runs |
|---|---|---|
| 1 — shared runner | **41** | `npx tsx scripts/run-db-suites.ts` |
| 2 — standalone, no database | **76** | `verification-inventory.ts --plan` |
| 3 — own Postgres or Next server | **59** | by hand, deliberately |
| 4 — named exclusions, database-backed | **8** | by hand, each with a reason |
| | **184** | |

Cross-cutting: **17** need a live model or provider and must never run unasked.

**Why not one command.** PGlite serves a single connection, and a suite that fans
out parallel reads has previously killed an unrelated suite three positions
later. Lane 3 exists because those suites *must* own their infrastructure. Four
intentional lanes beat one process that appears to run everything and does not.

**The inventory does not have its own opinion.** `needsDatabase` moved byte-exact
to `scripts/lib/suiteLanes.ts`; both the runner and the inventory import it. Two
earlier drafts re-derived those rules and reported **46**, then **48** —
confidently wrong, twice, about what was covered.

### Acceptance for the inventory and runner

1. The inventory's lane counts **sum to the number of suites on disk**. A suite
   that matches no lane is a failure of the inventory, not an unclassified suite.
2. Its shared-runner count **equals what `run-db-suites.ts` actually runs**,
   because both call one function. A second copy of that decision is a defect.
3. Lane 2 becomes runnable as a lane — a real command, reporting its own count,
   **naming its lane in the output**.
4. **No aggregate may imply coverage it did not execute.** `run-db-suites.ts`
   keeps saying "41/41 database-backed suites"; it may not be inflated toward
   184.
5. A new suite lands in a lane automatically, by the property of its source — not
   by being added to a list. The list is how a suite once ran in the wrong lane
   for a day.

---

## 9. Acceptance criteria

### 9.1 Three states, never conflated

Every claim in the final report is one of:

| | Meaning |
|---|---|
| **IMPLEMENTED** | the code exists |
| **VERIFIED** | a test ran and entered the behaviour |
| **LIVE/PROVIDER-BLOCKED** | cannot be established without a credential |

"Implemented" is never reported as "verified". A `verify()` with no negative
control is IMPLEMENTED, not VERIFIED.

### 9.2 Per-executable

1. All 24 either implement `verify()` or **declare** why they cannot, with a reason.
2. Each `verify()` re-reads persisted state — never a value returned by `run()`.
3. Each reports **which** fields did not match, not a bare boolean.
4. Class B compares only the keys the input named.
5. Class C verifies deletions as well as creations.
6. Class E verifies the local half and declares the remote half.

### 9.3 Engine

7. `verified: true` is reachable **only** through a passed read-back. The
   onboarding-callback write is re-examined against this.
8. A `SUCCESS` row that wrote readable state and was not verified is unreachable.
9. Verification does not run for outcomes that have not landed.
10. No new `ExecutionStatus` value.

### 9.4 Negative controls — every one enters the behaviour

11. **Each `verify()` gets a control that breaks the real write and confirms
    verification fails.** Not a mock: the actual write, corrupted. A control that
    cannot fail proves nothing, and this repository has shipped exactly that.
12. A control proving `SUCCESS`-without-verification is unreachable must first
    make it reachable.
13. Class B gets a control confirming an **untouched** key does not fail
    verification — the false-positive direction, which is how a strict comparison
    would quietly break every merge write.
14. Source assertions use `codeOnly()`. 9 suites carry them and **1** strips
    comments; any suite this milestone touches adopts it, and `codeOnly` moves to
    `scripts/lib/` on its next use — it is already duplicated in two files.

### 9.5 Gates

15. Typecheck, **`npx next build` reported separately from any suite count**,
    lane 1, and every suite this milestone touches.
16. The inventory still reconciles to the number of suites on disk.
17. No suite is reported as run unless it ran.

---

## 10. Out of scope

- **The fact model.** `offering`/`intent` correctability, the three-mechanisms
  finding, and the Belief/Fact asymmetry are recorded in
  `J4_FACT_MODEL_FINDINGS.md` as a **separate architectural follow-up**. The
  investigation for this contract did **not** find them required by verification:
  the executables that write `businessRecord` rows (`updateGoalStatus`,
  `resolveChallenge`, Class D) can be verified by reading the stored record back,
  with no change to how facts are corrected. **They stay separate.**
- `edit_store_content`'s legacy path (`ARCHITECTURE.md:128`) — a separate decision.
- `lib/execution/genesisActions.ts` — untouched, as instructed.
- All four live-validation items. **No API credit.**
- Provider round-trip verification (§6.4). Any new executable. Any engine redesign.

---

## 11. Open question, before implementation

**The third state needs a name the owner will read.** "Unverified" and "not
verifiable" are both accurate and both sound like something went wrong — which,
for a shipping label that was bought successfully, is untrue.

This is copy on an execution surface, which has been a real defect source here,
and it is the one thing in this contract that is a product decision rather than
an engineering one. **Recommend deciding it before implementation begins**, since
it shapes the `Executable` interface as well as the UI.
