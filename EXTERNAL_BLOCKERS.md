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

## Waiting on a provider-side subscription

| # | What is built | What is required | What happens when it exists |
|---|---|---|---|
| **E9** | **Stripe dispute handling** — all five events, the full lifecycle, funds tracked separately from the claim. | The **`charge.dispute.*` events must be enabled on the Stripe webhook endpoint**. Stripe sends only the event types an endpoint subscribes to, and the current endpoint was configured for checkout and refund events. | Nothing in the code changes. Until then a chargeback is recorded verbatim in `WebhookDelivery` and never reaches the handler — the same silence this item was built to end, one layer further out. **This is the single most important line in this file after E1.** |
| **E10** | **PayPal dispute handling** — not built, deliberately. | Each store's PayPal app must subscribe to `CUSTOMER.DISPUTE.*`. The per-store webhook currently subscribes to refund events only, and whether disputes ever arrive is a per-store configuration this platform does not control. | Handling can then be written against events that actually arrive. Writing it first would be a handler that has never run and cannot be proven — the shape this project treats as worse than an honest absence. |

## Waiting on a decision only Sean can make

| # | Item | Consequence of leaving it |
|---|---|---|
| **E6** | **The migration gate.** Every push to `master` migrates production with no review step; reversed 2026-08-13 and open since. | A wrong schema change reaches production automatically, and the only rollback for a destructive migration is a restore whose viability nobody has tested. |
| **E7** | ~~Where an operational alert should go~~ — **partly closed 2026-08-30.** The audit found the premise was wrong: a destination already exists. Sentry is wired, its DSN is set in production, `reportIssue` redacts and sends to it, and thirty-three modules already use it. What was missing was that EXCEPTIONS reach Sentry while this platform's real failures — a dead letter, an unknown outcome, a task that stopped — are conditions found by asking, not thrown. `ops.alerts` now asks hourly and reports each distinct finding once every six hours. **What is still yours to decide**: whether Sentry is where you want to be told, or whether these should also reach email (needs E1) or a chat webhook (needs a URL from you and about an hour of work). Nothing is blocked on that decision; it changes the destination, not the detection. |
| **E8** | **A live end-to-end payment test.** | The money path has never moved real money under this code. |
| **E13b** | **Retention horizons for five tables nobody has decided about.** ExecutionLog (the audit trail), OutboundOperation (the idempotency record — deleting a row makes its key reusable, so a replay could genuinely happen twice), AiUsageEvent (cost history the /admin numbers are computed from), BusinessEvent (read through cursors, so a prune must be cursor-aware) and CognitiveOutput (what J4 remembers about a business). | Each carries a `decide` verdict and the sweep reports it untouched. **What is required from you**: a horizon for the audit trail informed by what accounting and dispute evidence actually needs — and for the other four, a decision on roll-ups, cursor-aware pruning, and how long J4 should remember. Recorded rather than guessed, because ninety days for an execution log is exactly the arbitrary assumption that ruins an investigation nobody has started yet. |
| **E12b** | **Switching the retention sweep on.** Built, bounded, idempotent, sabotage-tested from both directions, scheduled daily — and enqueued with no `apply` flag, so nothing is deleted. | It clears **customer data**: the stored bodies of handled provider deliveries. The row survives with its full audit value; the body goes at 30 days, and a `failed` or `replaying` delivery keeps its body at any age because replay needs the bytes. **What is required from you**: read the footprint and say the horizon is right, then it is one field in the payload. |
| **E12** | **Switching security-signal deletion on.** The prune is built, bounded, idempotent, sabotage-tested from both sides of every horizon, scheduled daily — and enqueues with **no `apply` flag**, so the handler's dry-run default stands and nothing is deleted. | It deletes evidence. The horizons are a judgement about how long each kind of signal is worth keeping (400 days for an incident or a deliberate replay, 180 for a pattern, 30 for volume), and they should be looked at against a real footprint before anything goes. **What is required from you**: read `/admin/security`, decide whether those numbers are right for your obligations, then say so — at which point it is one field in the enqueued payload. |

| **E16** | **How long the retained transaction record must be kept after an account closes.** Closure anonymises the person and keeps the business's orders — amounts, customer emails, provider ids — deliberately and for ever, because nothing tells it when to stop. | This is the one genuinely legal/accounting question in Item 4, and it was not guessed. **What is required from you**: confirmation from whoever advises you on tax and company records of how long an order must be retained after its merchant leaves, and whether a customer's email and postal address may be kept for that whole period or must themselves be anonymised at some earlier point. Until then the record is kept intact — the recoverable error rather than the unrecoverable one. Note this is separate from a CUSTOMER's own erasure request, which is a different person asking about a different record and is not built. |
| **E17** | **Whether a closed account's businesses should stay live.** Closure leaves every Store exactly as it was, including `published: true`. A storefront whose owner has closed their account keeps serving and keeps taking checkouts. | Unpublishing them would be a product decision wearing a maintenance decision's clothes, and stopping a live shop is not obviously the kinder outcome — there may be a transfer, a co-owner, or orders in flight. **What is required from you**: whether closing an account should unpublish its storefronts, transfer them, or leave them running. One line of code once decided; not decided here.

| **E18** | **Tax is not recorded on an order, anywhere.** No column on `Order`, `OrderItem` or any other model holds a tax amount, and checkout never asks Stripe for one. The order detail screen says "Not recorded — check Stripe" rather than printing a zero, because a zero is a claim that no tax was charged and this platform cannot make it. | **What is required from you**: whether Genesis should collect tax at all. If yes, that is Stripe Tax (a setting on your account plus `automatic_tax` on the session) and a column to store `total_details.amount_tax` — a real piece of work, not a display fix. If no, the current wording is already correct and this line can close. Either way it is an accounting decision rather than an engineering one, which is why nothing was guessed. |
| **E19** | **No customer has ever received an email from Genesis.** Confirmed against the live database on 2026-08-31: `confirmationSentAt` is null on every order ever placed, including both real paid orders. `isEmailConfigured()` is false without `RESEND_API_KEY`, so `sendEmail` refuses honestly rather than pretending — the machinery is correct and has never had a key. | This is E1 seen from the customer's side, and it is now real rather than theoretical: two people have paid money and neither has had so much as a receipt. **What is required from you**: a Resend account and a verified sending domain. Until then the merchant is the only one who can tell a buyer anything, which is exactly what the order screen's amber "Not yet" rows are for. |

## Needs a migration and a decision about existing data

| # | Item | Exact behaviour today | What a safe migration requires |
|---|---|---|---|
| **E11** | **Email is unique but not normalised.** | `User.email` is `@unique`, and nothing lowercases it on either side. Registration stores the address exactly as typed; `auth.ts` looks a user up with `findUnique({ where: { email } })` using the credential exactly as typed. So `Sean@example.com` and `sean@example.com` are two separate accounts, each of which can only be signed into with the capitalisation its owner originally used. Nobody is locked out today — the two sides agree, because neither normalises. | Three steps, in this order, and the middle one is a product decision rather than an engineering task. **(1) Measure**: count existing rows that collide case-insensitively, which is a read-only query and can be run at any time. **(2) Decide** what happens to each collision — merge two accounts and their stores, orders and Growth Points; keep the older and disable the newer; or contact both owners. There is no safe default, which is why this is not being chosen here. **(3) Migrate**: normalise on write and on lookup **in the same deploy**, backfill existing rows, and add a case-insensitive unique index. Doing the write side alone locks out every existing mixed-case user, which is exactly what a first attempt at this during Item 3 would have done and why it was reverted before it shipped. |

## Genuinely unprovable locally, whatever we build

Recorded so nobody spends a day trying. These are not decisions and not work —
they are facts about what a laptop can observe.

| # | Item | Why no harness closes it |
|---|---|---|
| **E13** | **No real provider has ever signed a request.** | Every signature in every suite is generated locally with a secret we chose. `verify-order-webhook-live` signs with Stripe's own SDK, which is stronger than a hand-rolled HMAC and still proves only that our code agrees with our own signing. Closing it needs a live account sending a live event — which is Connections. |
| **E14** | **PayPal's webhook verification has never run.** | It is a live API call against a transmission id, a certificate URL and a merchant's credentials. The handler it guards is now well covered; the verification in front of it cannot be exercised at all without PayPal. |
| **E15** | **No server action has been invoked over HTTP.** | An action is addressed by a build-specific id in a `Next-Action` header. Reconstructing it would couple a suite to a private Next detail that changes between versions, so a test built on it fails on an upgrade for no reason. The guards are proven at the function layer and the pages over HTTP. **Not external, and not work** — listed because it is the one boundary no lane reaches, and the honest answer is that it should stay unreached. |

## Blocked by Connections (recorded here, out of scope by instruction)

Social publishing and its OAuth apps; the eleven connector webhooks; any proof a
real provider signature verifies; the Printful live economics check; EasyPost
account verification and live labels. All are named in
`BACKEND_FOUNDATION_GAPS.md` and `PRE_CONNECTIONS_CHECKLIST.md`; none is worked
on during the locked sequence.
