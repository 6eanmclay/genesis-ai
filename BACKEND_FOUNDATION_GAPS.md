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
| **21** | **The money paths combine verification with handling, so a legitimately received delivery can never be replayed.** `handleStripeWebhook(body, headers)` and `handlePaypalWebhook(request, storeId)` verify internally, so neither can run against a stored body — a stored signature is time-expired by definition. Only EasyPost, whose handler lives on its connector as `webhooks.handle(storeId, rawBody)`, is replayable; `/admin/operations` says so per row rather than drawing a button that always refuses. **Sean, 2026-08-30: not part of Item 8 — a payment-path refactor deserves its own deliberate item, not a rushed patch.** See the shape below. |
| **16** | **`ProviderDouble` is not used by any production connector's tests.** It proves the pipeline, not any shipped provider. | Sean, 2026-08-30: leave it as infrastructure. Forcing it into EasyPost's tests — which already exercise the real verifier — would close the gap artificially and test less than they do now. |
| **9** | **The six original telemetry emit sites are un-migrated.** Two taxonomies coexist: `category` for product analytics, `subsystem`/`actorKind` for systems. | Migrating them is churn on working analytics with no question it would answer. |
| **6** | **Three private idempotency implementations were migrated; the growth-point ledger deliberately was not.** | It records a charge Stripe already made — inbound idempotency inside a transaction. `runOnce` is for outbound effects and spans two tables, so migrating would replace a transactional guarantee with a weaker one. |
| **11** | **`pruneExpiredAttempts`, intelligence cycles and sourcing have no durable retry.** | Investigated 2026-08-30: all three recompute what is due from stored state each run, so a failure means the same work is still due next run. Unlike a notification, a delayed insight is not a customer who never got a receipt. Revisit if cron frequency changes. |

### Gap 21 in full — the shape the money paths need

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

| Limitation | Why |
|---|---|
| **Stripe / PayPal route-level execution** | They are Next route handlers needing a running server. `tsc` passes and the changes are a wrapper plus inserts, which is not the same as verified. |
| **Concurrent duplicate webhook deliveries** of one event id | The pooled harness serialises them. |
| **Two runners racing for one job** | Same — `verify-jobs-db` passes with the claim guard removed, and says so in the file. |
| **Two callers racing `runOnce` on one key** | Same. The unique index handles it and the collision path is written, but the collision could not be forced. |
| **The storage reservation lock** | Recorded in `lib/storage/ledger.ts` since 2026-08-29. |
| **Two lines in `isAllowedPlatformAdmin` are redundant** | Removing `.filter(Boolean)` alone, or the empty-allowlist return alone, changes no result — the empty-email return already refuses the only input a blank entry could match. Both are kept as belt-and-braces and neither can be independently proven; removing *both* the empty-email return and the filter admits anybody through a trailing comma, and that combination *is* caught. Recorded in the file. |
| **The `findTraces` length floor proves nothing** | Sabotage removed it and the suite stayed green, correctly: exact matching already makes a short term find nothing. It is kept to avoid five pointless queries on an empty submission, not credited as the thing that keeps a lookup from being a feed. |
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
