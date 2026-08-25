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
