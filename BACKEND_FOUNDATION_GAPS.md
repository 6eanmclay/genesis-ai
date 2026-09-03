# Backend foundation — open gaps and standing limitations

**Live record, opened 2026-08-30.** Everything here was found by building or
testing the pre-Connections backend foundation, and every entry is either
deliberately deferred or genuinely blocked. Nothing here is a to-do somebody
invented; each was discovered with evidence and is recorded so it is not
rediscovered as new.

Numbering is continuous with the working session that produced it.

---

## Deferred by decision

| # | Gap | Why it is not built |
|---|---|---|
| **14** | ~~Webhook replay execution~~ — **closed 2026-08-30.** `replayDelivery()` exists, and `/admin/operations` is the trigger and the audience. The note below still describes why it was required. |
| **21** | ~~The money paths combine verification with handling~~ — **closed 2026-08-30 (Rank 4).** Both routes split at the line they had already drawn in their own comments. The handling halves moved to `lib/payments/stripeEvent.ts` (525 lines, byte-identical) and `lib/payments/paypalEvent.ts`; verification stayed in the routes, and the suite asserts it did not follow the handling out. All three providers are now replayable. |
| **16** | **`ProviderDouble` is not used by any production connector's tests.** It proves the pipeline, not any shipped provider. | Sean, 2026-08-30: leave it as infrastructure. Forcing it into EasyPost's tests — which already exercise the real verifier — would close the gap artificially and test less than they do now. |
| **9** | **The six original telemetry emit sites are un-migrated.** Two taxonomies coexist: `category` for product analytics, `subsystem`/`actorKind` for systems. | Migrating them is churn on working analytics with no question it would answer. |
| **6** | **Three private idempotency implementations were migrated; the growth-point ledger deliberately was not.** | It records a charge Stripe already made — inbound idempotency inside a transaction. `runOnce` is for outbound effects and spans two tables, so migrating would replace a transactional guarantee with a weaker one. |
| **11** | **`pruneExpiredAttempts`, intelligence cycles and sourcing have no durable retry.** | Investigated 2026-08-30: all three recompute what is due from stored state each run, so a failure means the same work is still due next run. Unlike a notification, a delayed insight is not a customer who never got a receipt. Revisit if cron frequency changes. |

### Gap 21 in full — the shape the money paths needed, and now have

**Verify once → persist the verified delivery → handle and replay independently.**

The invariant, stated by Sean and load-bearing for the whole design:

> Replay must never mean *"trust this stored body forever."* It means *"this
> exact delivery was authenticated when it was originally received, and we are
> now re-running the already-authenticated delivery through an idempotent
> handler."*

Which is why `signatureValid` is a persisted column and not a runtime
recomputation, why `replayDelivery` refuses any delivery whose signature never
verified, and why the stored payload is kept verbatim. What is missing on
Stripe and PayPal is only the *separation*: their verification and their
handling are one function, so the second half cannot be called on its own.

Prioritized as an architectural gap, not a defect to patch.

### Gap 14 in full — replay is required, not optional

The generic route (`/api/integrations/[provider]/webhook`) returns **500** when a
handler fails, so the provider retries and replay happens by itself.

All three dedicated routes return **200 unconditionally**:

- **EasyPost** by design — a carrier retry over a parcel this platform never
  created is noise and eventually gets the endpoint suspended.
- **Stripe** and **PayPal** at both of their success returns.

So on those three a provider will **never redeliver a failed delivery**. The
`failed` rows in `WebhookDelivery` are today a dead end, recoverable only by a
replay mechanism we do not have. The payload is kept verbatim precisely so that
mechanism can exist.

---

## Closed by the operator surface (Item 8, 2026-08-30)

These three were numbered in the Item 7 report and — found while writing this
update — never made it into this file. Recorded now, closed, with what they
originally said, so the record is the record rather than the report being it.

| # | Gap as reported | How it closed |
|---|---|---|
| **18** | `replayDelivery()` was built and wired to nothing. Reachable only from a script. | `app/admin/operations/actions.ts` calls it. **No second execution mechanism**: the action supplies the actor and the handler map and nothing else — every refusal, claim and status rule stays inside `replayDelivery`. The action carries its own `assertPlatformAdmin` because a layout gates pages and not POST endpoints. |
| **19** | `releaseStaleReplays()` depended on an operator remembering to run cleanup by hand. | It runs on the existing daily cron beside `sweepAbandonedTemporaries`, under its own correlation id with its own catch. Deliberately not queued: it is an idempotent recompute over a time window, so a failed run is repaired by the next one — a retry mechanism would add state without adding recovery. |
| **20** | A successful chain could not be found; `recentTraces` is failure-first and nothing else looked. | `findTraces()` matches an **exact** correlation id, execution id, provider reference, provider event id or idempotency key — successes included. `recentTraces()` is untouched. The lookup **requires a term**: an empty query returns nothing rather than everything, which is the whole difference between a lookup and the activity feed this was asked not to become. |

---

## Found while building, not yet scheduled

*(Item 23 closed 2026-09-02 and is kept here with its record rather than deleted.)*

| # | Item |
|---|---|
| **24** | **Sixty-two suites still name a source file by hand.** Found 2026-09-02 while closing the "code moved, assertion didn't" class: `scripts/lib/sourceOf.ts` resolves a symbol to its current file and throws a named error when it cannot, and the four suites that had actually failed that way were repointed through it (`bag-checkout`, `take-me-there`, `bi-production-readiness` — `sourcing-schedule` no longer reads source at all). **The other 62 were deliberately left alone.** Converting them wholesale would be a large, mechanical edit across suites nothing had reported a problem with, and the helper's value is proven by the ones that broke rather than by a count. **The exposure is real but bounded**: each of those suites reads a path that is correct today, and the failure only appears when that particular file moves — loudly if the file is gone, and SILENTLY if it is left behind with stale contents, which is the direction worth worrying about. **When to spend the effort**: convert one whenever it fails for this reason, and convert the rest only if the class recurs often enough to be cheaper in bulk. `grep -l 'read("app"\|read("lib"' scripts/verify-*.ts` lists them. Two shapes cannot use the symbol resolver and need `sourceOfRoute()` instead: route handlers, because fourteen files export `GET` and the name is no identity there. |
| **25** | **CLOSED 2026-09-02 — a failing suite exited 0. The lane was never the problem, and the first version of this row was wrong.** **The correction first, because it is the more useful half.** This row originally said the suite `verify-email-normalization` **fails correctly when run alone** and passes only in a full lane, and blamed a shared `next dev`. Every part of that is false. Measured: the isolated run prints `4 failed, 9 passed` and exits **0**, exactly as the lane run does. There is no shared server to blame either — `SHARE_SERVER` is opt-in behind `--share` and nothing passes it, so all seven suites were already running solo. The claim came from grepping output for lines beginning `FAIL `, which matched the suite's own indented assertion lines rather than the runner's verdict, so a suite that had reported four failures was read as having failed the lane. A measurement taken through a wrong filter is not evidence, and it sent the investigation after an isolation bug that did not exist. | **Root cause, four mechanical links.** `scripts/lib/realPostgres.ts` imports `embedded-postgres`, which calls `AsyncExitHook(gracefulShutdown)` at module scope (`dist/index.js:397`) — the import alone is enough. async-exit-hook's first registration adds `hookEvent("beforeExit", 0)` (`index.js:90`), whose listener ends in `process.nextTick(process.exit.bind(null, 0))` — a hard exit with a **hard-coded zero**. So any suite that reported failure the ordinary Node way, by setting `process.exitCode` and returning, exited 0 the moment the event loop drained. The assertions ran, printed their failures, and the runner recorded PASS, because a runner has nothing to go on but the child's exit code. **This was never about HTTP.** `scripts/lib/testServer.ts` imports the same harness, which is why the HTTP lane was where it showed. | **Blast radius, counted rather than estimated: 9 suites** — the 7 HTTP-lane suites that reach a real server, plus `verify-concurrency-live` and `verify-restore` in the Postgres lane. The other 275 call `process.exit()` outright, which is why the code-only lane never lied and why the Postgres lane mostly told the truth. Worse than a wrong assertion passing: a suite whose `main()` **threw** also exited 0. | **Fix**: `scripts/lib/trueExitCode.ts` prepends a `beforeExit` listener that exits with the code the process meant. `prependListener` puts it ahead of the hook whatever order modules load in — deliberately not an import-order convention, which a formatter can silently undo. It is imported beside the import that needs it, and does nothing at all on the passing path. | **Guarded by** `verify-exit-code-integrity.ts` (8 assertions, code-only lane): real child processes ended real ways, asserting the number the OS reports; controls proving the guard invents no failure and does not rewrite an explicit `process.exit(3)`; and a tree-derived invariant that the hook is reached from exactly one file and that file installs the guard — so a second importer cannot reintroduce this quietly. |
| **26** | **Infrastructure fails to start often enough to lose a suite per full run, and in nine suites that was invisible until today.** Found 2026-09-03, immediately after closing gap 25 — the fix is what made it visible. Across three full `run-all-suites.ts` runs at the same commit, a different suite failed each time and **every one of them passed when run alone**, with identical source: `business-context-live` (8s, `pg_ctl` never came up) and `verification-readback` (7s, same) in run 1; `attribution-live` in run 2; `email-normalization` in run 3 at **191s** against a normal 17s, having printed nothing but the Next banner. None is an assertion failure. The two Postgres-lane ones are demonstrably a server that never came up. The HTTP-lane ones were then caught in the act by streaming a failing run's full output, and they are something else entirely - **the harness refusing to run at all**: `REFUSING TO RUN: the test server is not using the test database`, because `/api/cron/status` answered **404** to all ten attempts. That route returns **401** when unauthorized and never 404, so a 404 means the route did not resolve in that `next dev` at all, and the guard was right to refuse: it cannot tell a route that vanished from a server pointed at a real merchant's database, and posting webhooks at the second would be unforgivable. The lane starts server after server in one project directory, which is the obvious suspect for a route manifest being read while it is rewritten - and, as with gap 25, that is a suspect, written down as one. | **The part that matters more than the flakiness.** This is a false RED, not a false green - but before the gap 25 fix it was neither, because a suite that REFUSED TO RUN exited 0 and was recorded as PASS. These suites could have been declining to run for weeks and the lane would have reported 7/7 throughout. That is gap 25 seen from the other side, and it is the strongest reason not to treat the nine suites' green history before 2026-09-03 as evidence of anything. | **It is not caused by the gap 25 fix, and that is measured rather than assumed.** The two Postgres-lane suites call `process.exit()` outright, so the guard cannot affect their exit code either way — spontaneous startup failure on this machine is therefore established independently. What changed is only whether it can be SEEN: sabotage proved that without the guard a suite whose `main()` throws exits 0, and a server that fails to start throws. So for the nine suites of gap 25's blast radius this flakiness has been happening all along and reporting PASS. | **Why it is recorded rather than fixed.** The obvious remedy — retry a suite whose infrastructure failed to start — is a change to runner semantics, and a retry that cannot distinguish 'the server did not start' from 'the code is broken' is a machine for hiding real failures. That deserves its own item with its own sabotage, not a bolt-on at the end of an unrelated one. **Until then**: a single required failure in a full regression is not yet a defect. Re-run that suite alone before believing it — and if it passes alone, say which, rather than reporting the run as green. **Related**: this machine has a documented history here (PC Manager disabled 229 services; a missing page file), so the cause may not be in this repository at all. |

| # | Item |
|---|---|
| ~~**23**~~ | **CLOSED 2026-09-02. Every verify-* suite now belongs to a lane with a runner.** This entry named sixty-one suites that bring their own Postgres and said the right fix was a third runner rather than a widened HTTP lane. Asking the lane functions for every file found those and 106 more that need no infrastructure at all, equally unrun — **284 suites, of which 117 had a runner**. Two runners closed it: `run-code-suites.ts` (96 suites, ~3m) and `run-pg-suites.ts` (62 suites, ~14m). **Coverage now: 284 = 15 browser + 7 http + 95 database + 96 code-only + 8 code-only-live + 62 own-database + 1 permanently excluded, and `unclaimedSuites()` returns zero.** **The fourth lane is defined as the COMPLEMENT**, not as `/startRealPostgres/` — written the obvious way it would have silently dropped `verify-ledger-live.ts`, which gets its database through a different helper. `run-pg-suites.ts` refuses to run at all while any suite is unclaimed, and the code runner warns; both are sabotage-proven. | **The first full run: 55/62, and all seven failures were real.** One infrastructure — a full-database TRUNCATE deadlocking against the production client's own pool, reproducible, now retried three times because a deadlock is transient by definition and nothing in production truncates. Six stale, each verified at its new seam before repointing: an executable fixture predating the rule that `verify()` is required (it cast itself through `as never`, so the compiler could not say so, and execute() threw calling a method that was not there — while the write it had already done stayed on disk); a shipping refusal pinned to wording `ad98720` deliberately changed to stop naming a carrier; two suites reading a cron response shape the scheduler replaced in `838fe95`; a card-list assertion requiring every screen to render one, when `website/page.tsx` deliberately stopped; and **three fixtures stale against my own Slice 1-3 work** — the cycle's stage list, elapsed-time due-ness, and a failed-pass premise that Slice 1b removed by making the deterministic cycle provider-free. Every one of those shipped while this lane had no runner. **Sabotage found three of my own assertions too weak**: one read `skipped` without its reason, so flipping the sourcing gate on stayed green; one matched any nearby `reportIssue`, so deleting the failure report left the bookkeeping ones to satisfy it; and one sabotage aimed at a suite the HTTP lane already owned. All three assertions were tightened and all eight sabotages are red. |

---

## Requires paid infrastructure

| # | Item |
|---|---|
| **22** | **The durable queue's only runner is a daily cron.** `/api/cron/tick` is built, authorized, lane-scoped to `queue` and `timely`, and proven by `verify-scheduler-db` — and deliberately absent from `vercel.json`, because a second cron entry needs a paid Vercel plan and a paid requirement must not be faked locally. Until it is switched on, a job enqueued just after the daily tick waits nearly 24 hours, which includes a customer's order confirmation. **Turning it on is one line**: `{ "path": "/api/cron/tick", "schedule": "*/2 * * * *" }`. No task, handler or library changes. The suite asserts both that the trigger exists and that it is NOT scheduled, so this cannot drift into "we forgot". |

---

## Blocked until Connections credentials

| # | Limitation |
|---|---|
| **13** | **Eleven connectors that support webhooks upstream declare none** — Square, Xero, Twilio, Printful, Meta and the rest. Their signature schemes cannot be verified against a live account, and an unverifiable implementation is worse than none because it looks finished. Adding one is mechanical: provider adapter → `verify` → normalized delivery → handler/queue → correlation → idempotency. |
| — | **No real provider has ever signed a request here.** Every signature in every suite is constructed locally. `ProviderDouble` states what we *believe* a provider does; Connections is what replaces belief with evidence. A green suite is not readiness. |
| — | **The Stripe SDK and PayPal API verification paths are unexercised.** |

---

## Unproven by this harness

Recorded rather than papered over. Each was attempted and could not be made to
discriminate.

**Four of these were closed on 2026-08-30.** They were never properties of the
code — they were properties of PGlite, which serialises concurrent clients. A
real PostgreSQL with a real connection pool had been in this repository since
August; nothing needed building to use it.

| Limitation | Why |
|---|---|
| **Stripe / PayPal route-level execution** | They are Next route handlers needing a running server. `tsc` passes and the changes are a wrapper plus inserts, which is not the same as verified. |
| ~~Concurrent duplicate webhook deliveries~~ | **PROVEN 2026-08-30** on real PostgreSQL — and it found a defect. The unique index kept one row and handed the seven losing callers `null`, so the route recorded no delivery id, `markProcessed` did nothing, and a handled event sat at `received` for ever. `recordDelivery` now treats losing that race as the ordinary duplicate it is. |
| ~~Two runners racing for one job~~ | **PROVEN 2026-08-30.** Twelve rounds, eight racers, exactly one claim every time. Removing the condition from the claim produces "8 runners claimed it". |
| ~~Two callers racing `runOnce` on one key~~ | **PROVEN 2026-08-30.** The external effect happens once; making the loser perform anyway produces "the effect happened 8 times". |
| **The Growth Point conditional update cannot be independently proven** | The invariant holds — twelve rounds of eight racers against a balance covering exactly one, and the balance never went negative. But removing the conditional `WHERE` changes nothing observable: the read and the plan are inside the transaction, the row lock serialises the racers, and the second transaction sees the committed balance and refuses before any second charge is attempted. Belt-and-braces beneath a transaction that already refuses. Kept, and recorded rather than deleted because a test could not see it. |
| **The storage reservation lock** | Recorded in `lib/storage/ledger.ts` since 2026-08-29. Not covered by the concurrency suite — the storage path is a different shape and was not in scope for this item. |
| **Two lines in `isAllowedPlatformAdmin` are redundant** | Removing `.filter(Boolean)` alone, or the empty-allowlist return alone, changes no result — the empty-email return already refuses the only input a blank entry could match. Both are kept as belt-and-braces and neither can be independently proven; removing *both* the empty-email return and the filter admits anybody through a trailing comma, and that combination *is* caught. Recorded in the file. |
| **The `findTraces` length floor proves nothing** | Sabotage removed it and the suite stayed green, correctly: exact matching already makes a short term find nothing. It is kept to avoid five pointless queries on an empty submission, not credited as the thing that keeps a lookup from being a feed. |
| **`ScheduledTaskRun` has no retention** | It grows forever. A stuck `running` row blocks nothing — due-ness reads `succeeded` — so this is table growth rather than a stall, and it wants the same treatment `telemetry.prune` now gets rather than a second mechanism. Opened 2026-08-30 with the scheduler. |
| **Nothing tells a person the scheduler stopped** | `/admin/operations` reports overdue, stuck and failing tasks, and reporting it on a page somebody has to open is not an alert. This is the same absence the inventory records platform-wide: there is no alerting path of any kind. |
| **The intelligence skip-list is gone** | The old route ran connector syncs and intelligence cycles in one invocation and deduplicated by passing `skipStoreIds`. As independent tasks there is no "just now" to deduplicate against, so deduplication comes from `runDueIntelligenceCycles` selecting only stores with new activity. That is believed sufficient and is a behaviour change, stated rather than slipped in — worth watching the first time both tasks run against real stores. |
| **No real Stripe or PayPal signature has ever been verified here** | Every signature in every suite is generated locally with a secret we chose. `verify-webhook-handlers` uses Stripe's own SDK to sign, which is stronger than a hand-rolled HMAC and still says nothing about Stripe's live behaviour. |
| **PayPal's verification has never run at all** | It is a live API call against a transmission id, a certificate URL and a timestamp. Nothing in this harness can make it. The route half that calls it is therefore unexercised, while the handling half it guards is now well covered. |
| **No money-path route has run over HTTP** | The routes are invoked as functions. `verify-stripe-webhook-e2e` needs a running server and stays excluded. Item 7 of the locked order is what closes this. |
| **Nobody has clicked the replay button** | The action's guard is asserted against its source, and `replayDelivery` is proven by `verify-replay-db`. What has never happened is a browser POST to the generated action id — including the unauthorized one. Proving that refusal end to end needs a running server and two real sessions. |
| **No email has ever been sent** | There is no `RESEND_API_KEY`. Every notification path is exercised against an injected sender. |

---

## For the next phase

| # | Item |
|---|---|
| **17** | **A connector contract test.** `verify()` must be proven to fail closed and never let an invalid delivery through — for *every* connector, not just EasyPost, which is checked individually today. Nothing enforces it for the next one added. |
| **1** | **`ProductEvent` / `SecuritySignal` growth.** Retention is designed and the `telemetry.prune` job exists dark; the 90-day window is a proposal, not a ruling, and `SecuritySignal` has no policy at all — its horizon is a security decision about how far back an investigation should reach. |
| **2** | ~~End-to-end correlation viewer~~ — **closed 2026-08-30.** `traceFor()` assembles the six sources and `/admin/operations` renders the timeline, reachable from any failed delivery, any recent failure, and by lookup. |
| **7** | **No `creation.failed` event** — abandonment and failure are indistinguishable in the Creation Station funnel. |
| **8** | **`logClientEvent` accepts a free-form name** — unbounded cardinality from a client; should take a registry key. |
| **12** | **Transactional telemetry.** `recordExecution` accepts an injected client for transactions, so a correlated write inside a transaction that rolls back leaves telemetry claiming something happened. Explicitly an open architectural decision. |
| **4** | **`CLAIM_TTL_MS` is fixed at five minutes.** A provider call slower than that is declared indeterminate while still running. Should be per-operation once real providers exist. |
| **5** | **No provider-level idempotency header.** Stripe supports `Idempotency-Key` natively, which is stronger than our record because the provider itself deduplicates. Belongs with each provider. |
| **15** | ~~Stripe `markProcessed` timing~~ — **closed 2026-08-30.** It recorded receipt and called it handling; the outcome is now decided in the wrapper. |
| **10** | ~~Production notification handler unverified~~ — **closed 2026-08-30** in `verify-webhook-pipeline-db`. |
| **3** | ~~Test coupled to other suites' data~~ — **closed**; the pattern recurred twice more and both were fixed the same way. |
