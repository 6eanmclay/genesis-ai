# The Business Intelligence Engine, production-ready

**Evidence-first implementation plan. 2026-08-24. Nothing here is proposed from
the roadmap — every claim below names the file and line that supports it.**

The engine is built. `BI_ENGINE.md` M1–M9 closed at `66078f1`, and this document
does not reopen any of it. The question is narrower and different: **the engine
runs on a schedule in production, and nothing in production can tell you whether
it worked.** Four gaps, all closable with infrastructure this repository already
has.

---

## 1. What exists, and is reusable as-is

| | Evidence |
|---|---|
| The cycle, one definition | `lib/intelligence/cycle.ts` — `runIntelligenceCycle`, called by both the connector path and the first-party path so they cannot drift |
| 15 intelligence modules, 4,394 lines | `lib/intelligence/` — insights, learn, notify, proactive, beliefs, change detection, scheduler |
| Unattended execution | `vercel.json` → one daily cron `0 6 * * *` → `app/api/cron/sync/route.ts`, five independent stages |
| Stage isolation at the route | `app/api/cron/sync/route.ts:38-105` — each stage its own try/catch, a failed stage reported as failed rather than as "found nothing" |
| Operator error reporting | `lib/observability/reportIssue.ts` — Sentry-backed, 19 call sites, already has a `"scheduler"` subsystem |
| A read-only operator endpoint | `app/api/cron/status/route.ts` — same `CRON_SECRET` gate, no side effects, cross-tenant by design |
| The pattern for a safe production read | `scripts/check-stripe-live-readiness.ts` — writes nothing, takes an env file, safe to re-run against production |
| The BI reads reach J4 | `lib/businessModel/profile.ts:262-263` calls `getProfitability` and `getObligations`; the profile is the canonical understanding. **Not dead code.** |

**Nothing needs re-architecting, and nothing new needs building.** Every fix below
is an application of a pattern already in the repository.

---

## 2. Gap 1 — a provider failure kills the deterministic stages behind it

**This is the highest-value item, and it is the live state of production today.**

The chain, by line:

1. `lib/intelligence/cognitiveLayer.ts:670` — when the model call fails,
   `runCognitiveReview` writes a FAILED `ExecutionLog` and then **throws**.
   (`callGenesisModel` itself never throws — it returns a typed result. The
   throw is this function's own.)
2. `lib/dashboard/genesisObservations.ts:230` — `runOpportunisticAiReviewIfStale`
   awaits it bare.
3. `lib/intelligence/cycle.ts:80` — `runIntelligenceCycle` awaits *that* bare.

So when the provider fails, two stages that come after it never run:

- `proposeStaffPolicyGap` (`cycle.ts:85`) — its own comment: *"Deterministic and
  cheap — two reads"*
- `speakNewFindings` (`cycle.ts:96`) — its own comment: **"J4 SAYS WHAT IT
  NOTICED, last and deterministically… No model, no session"**

Both are documented as needing no provider. Both are killed by a provider failure.

**Why it happened, and why it is a defect rather than a decision.** The cron
route learned stage isolation on 2026-08-20 (`6cf04a3`, *"One store's failure
could silently stop the whole platform's scheduled work"*). `speakNewFindings`
was added to the cycle on 2026-08-23 (`e5fda18`), three days later — placed
behind a stage that was already known to throw. The route was isolated; the
cycle inside it never was. `cycle.ts`'s own comment names the AI review as
*"the usual one, since it needs a provider"*.

**This is not hypothetical.** `NEXT_AFTER_D4.md` records the Anthropic credit
balance as exhausted. On every daily cron since, each due store's cycle throws
at the AI review, and Proactive J4 — which needs no model — says nothing.

**Fix:** apply the cron route's own stage-isolation pattern inside
`runIntelligenceCycle`. A stage that fails is recorded as failed; the stages
after it still run. No new system, no new dependency.

---

## 3. Gap 2 — the error is thrown away

`lib/intelligence/cycle.ts`, in `runDueIntelligenceCycles`:

```ts
} catch {
  summaries.push({ storeId, ok: false, insights: 0, spoken: 0 });
}
```

**The error object is not bound.** Not logged, not reported. And all five cron
stages (`app/api/cron/sync/route.ts:38-105`) use `console.error` only — on
Vercel that is short-retention runtime log, found only by someone who already
suspects a problem, which is the exact reasoning `reportIssue.ts`'s own header
gives for existing.

`lib/intelligence/scheduler.ts:173,214` already calls `reportIssue` for connector
sync failures. The first-party BI stage — the only path that can work today
(§5) — never does.

Partial mitigation that does exist and should be credited: the AI review writes a
durable FAILED `ExecutionLog` the owner can see. That is the owner-facing half.
There is no operator half, and nothing at all for a failure in any other stage.

**Fix:** bind the error and call the existing `reportIssue` with subsystem
`"scheduler"`. No new system.

---

## 4. Gap 3 — nothing in production says the engine ran

- No cycle-run model exists in `prisma/schema.prisma` (searched: no
  `IntelligenceCycle`, no run record of any kind).
- The cron route returns its summary as an HTTP response body to Vercel. It is
  not persisted.
- `app/api/cron/status/route.ts` reports `StoreIntegration` rows only — connector
  sync state, never the BI stages.
- `/admin` (`app/admin/page.tsx`) shows AI cost and usage only.

**So "is the BI engine running in production?" cannot be answered from
production.** That is the definition of not production-ready, independent of
whether the engine is correct.

**Fix, smallest form:** extend the existing `/api/cron/status` route — same
`CRON_SECRET` gate, same read-only shape, no new table and no new writes — to
report BI state from rows that **already exist**: per-store `BusinessEventCursor`
lag for the Insight Engine consumer, the most recent `CognitiveOutput`, and the
most recent `GENESIS_RECOMMENDATIONS_GENERATE` `ExecutionLog` with its status.
Every one of those is already written by the engine today.

---

## 5. Gap 4 — production data shape is unmeasured, and the arithmetic depends on it

`BI_ENGINE.md` §15 leaves two things explicitly open: whether any real order
carries `shippingCostInCents`, and which `Order.status` values actually occur in
production. Both feed `getProfitability` / `getObligations`, which feed the
canonical profile, which is what J4 tells an owner.

Every suite named "live" in this repository — `verify-bi-reads-live`,
`verify-insights-live`, `verify-audience-recall-live` — runs against an embedded
Postgres with engineered rows. **"Live" here has always meant "a real database",
never "the production database."** That is honest and it is also the limit.

**Fix:** `scripts/check-bi-production-readiness.ts`, built in the exact shape of
`check-stripe-live-readiness.ts` — read-only, env-file argument, writes nothing,
safe to re-run. It answers from production: which `Order.status` values exist,
how many orders carry a shipping cost, how many stores have BI cursor lag, when
each last produced a `CognitiveOutput`.

**Running it is Sean's call, not something to slip in** — same standing as
`promote-brand-claims.ts`.

---

## 6. Why the connector catalog is not the constraint

Per `COMPLIANCE.md`'s *Action required from Sean* (checked against Vercel, per
that document, not assumed):

| Connector | Production state |
|---|---|
| QuickBooks | **Dead since 2026-08-01.** Only the account holder can re-consent |
| Google Calendar | OAuth app unpublished → Google expires every refresh token after 7 days |
| Mailchimp | No `MAILCHIMP_CLIENT_ID`/`_SECRET` — nobody can connect (existing key-based connections unaffected) |
| Facebook / Instagram | No `FACEBOOK_CLIENT_ID`/`_SECRET` — neither can connect |
| TikTok | No `TIKTOK_CLIENT_KEY`/`_SECRET` |

**No connector can reliably feed the engine in production today.** So the
first-party path (M1, `BI_ENGINE.md` Defect 1) is not an enhancement — it is the
only path with data in it, which is precisely why Gaps 1 and 2 matter and why
adding connectors would not help. This is evidence for the instruction, not
merely compliance with it.

---

## 7. The smallest sequence

Ordered by value under the conditions that actually hold today.

| | Work | Why it is first | Needs |
|---|---|---|---|
| **P1** | Stage isolation inside `runIntelligenceCycle` | Restores Proactive J4 and the staff-policy ask under the provider outage that exists right now | nothing |
| **P2** | Bind the discarded error; `reportIssue` on the BI stages | A failure that nobody can see is indistinguishable from no failure | nothing |
| **P3** | BI state in `/api/cron/status`, from rows that already exist | Makes "did it run" answerable from production | nothing |
| **P4** | `check-bi-production-readiness.ts`, read-only | Answers §5's two open questions from production | **Sean runs it** |

P1–P3 are deterministic, need no credential, and touch no production data. Each
gets gates with paired negative controls, in the pattern of the last four
milestones.

**Out of scope, deliberately:** no new connectors; no new tables; no second
scheduler; no re-opening of M1–M9; no live-provider verification.

---

## 8. Product-level decisions

**None found that require approval.** The one adjacent item — executing the
production read-only check — is already Sean's to run and is written that way.

Two things that could look like decisions and are not:

- **Whether the AI review's failure should stop the cycle.** `cycle.ts`'s own
  comments document the two later stages as deterministic and provider-free, and
  the cron route established the opposite principle three days before
  `speakNewFindings` was placed behind the throw. Restoring documented behaviour
  is a defect fix.
- **Whether the cursor should roll back on a failed pass.** Already decided and
  documented in `cycle.ts` — the cursor belongs to the Insight Engine, which
  genuinely did consume those events. Unchanged.


---

## 9. As built — 2026-08-24

P1, P2 and P3 implemented. P4 written and proved to execute, **not run against
production** — that is Sean's to run.

### P1 — the cycle survives one stage failing

`lib/intelligence/cycle.ts` gained `runCycleStages`, and `runIntelligenceCycle`
became the wiring that hands it the same six functions in the same order.

The seam is not decoration. `selectDueStoreIds` in the same file already
separates "the part with real semantics" from its database plumbing *so it can
be proved against engineered inputs*, and this is the identical argument: which
failures are survivable and which stage genuinely depends on which is exactly
the kind of rule that should not need a live provider to demonstrate.

Two decisions inside it worth naming:

- **`notify` is recorded as failed, not skipped, when `insights` fails.**
  `notifyFromInsights` resolves anything absent from the set it is given, so
  calling it with `[]` after a failure would retract every standing finding the
  owner is looking at — silently, and as though the engine had decided they were
  no longer true. It does not run, and "did not run" does not get to look like
  "ran and found nothing".
- **`runStage` returns its value** rather than assigning into a closure. The
  closure form typechecked as `never` downstream, because TypeScript cannot see
  an assignment inside a callback.

### P2 — the failure reaches a person

The per-store catch binds its error and reports it. All five cron stages call
`reportIssue` instead of `console.error` — plus the auth-attempt sweep, which was
a sixth path the plan had not counted: four stages reporting and one not is how a
rule stops being true for the case nobody looked at.

The cron response now carries `spoken` and `failedStages` per store. A cycle that
failed only at `ai_review` still ran Learn, still spoke, and needs a provider —
not an engineer. A bare `ok: false` could not tell those apart.

### P3 — production can answer whether the engine ran

`/api/cron/status` reports per-store `eventLag`, `cursorUpdatedAt`,
`lastCognitiveOutputAt` and `lastAiReview`. Same `CRON_SECRET` gate, still
writes nothing, **no new table** — every field is read from rows the engine
already writes.

### P4 — the production check, written and exercised

`scripts/check-bi-production-readiness.ts`, in the shape of
`check-stripe-live-readiness.ts`: read-only, env-file argument, safe to re-run.

`verify-bi-production-check.ts` runs the real script unmodified against a real
empty database. That is deliberate — typechecking proves its Prisma calls
compile, not that `groupBy` on those columns is a query Postgres accepts, and the
one script whose whole promise is "safe against production" must not be
discovered broken at the moment somebody points it there. Every section reports
a counted zero rather than vanishing.

**It has not been run against production.** Same standing as
`promote-brand-claims.ts`.

### One existing suite changed, and why

`verify-proactive-j4.ts` asserted `await speakNewFindings(storeId)` and
`spoken: spoke.spoken` as literal source text. The refactor changed both
spellings without changing what they defend. Rather than loosen them, the first
now matches the wiring shape and the third became **behavioural** — it runs
`runCycleStages` with a speak stage returning 7 and asserts the summary says 7,
plus a control that a failed speak reports 0 and names itself. Stronger than what
it replaced, and no longer breakable by a rename.

### Gate results

| Lane | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx next build` | succeeds |
| `npx eslint` | 70 problems (2 errors, 68 warnings) — **identical to HEAD** |
| shared runner | 41/41 |
| deterministic standalone | 66/68 — the two known baseline failures |
| `verify-bi-production-readiness.ts` (new) | 30 assertions, all pass, 8 negative controls confirmed |
| `verify-bi-production-check.ts` (new) | 13 assertions, all pass, 5 negative controls confirmed |

### Two gates of mine that were green for the wrong reason

Recorded because the pattern keeps recurring, not for completeness:

- `statusSrc.includes("eventLag")` stayed green after the field was renamed to
  `eventLagX` — the new name contains the old one. Now matched as a property key.
- `/\} catch \(error\) \{/` against the whole file stayed green with the
  per-store catch unbound, because `runStage`'s own catch binds one. Now scoped
  to the outer function.

### What is still open, unchanged

Everything in `BI_ENGINE.md` §15 that this milestone did not touch stays open and
is not rescheduled by having been listed here. In particular: no production
backfill has been run, and the Printful live-API check remains externally
blocked.


---

## 10. Production verification — 2026-08-24, read-only

Run against the production database via `.env.livecheck`. **Nothing was written.**
Sections 4–6 were added to the check during this run to answer the per-stage,
provider-correlation and connector questions.

### Two claims in this document were wrong, and are corrected here

**§2 said the cycle throws at the AI review "on every daily cron since".** It does
not. Production shows **99 SUCCESS, 1 FAILED** across ~100 review attempts, and
the single failure was **2026-08-19**, five days ago, with an Anthropic billing
error. The exhausted credit recorded in `NEXT_AFTER_D4.md` was *this machine's*
key during local live runs, not production's. The defect §2 describes is real and
was really reachable — it cost that one store its `staff_policy_gap` and `speak`
stages on 2026-08-19 — but it is one occurrence, not a daily outage.

**§6 said "no connector can reliably feed the engine in production today".** Too
strong. Mailchimp, Printful (×2), PayPal (×2) and one Stripe connection all
synced successfully at 06:36 on 2026-08-24, `syncFailureCount: 0`. Mailchimp is
exactly the case COMPLIANCE.md flagged — an existing key-based connection,
unaffected by the missing OAuth client credentials.

### Is the engine running? Yes.

| | |
|---|---|
| stores | 16 |
| stores with business events | 5 |
| stores with an Insight Engine cursor | 12 |
| stores with events but **no cursor** (never processed) | **0** |
| stores with **unconsumed events** (lag > 0) | **0** |
| stores with cognitive output | 13 |

Six stores produced output between 06:36 and 06:40 on 2026-08-24 — the daily
cron at `0 6 * * *`, running and current. Nothing is behind.

### Each stage, on first-party data

| Stage | Production evidence | Verdict |
|---|---|---|
| `insights` | 214 `insight` outputs (+301 recommendation, 254 opportunity, 94 explanation, 23 briefing) | working |
| `notify` | 279 observations — 131 ACTIVE, 148 RESOLVED | working |
| `learn` | **1 belief, on 1 store** | running, producing almost nothing |
| `ai_review` | 99 SUCCESS / 1 FAILED / 100 PENDING claim rows | working |
| `staff_policy_gap` | **0** `document_gap:staff_policy` observations | runs, has never fired |
| `speak` | 8 proactive deliveries | working |

`learn` at 1 belief is **BI_ENGINE.md's own Defect 2, confirmed in production**:
all three detectors filter on `topicKey: { not: null }` and chat-originated
proposals leave it null. Deferred to M2, not a new finding.

`staff_policy_gap` at 0 was first measured as 0 **from the wrong table** — the
check counted `CognitiveOutput` rows with a `staff_policy` topicKey, and
`proposeStaffPolicyGap` writes a `GenesisObservation` keyed on
`STAFF_POLICY_TOPIC`. A confident zero from the wrong table reads as "this stage
has never fired" when it might mean nothing of the kind. Re-measured where it is
actually written: still 0, now honestly.

### The two safety properties

**An AI-review failure did not cost an insight.** Correlated against the real
2026-08-19 failure on Cofoundr:

- observations resolved within ±5 min of the failure: **0**
- observations still ACTIVE for that store today: **5**
- proactive deliveries in that window: **0**

The code reason it is safe, in the deployed version and the new one alike:
`runCognitiveReview` throws *before* `resolveMissingObservations` is reached, so
a provider failure resolves nothing rather than resolving everything.

**The notification path does not retract standing findings when insights fails
— and did not before this milestone either.** In the deployed code
`notifyFromInsights` is simply never reached when `computeInsights` throws. The
new code had to take explicit care here precisely *because* isolating the stages
could have introduced this risk: it records `notify` as failed rather than
calling it with `[]`. **This milestone avoided introducing a retraction bug; it
did not fix an existing one.** Stated plainly because the opposite would be a
flattering misreading of the same diff.

### Connectors, exactly as found — 17 rows, recorded not acted on

| Provider | State |
|---|---|
| STRIPE | 1 CONNECTED (synced 08-24) · **6 FAILED** — test-account/live-key mismatches, leftovers of the live cutover |
| PAYPAL | 2 CONNECTED, synced 08-24 |
| PRINTFUL | 2 CONNECTED, synced 08-24 |
| MAILCHIMP | 1 CONNECTED, synced 08-24, 0 failures |
| GOOGLE_CALENDAR | 1 "CONNECTED", **11 failures, last synced 2026-08-06** |
| QUICKBOOKS | 1 "CONNECTED", **14 failures, last synced 2026-08-01** |
| FACEBOOK / INSTAGRAM / TIKTOK | **no rows at all** |

Two observations that are not connector work and are recorded for the
integration-readiness follow-up:

- **`status` does not reflect reality.** QuickBooks and Google Calendar both read
  `CONNECTED` while neither has synced in 18–23 days. COMPLIANCE.md's account of
  both — a retired QuickBooks refresh token, Google's 7-day expiry on an
  unpublished consent screen — matches the dates exactly.
- **The six FAILED Stripe rows carry `syncFailureCount: 0`.** A row can be FAILED
  with a zero failure count, so the counter is not what marks it.

  **Corrected 2026-08-25: this is not an inconsistency, it is two fields
  answering two questions.** `status` is the result of the last *verification* —
  a point-in-time credential check, written by each connector's own
  verify/status path. `syncFailureCount` is the *scheduler's* consecutive-failure
  counter, used for backoff and reset to 0 on any successful sync
  (`lib/intelligence/scheduler.ts`). A connection can therefore fail
  verification while its last sync succeeded. Framing it as suspicious was
  wrong; the real defect was elsewhere, and worse — see below.

### The two open questions from BI_ENGINE.md §15, now answered

- **`Order.status` values that actually occur: `paid` only** (5 of 5). Every other
  branch of the obligations bucketing is unexercised in production.
- **Orders carrying `shippingCostInCents`: 0 of 5.** All five are excluded from
  net-of-postage, so `planNetOfPostage` returns `null` for the entire production
  store set. That is the honest answer the code was built to give — and it means
  the margin arithmetic has never had real production input.


---

## 11. Deployed and closed — 2026-08-25

**Deployed commit: `892f67b`**, confirmed from the build log rather than inferred:

    Cloning github.com/6eanmclay/genesis-ai (Branch: master, Commit: 892f67b)
    91 migrations found in prisma/migrations
    No pending migrations to apply.
    ✓ Compiled successfully in 33.1s
    Build Completed in /vercel/output [1m]

**No migration ran.** 91 found, zero applied — the production schema is
untouched, matching what the local diff promised.

### What was deployed, and what deliberately was not

The BI fix shipped **alone**. It sat on top of the J4 identity milestone in the
branch, and `git push` would have carried both. Measured read-only first:
**12 of 16 production stores** hold all four identity fields in
`blueprint.brandIdentity`, and **0** hold the corresponding facts — so deploying
that milestone without its promotion would have made J4 stop knowing who twelve
businesses are for, including Cubit & Coil.

The two BI commits touch eight files and overlap none of the identity
milestone's, so they were cherry-picked onto `origin/master` and pushed on their
own. Verified standing alone before the push: typecheck clean, `next build`
compiled, lint at the 70/2/68 baseline, 41/41 shared suites, both BI suites
ALL PASS. That mattered — the BI suites had only ever been run with the identity
milestone present.

The identity milestone stays local and undeployed until it can ship together
with `promote-brand-claims.ts`.

### Post-deployment state

| | |
|---|---|
| deployed commit | `892f67b` — contains `runCycleStages` and both bound catches |
| cron schedule | `0 6 * * *` → `/api/cron/sync`, unchanged |
| `/api/cron/status` | deployed, **fails closed** — 401 unauthenticated |
| production engine | 16 stores, **0 never processed, 0 with unconsumed events** |

### The one thing not yet observed, stated plainly

**No cron execution has happened under the new code.** The deploy completed at
01:34 UTC on 2026-08-25; the last cycle ran at 06:36 UTC on 2026-08-24, under the
old code, and the next is 06:00 UTC on 2026-08-25.

What is confirmed is that the deployed code **is** the stage-isolation
implementation and that the cron is scheduled against it. What is not yet
confirmed is a run. Triggering one by hand needs `CRON_SECRET`, which this
environment returns as the literal string `[SENSITIVE]` from
`vercel env pull` — verified twice, and the reason the authenticated status call
also returned 401.

After the 06:00 UTC run, `check-bi-production-readiness.ts` against
`.env.livecheck` will show it, with no new tooling required.

### Milestone closed

The BI Engine was already running safely in production; this milestone did not
enable it and did not redesign it. What it changed is that one stage failing can
no longer take the stages behind it, a failure now reaches an operator instead of
a short-retention log line, and production can answer whether the engine ran.

### Follow-ups — recorded, not blocking BI

1. **QuickBooks and Google Calendar** read `CONNECTED` while neither has synced
   in 18–23 days (14 and 11 failures). Both need owner re-consent; QuickBooks a
   fresh grant, Google its OAuth app published first.
2. **Six FAILED Stripe rows**, live/test key mismatches left from the live
   cutover — and each carries `syncFailureCount: 0`, so the counter is not what
   marks a row failed.
3. **No production shipping-cost data** — 0 of 5 orders carry
   `shippingCostInCents`, so `planNetOfPostage` returns `null` platform-wide.
4. **`learn` is near-silent** — 1 belief across 16 stores. `BI_ENGINE.md`'s own
   Defect 2, deferred to M2, now confirmed in production.
5. **Deployed-route verification** stays open while `CRON_SECRET` is unavailable
   here.
6. **The identity milestone is undeployed** and needs `promote-brand-claims.ts
   --apply` to ship without twelve stores losing their identity values.


---

## 12. The first cron run under the deployed code — 2026-08-25

**The cron ran at 06:03 UTC**, 4h29m after the deploy completed at 01:34 UTC. So
this is the first execution of `892f67b`'s stage-isolated cycle. Read-only
evidence, nothing written.

### It completed

| | Pre-deploy (08-24) | After the 06:03 run | Δ |
|---|---|---|---|
| `insight` cognitive outputs | 214 | 222 | **+8** |
| proactive deliveries (J4 spoke) | 8 | 16 | **+8** |
| observations ACTIVE / RESOLVED | 131 / 148 | 131 / 148 | **unchanged** |
| beliefs | 1 | 1 | 0 |
| `document_gap:staff_policy` observations | 0 | 0 | 0 |
| stores with unconsumed events | 0 | 0 | 0 |

Seven stores produced output between 06:03:13 and 06:03:14. Five of those have
business events of their own; the rest were reached through the connector path,
whose syncs (Mailchimp, Printful ×2, PayPal ×2, Stripe) succeeded in the same
pass.

### Nothing was retracted

The property the milestone most needed to hold, measured directly across the run
window:

- observations **newly first-noticed** 06:00–06:15: **0**
- observations **resolved** 06:00–06:15: **0**
- ACTIVE / RESOLVED after the run: **131 / 148**, identical to before

No standing finding was withdrawn, and none was replaced with an empty result.

### `speak` ran — the stage the old code would have skipped on a provider failure

J4 spoke 8 findings in this pass. Deliveries by day: **8 on 08-24, 8 on 08-25**.
That is a steady rate, not a jump — yesterday's 8 were produced by the *old*
code. **This milestone did not unblock J4 speaking, and the numbers do not
support claiming it did.**

### The AI review did not run at all, and that is correct

**0 AI reviews since the deploy** — no SUCCESS, no PENDING, no FAILED. The stage
is gated on its own 24-hour staleness check, and the run landed 23h23m after the
previous one, so it returned early for every store. No provider call, no spend,
no failure. `STALE_REVIEW_MS` behaving exactly as written.

### What this run therefore does and does not prove

**Proves:** the deployed stage-isolated cycle executes end to end in production,
produces insights, speaks findings, and retracts nothing.

**Does not prove:** the isolation itself. **No stage failed in this run**, so the
path where one stage's failure is contained and the stages behind it still run
was never entered. That behaviour is proved by
`verify-bi-production-readiness.ts` — 30 assertions with 8 negative controls,
including the exact case of a throwing `ai_review` followed by `staff_policy_gap`
and `speak` still executing — but it has not yet been observed in production, and
will not be until a stage actually fails there.

Stated plainly rather than folded into the success: a clean run is evidence the
cycle works, not evidence that the failure handling works.

### BI verification follow-up: CLOSED

The remaining follow-up was "confirm the production cron is executing the
deployed stage-isolation implementation". It is: commit `892f67b`, run at
06:03 UTC on 2026-08-25, completed, nothing retracted.

The other follow-ups in §11 are unchanged and stay open.
