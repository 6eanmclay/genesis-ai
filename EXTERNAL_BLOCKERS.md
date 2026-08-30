# Blocked only by an account, a credential, or a paid plan

**A running list, opened 2026-08-30 at Sean's request.** Everything here is
finished, or finishable, engineering waiting on access that no amount of code
provides. It exists so that the day access arrives, the list of what to switch
on is already written and nobody has to reconstruct it.

Nothing here is a to-do for engineering. Each entry names what is already built,
what exactly is required, and what happens the moment it exists.

---

## Waiting on an account

| # | What is built | What is required from Sean | What happens when it exists |
|---|---|---|---|
| **E1** | **Every notification path.** Order confirmations, shipping notices, refund notices, password reset, and every security notification — queue, handler, idempotency key, retry and sweep all built and proven against an injected sender. | A **Resend account** and a **verified sending domain**, ideally on a dedicated subdomain so a marketing send can never affect transactional deliverability. Then `RESEND_API_KEY` and `EMAIL_FROM_ADDRESS`. | Customers start being told what happened to their money. This is the highest-value single item on the whole project. |
| **E2** | **Voice output.** Pushed 2026-08-09, server-ready, never verified against real synthesis. | An **ElevenLabs** key. | The path can finally be proven rather than assumed. |

## Waiting on a paid plan

| # | What is built | What is required | What happens when it exists |
|---|---|---|---|
| **E3** | **`/api/cron/tick`** — the frequent trigger for the durable queue. Authorized, lane-scoped to `queue` and `timely`, budgeted inside its own interval, proven by `verify-scheduler-db`, and deliberately absent from `vercel.json`. | A **Vercel plan allowing more than one cron entry**. | One line: `{ "path": "/api/cron/tick", "schedule": "*/2 * * * *" }`. A job enqueued after the daily tick stops waiting nearly a day — which today includes a customer's order confirmation. No task, handler or library changes. |
| **E4** | **Split scheduling cadences.** Every task already declares the interval it actually needs; one daily trigger currently offers all of them one chance a day. | The same plan as E3. | The declared intervals become the real ones. Nothing in `lib/scheduler` changes. |
| **E5** | **A preview environment with production-shaped data.** | A Vercel Preview environment, and a decision about what data it may hold. **Not** production secrets — `INTEGRATION_ENCRYPTION_KEY` must never be copied there. | Route handlers, checkout and webhooks can be exercised over real HTTP before production is the first place they run. |

## Waiting on a decision only Sean can make

| # | Item | Consequence of leaving it |
|---|---|---|
| **E6** | **The migration gate.** Every push to `master` migrates production with no review step; reversed 2026-08-13 and open since. | A wrong schema change reaches production automatically, and the only rollback for a destructive migration is a restore whose viability nobody has tested. |
| **E7** | **Where an operational alert should go.** `needsAttention()` computes it; nothing carries it. | Every failure the observability work made visible still requires somebody to open a page. Deliberately not chosen by me — see item 4 of the locked order. |
| **E8** | **A live end-to-end payment test.** | The money path has never moved real money under this code. |

## Blocked by Connections (recorded here, out of scope by instruction)

Social publishing and its OAuth apps; the eleven connector webhooks; any proof a
real provider signature verifies; the Printful live economics check; EasyPost
account verification and live labels. All are named in
`BACKEND_FOUNDATION_GAPS.md` and `PRE_CONNECTIONS_CHECKLIST.md`; none is worked
on during the locked sequence.
