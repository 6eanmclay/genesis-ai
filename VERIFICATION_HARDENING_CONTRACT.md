# Verification Hardening — contract

**Status: CONTRACT. Nothing implemented beyond the inventory named in §0.**
2026-08-24. No API credit spent, no live model called.

Everything below is **investigated, not assumed**. Where the investigation
contradicted an expectation — including mine — the finding is stated.

---

## 0. Done first, because the contract depends on it

**`scripts/verification-inventory.ts`** — the authoritative answer to "what do we
actually run?"

```
npx tsx scripts/verification-inventory.ts          the report
npx tsx scripts/verification-inventory.ts --json   machine-readable
npx tsx scripts/verification-inventory.ts --plan   the standalone lane
```

| | count |
|---|---|
| total verification suites | **184** |
| in the shared runner | **41** |
| bring their own Postgres or Next server | **59** |
| standalone, no database | **76** |
| database-backed but named as exclusions | **8** |
| need a live model or provider | **17** |
| exercise production behaviour | **178** |
| carry source-text assertions | 9 — **1** strips comments |

41 + 59 + 76 + 8 = 184. **The 41 matches `run-db-suites.ts` exactly**, and that
is structural rather than lucky:

**The inventory calls the runner's own decision function.** `needsDatabase` moved
byte-exact to `scripts/lib/suiteLanes.ts` and both files import it. The first two
attempts at this report *re-derived* the runner's rules and produced 46 and then
48 — confidently wrong, twice, about which suites were covered. An inventory that
disagrees with the runner is worse than no inventory, so it does not get its own
opinion.

**Four intentional lanes, not one process.** Forcing 184 suites together would be
worse than the problem: PGlite serves one connection, and a suite that fans out
parallel reads has previously killed an unrelated suite three positions later.
The lanes are the shared runner, the standalone list, the by-hand
own-infrastructure suites, and the 17 gated on credentials.

---

## 1. Executable coverage — the map

All 24, measured from source with comments stripped.

| Executable | `verify()` | writes readable state | external leg |
|---|---|---|---|
| `answerSupplierEconomics` | **YES** | via `economics` module | — |
| `refineStorefront` | **YES** | `store` | — |
| `updateHero` | **YES** | via hero module | — |
| `communicateFinding` | — | `cognitiveOutput` | — |
| `orders` | — | `order` | — |
| `productFromDesign` | — | `product`, `productImage` | — |
| `productImages` | — | `product`, `productImage` | — |
| `products` | — | `product`, `productImage` | — |
| `resolveChallenge` | — | `businessRecord` | — |
| `shipping` | — | `order` | **EasyPost** |
| `storeEdit` | — | `store` | — |
| `storePublish` | — | `store` | **Stripe, PayPal** |
| `updateBrandIdentity` | — | `store` | — |
| `updateBrandLogo` | — | `store` | — |
| `updateDesignDirection` | — | `store` | — |
| `updateGoalStatus` | — | `businessRecord` | — |
| `updateHomepageContent` | — | `store` | — |
| `updateMarketingAssets` | — | `store` | — |
| `updateProductImage` | — | `product`, `productImage` | — |
| `updateSectionOrder` | — | `store` | — |
| `updateSeo` | — | `store` | — |
| `updateStoreContent` | — | `store` | — |
| `updateStoreIdentity` | — | `store` | — |
| `updateTheme` | — | `store` | — |

### The finding that decides the scope

Sean's instruction was not to impose read-back where an action has no meaningful
state to reread. **The investigation found zero such cases.**

**All 21 executables without `verify()` write readable persisted state.** Every
one of them changes a `store`, `product`, `productImage`, `order`,
`businessRecord` or `cognitiveOutput` row that can be read back and compared.

Two also have an external leg — `shipping` reaches EasyPost, `storePublish`
reaches Stripe and PayPal — but both **also** write local rows, so the local
half is verifiable even where the remote half is not. That distinction becomes a
declared state rather than a silence (§3).

---

## 2. Verified-state integrity — every write traced

**`verified: true` is written once in the entire codebase**, at
`app/api/onboarding/fulfillment/callback/route.ts:121`. Against 36 `verified: false`.

Inside the engine (`lib/execution/engine.ts:216-227`):

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

**`verified: false` currently means two different things** and nothing can tell
them apart:

1. verification ran and failed — but this cannot occur, because a failure sets
   `status = "WARNING"`, so a `SUCCESS` row with `verified: false` never means this;
2. **no `verify()` exists** — which is the real meaning for 21 of 24 executables.

`verified` is owner-visible at `app/dashboard/ExecutionStatusCard.tsx:50`, which
prints `(verified)`. So for 21 actions the owner sees its absence and is given no
way to distinguish "not checked" from "checked and fine".

**What must be allowed to produce each state, after this milestone:**

| State | Produced only by |
|---|---|
| `verified: true` | a `verify()` that re-read persisted state and found it matched |
| `verified: false` + `WARNING` | a `verify()` that ran and found a mismatch |
| the third state (§3) | an executable that declared itself unverifiable, with a reason |

No other path may set `verified: true`. The onboarding callback write is in scope
to be re-examined.

---

## 3. ExecutionResult vs persisted truth

**Today `SUCCESS` means "`run()` returned without throwing."** Nothing else. For
21 of 24 executables, no code ever confirms the write landed, and
`ExecutionStatus` is `"SUCCESS" | "WARNING" | "FAILED" | "PENDING" | "PARTIAL"`
with `SUCCESS` rendering green at `lib/execution/statusDisplay.ts:10`.

This is precisely the risk named in the brief, and it is live.

**The contract:**

1. `SUCCESS` requires supporting persisted state. An executable that writes
   readable state and has not confirmed it may not report plain `SUCCESS`.
2. **A third verification state exists**, so "not verifiable" and "nobody
   implemented it" stop looking identical. An executable that genuinely cannot
   verify — the external leg of `shipping`, of `storePublish` — **declares that
   explicitly with a reason**, rather than omitting the method.
3. The owner-facing surface distinguishes **verified**, **unverified**, and
   **not verifiable**. Three states, not a present/absent flag.
4. A partially-verifiable action (local row yes, remote call no) reports the
   local half honestly rather than claiming or disclaiming the whole.

---

## 4. Failure semantics — the principle this inherits

> **Never tell the owner something happened when the execution state says
> otherwise.**

UI6 applied this to how messages are rendered — `lib/j4/messageState.ts` derives
state from the execution row and never from prose. This milestone applies it one
layer down, where the execution row is *produced*.

- A verification mismatch is **not** a failure of the turn: the write may have
  partly landed. It is `WARNING`, and the owner is told which fields did not take.
- A verification that cannot run is never reported as a verification that passed.
- No message may claim an outcome the execution row does not support. This is
  already true of the rendering layer; the milestone makes it true of the source.

---

## 5. Suite truthfulness

**No green aggregate may imply coverage the runner did not execute.** The 41/41
lesson, made structural:

1. `run-db-suites.ts` keeps saying **`41/41 database-backed suites`** — it is
   accurate about what it ran and must not be inflated.
2. The inventory is the only surface allowed to report a total across lanes, and
   it reports per-lane counts, never one number.
3. Any new aggregate states which lane it covers.
4. `needsDatabase` stays in `scripts/lib/suiteLanes.ts` with exactly one copy.
   A second copy is how the report was wrong twice before it was right.

---

## 6. Negative controls

Non-negotiable, and the reason is a defect this repository actually shipped: a
suite once asserted a property while the fixture could not reach it, and stayed
green.

1. **Every `verify()` gets a control that breaks the write and confirms
   verification fails.** Not a mock — the real write, corrupted.
2. **Every new boundary assertion enters the behaviour it protects.** An
   assertion that a state is unreachable must first make it reachable.
3. **Source assertions use `codeOnly()`.** 9 suites carry source assertions and 1
   strips comments; any suite this milestone touches adopts it.
4. `codeOnly` moves to `scripts/lib/` on its next use — it is already duplicated
   in two files, which `ARCHITECTURE.md`'s own rule says not to do.

---

## 7. Scope

**In:** the 21 `verify()` implementations; the third verification state; the
owner-facing three-state surface; the `SUCCESS` precondition; negative controls;
the inventory (done).

**Out, explicitly:**

- `edit_store_content`'s legacy path (`ARCHITECTURE.md:128`) — a separate decision.
- `lib/execution/genesisActions.ts` — untouched, as instructed.
- `factCapture` and the fact-model — its own document.
- All four live-validation items. **No API credit.**
- Any new executable, any engine redesign.

## 8. Acceptance

1. All 24 executables either verify or declare why they cannot, with a reason.
2. `verified: true` is reachable only through a real read-back.
3. A `SUCCESS` row that writes readable state and was not verified is not
   presented to the owner as plain success.
4. Each `verify()` has a negative control that fails when the write is broken.
5. `npx tsx scripts/verification-inventory.ts` still reconciles to 184, and its
   shared-runner count still equals what `run-db-suites.ts` reports.
6. Typecheck, `npx next build`, the shared runner, and every suite this milestone
   touches — all green, **build reported separately**.

## 9. Open question for Sean

**The third state needs a name the owner will read.** "Unverified" and "not
verifiable" are accurate and both sound like something went wrong, which for a
successful shipping label is untrue. This is copy, and copy on an execution
surface has been a real defect source. Recommend deciding it before implementation.
