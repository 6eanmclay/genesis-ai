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
| **E6** | **The migration gate.** Every push to `master` migrates production with no review step; reversed 2026-08-13 and open since. Confirmed again 2026-09-01 by reading `package.json` rather than the docs: `build` is `node scripts/migrate-deploy.mjs && next build`, and that script contains no environment check of any kind. | A wrong schema change reaches production automatically. **The restore half of this is now half-answered**: `npm run verify:restore` replays every migration onto an empty Postgres and proves the result matches `schema.prisma` and takes real writes, so the *software* half of a recovery is tested and passing. Neon's own half — taking a branch at a point in time — still needs a Neon API key and remains untested. **What is required from you**: whether the gate comes back. |
| **E7** | ~~Where an operational alert should go~~ — **partly closed 2026-08-30.** The audit found the premise was wrong: a destination already exists. Sentry is wired, its DSN is set in production, `reportIssue` redacts and sends to it, and thirty-three modules already use it. What was missing was that EXCEPTIONS reach Sentry while this platform's real failures — a dead letter, an unknown outcome, a task that stopped — are conditions found by asking, not thrown. `ops.alerts` now asks hourly and reports each distinct finding once every six hours. **What is still yours to decide**: whether Sentry is where you want to be told, or whether these should also reach email (needs E1) or a chat webhook (needs a URL from you and about an hour of work). Nothing is blocked on that decision; it changes the destination, not the detection. |
| **E8** | **A live end-to-end payment test.** | The money path has never moved real money under this code. |
| **E13b** | **Retention horizons for five tables nobody has decided about.** ExecutionLog (the audit trail), OutboundOperation (the idempotency record — deleting a row makes its key reusable, so a replay could genuinely happen twice), AiUsageEvent (cost history the /admin numbers are computed from), BusinessEvent (read through cursors, so a prune must be cursor-aware) and CognitiveOutput (what J4 remembers about a business). | Each carries a `decide` verdict and the sweep reports it untouched. **What is required from you**: a horizon for the audit trail informed by what accounting and dispute evidence actually needs — and for the other four, a decision on roll-ups, cursor-aware pruning, and how long J4 should remember. Recorded rather than guessed, because ninety days for an execution log is exactly the arbitrary assumption that ruins an investigation nobody has started yet. |
| **E12b** | **Switching the retention sweep on.** Built, bounded, idempotent, sabotage-tested from both directions, scheduled daily — and enqueued with no `apply` flag, so nothing is deleted. | It clears **customer data**: the stored bodies of handled provider deliveries. The row survives with its full audit value; the body goes at 30 days, and a `failed` or `replaying` delivery keeps its body at any age because replay needs the bytes. **What is required from you**: read the footprint and say the horizon is right, then it is one field in the payload. |
| **E12** | **Switching security-signal deletion on.** The prune is built, bounded, idempotent, sabotage-tested from both sides of every horizon, scheduled daily — and enqueues with **no `apply` flag**, so the handler's dry-run default stands and nothing is deleted. | It deletes evidence. The horizons are a judgement about how long each kind of signal is worth keeping (400 days for an incident or a deliberate replay, 180 for a pattern, 30 for volume), and they should be looked at against a real footprint before anything goes. **What is required from you**: read `/admin/security`, decide whether those numbers are right for your obligations, then say so — at which point it is one field in the enqueued payload. |

| **E16** | **How long the retained transaction record must be kept after an account closes.** Closure anonymises the person and keeps the business's orders — amounts, customer emails, provider ids — deliberately and for ever, because nothing tells it when to stop. | This is the one genuinely legal/accounting question in Item 4, and it was not guessed. **What is required from you**: confirmation from whoever advises you on tax and company records of how long an order must be retained after its merchant leaves, and whether a customer's email and postal address may be kept for that whole period or must themselves be anonymised at some earlier point. Until then the record is kept intact — the recoverable error rather than the unrecoverable one. Note this is separate from a CUSTOMER's own erasure request, which is a different person asking about a different record and is not built. |
| **E17** | **Whether a closed account's businesses should stay live.** Closure leaves every Store exactly as it was, including `published: true`. A storefront whose owner has closed their account keeps serving and keeps taking checkouts. | Unpublishing them would be a product decision wearing a maintenance decision's clothes, and stopping a live shop is not obviously the kinder outcome — there may be a transfer, a co-owner, or orders in flight. **What is required from you**: whether closing an account should unpublish its storefronts, transfer them, or leave them running. One line of code once decided; not decided here.

| **E18** | **Tax is not recorded on an order, anywhere.** No column on `Order`, `OrderItem` or any other model holds a tax amount, and checkout never asks Stripe for one. The order detail screen says "Not recorded — check Stripe" rather than printing a zero, because a zero is a claim that no tax was charged and this platform cannot make it. | **What is required from you**: whether Genesis should collect tax at all. If yes, that is Stripe Tax (a setting on your account plus `automatic_tax` on the session) and a column to store `total_details.amount_tax` — a real piece of work, not a display fix. If no, the current wording is already correct and this line can close. Either way it is an accounting decision rather than an engineering one, which is why nothing was guessed. |
| **E19** | **No customer OR merchant has ever received an email from Genesis.** Confirmed against the live database: `confirmationSentAt` is null on every order ever placed, and so is `ownerNotifiedAt`. `isEmailConfigured()` is false without `RESEND_API_KEY` and `EMAIL_FROM_ADDRESS`, so `sendEmail` refuses honestly rather than pretending — the machinery is correct and has never had a key. | Two people have paid and neither has had a receipt; the merchant has never been told a sale happened either. **These are two separate required events** — a customer's transactional confirmation and a merchant's new-sale notice — with separate claim columns, separate queue keys and separate sweeps, so configuring email switches on both rather than one standing in for the other. **What is required from you**: a Resend account and a verified sending domain, on a dedicated subdomain. Until then the order screen's amber "Not yet" rows are the only channel, and the merchant is the only one who can tell a buyer anything. **Corrected 2026-09-02 — this entry had the consequence backwards.** It said the sweep had already enqueued a job per order, spending the keys, so the existing orders would *not* be announced retroactively. Checked against the live database: **there are no notification `Job` rows at all** — the only jobs that have ever run are `telemetry.prune`, `retention.sweep` and `security.prune`. `runDueOrderNotifications` checks `isEmailConfigured()` **before** it reads any order (`lib/orders/notificationSweep.ts:132`) and returns `skipped: true` without enqueuing anything, so no key has ever been claimed. The real consequence is the opposite one and it is a decision, not a side effect: **the first sweep after Resend is configured will send all seven at once**, including the 19 July order, six weeks late, and the two real customers who paid $29.99 and $47.83. **What is required from you**: whether those seven are announced retroactively, announced with wording that acknowledges the delay, or marked as handled outside the system and left unsent. Four of them are the `@example.test` addresses E19a already refuses, so the live blast is three messages, two of them to real buyers. |
| **E19a** | **The reserved-domain guard, required BEFORE email goes live.** Four of the seven orders in production belong to beta-test stores whose owner addresses end in `@example.test`. `.test` is reserved by RFC 2606 and can never receive mail, so those four are guaranteed hard bounces — and they would be among the first messages a brand-new sending domain ever produced, roughly a 57% bounce rate on day one. Bounce rate is the primary reputation signal. | **Sean, 2026-09-01**: implement a guard that refuses delivery to reserved TLDs (`.test`, `.invalid`, `.example`, `.localhost`) before email goes live. **Do NOT mark those test owners as notified falsely** — the claim column stays truthful. Whether the four test stores are ultimately deleted is a separate cleanup decision and nothing deletes them automatically. Domains are being acquired around the 21st–23rd; Resend is configured then, and this guard ships with it. |
| ~~**E22**~~ | **DECIDED AND IMPLEMENTED 2026-09-02.** Sean chose the recommended rule: refuse a proposal whose underlying current values have changed, explain what changed, and no timer. Built as `driftFor`/`explainDrift` in `lib/execution/approvalDrift.ts`, consulted by BOTH approval paths — the single card and the one-click 'approve all', which called `execute()` directly and would otherwise have skipped it entirely. The refusal happens before the row is claimed, so nothing is mutated and the proposal stays decidable; the owner is told in the conversation, because the dashboard button redirects and a refusal with nowhere to appear is an invisible one. 39 checks and 8 sabotages, all red. Original entry follows. **What should happen to a proposal nobody ever decided.** Audited 2026-09-02 against the live database: **48 proposals sit at `PENDING_APPROVAL` across 13 businesses**; 4 are more than 30 days old, 23 are 14–29 days old, and the oldest is 36 days. Nothing expires them and nothing ages them out — there is no staleness concept on `ApprovalRequest` at all. Two facts make that more than untidiness. **First, approving one applies a frozen payload.** `performApproveGenesisAction` hands `approval.input` to `execute()` verbatim and never re-reads the store, so approving a month-old proposal applies a plan written against a store that may no longer exist in that form. This is live and demonstrable today: `paypal-test-books` has a pending `placeholder_store_identity` proposal captured when its name, tagline and description were all empty strings — the store has since been given a real identity ("PayPal Test Books" / "Bookkeeping that finally makes sense" / a full description), and approving that card would overwrite all three on the grounds of a placeholder that is no longer there. **Second, the check that would prevent it already exists.** Every one of the 33 action definitions has `getCurrentValues(context)`, and it is the same function whose output was frozen into `previousValues` when the proposal was made — so "has the store moved since?" is one call and one comparison, at a site that already assembles the context (`buildActionContext`, `lib/execution/genesisAutonomy.ts:132`). It is used today only to reverse an executed action, never to guard one. | An owner's own work can be silently overwritten by a proposal they left sitting, and the longer they leave it the more likely that becomes. **What is required from you** is only what a drifted proposal should DO, because "apply it silently" is the one answer I will not choose on your behalf. My recommendation: at approval time compare `getCurrentValues` against the frozen `previousValues`; when they differ, refuse the execution and tell the owner what changed, rather than expiring proposals on a timer — age is a proxy, drift is the actual condition, and a 6-day-old proposal can overwrite yesterday's edit just as easily as a 36-day-old one. The alternatives are (a) expire at N days and accept that recent overwrites still happen, (b) show the drift on the card and let the owner approve anyway, or (c) both: refuse, and offer to re-propose against the store as it is now. Nothing is built until you pick. Two smaller findings need no decision and are noted here only so they are not lost: `supersedePendingApproval` **deletes** the old row (`deleteMany`) where every other model in this codebase supersedes by status, so `ApprovalRequest`'s documented `SUPERSEDED` state is never written and that history is destroyed while `EXECUTED` and `REJECTED` history is kept; and `GenesisObservation.approvalRequestId` is an unenforced pointer that deletion can dangle — checked, and every dereference today re-reads the row and handles its absence, so this is a latent hazard rather than a live defect. |
| **E23** | **Six observations on screen that nothing can ever retract.** Audited 2026-09-02 against the live database. `resolveMissingObservations` scopes every retraction with `dedupeKey: { startsWith: <prefix> }`, so a `GenesisObservation` written before its producer had a prefix is owned by no producer and can never be resolved. Eight such rows exist; **six are still ACTIVE**, the oldest last confirmed 36 days ago, across `cubit-coil`, `cofoundr` and `socks-galore`. Two are keyed on a bare `ExecutionLog` cuid and read "Starting opportunistic business review — still pending since 7/27"; their underlying action is `genesis.recommendations.generate`, which was later added to `AWAITING_A_HUMAN` precisely because it can never be paired with its own completion — so those two are false by our own later ruling. The other four are pre-`ai_review:` findings. **They are not uniformly wrong, and that is the point**: `cubit-coil`'s `missing_seo_metadata` is false (`blueprint.marketingAssets.seoTitle` is set, and it is what the live storefront serves), while `cofoundr`'s `missing_product_images` is still perfectly true — Spark, Launch, Operate and Scale all still have no image. Neither row shape can be created again; both producers now always prefix. Full detail in `BI_ENGINE.md` §21. | Whichever of the six become false will stay on screen forever, and two already have. The defect is not that the rows are wrong but that nothing can make them right again. **What is required from you**: approval to run a one-off correction that marks those six RESOLVED, after which the current producers re-raise whatever is still true under a properly prefixed key — `cofoundr`'s missing product images would come straight back, correctly, and be resolvable this time. It is six rows on three businesses and it is a **production data change**, which is why it is here and not done. The alternative — permanent code teaching the resolver to adopt a row shape that can never occur again — is the worse answer and is not recommended. **REFINED 2026-09-02, ids confirmed against the live database (BI_ENGINE.md §21).** Rows 3 and 4 are more decisively false than first reported: their summaries describe a DIFFERENT BUSINESS — the SEO one says "a rust-removal brand" and the hero one names "IronClean", while cubit-coil sells hand-wound copper tensor rings. Row 6 (socks-galore) needed one question answered and now needs exactly one decision: **is socks-galore a performance sock brand or a cozy one?** The observation is accurate either way — the brand story the owner wrote says "performance fibers... engineered", and the hero says "Socks made for staying in" — so the hero really does omit a USP the identity really does claim. But all four products are cozy-framed, and two EXECUTED approvals from 28 July already carry `brand_copy_catalog_mismatch`. If performance, the observation stays ACTIVE and the pending `update_hero` (`cms66nn9g000504kvk28o4dwu`) is its answer; if cozy, the brand story is what is stale, the observation is false, and that proposal should be rejected rather than approved. The store is `published: false`, so nothing is reaching a customer while this waits. Row 5 stays ACTIVE and untouched — it is still true. |
| **E24** | **CORRECTED 2026-09-02 — my first version of this entry was wrong, and the correction matters because it changes what is safe to do.** I reported that two EXECUTED `update_brand_logo` approvals held a corrupted `previousValues` of `{ imageUrl: "" }` and that reverting either would blank a real logo. **Neither claim survives checking.** `update_brand_logo` is not in `ProposedActionSchema`, so the recommendation path cannot propose it at all; both rows carry `proposeBrandLogo.ts`'s exact summary literal ("A logo for your business"), and that path sets `previousValues: { imageUrl: store.logoUrl ?? "" }` by reading the live store. **`""` was the truth** — those businesses had no logo before their first one, and reverting correctly restores no-logo. **The real footprint, measured by `cognitiveOutputId`**: of 33 approvals across the seven affected action types, **exactly 4 came from the review path**, all `update_store_identity`, and **all four are PENDING — none is EXECUTED**. Since `revertApprovalRequest` only ever operates on EXECUTED rows, **there is no corrupted row anywhere in production that revert can reach**. Three of the four (`new-store`, `new-store-1`, `new-store-2`) are businesses still literally named "New store" with null tagline and description, so the recorded `""` is wrong but inconsequential. **One is real**: `paypal-test-books` recorded three empty strings while the business now reads "PayPal Test Books" / "Bookkeeping that finally makes sense". | **Nothing needs to be done urgently, and nothing has been touched.** E22's drift check already refuses all four, which is the safe outcome; they are simply unapprovable until re-proposed, and the next review will propose correctly now that `buildActionContext` is the single builder. **What is required from you** is only a preference: leave them to be superseded naturally (my recommendation — it costs nothing and records nothing untrue), or retire the four so they are re-proposed from scratch. Do **not** rewrite their `previousValues` from today's live values: that would make the record look correct while making it less true. **A separate finding, and this one is a real gap**: `revertApprovalRequest` applies `previousValues` through `execute()` with **no drift check at all**. Reverting `cubit-coil`'s 17 August logo approval today would set the logo to empty — a correct undo of *that* approval, but it would discard a *different, later* logo the business has since adopted (live `logoUrl` is a different blob than that approval's input). Whether undo should be blocked by later changes is a product question, not the same rule Sean approved for approvals, so it is **recorded here rather than implemented**. |

## Needs a migration and a decision about existing data

| # | Item | Exact behaviour today | What a safe migration requires |
|---|---|---|---|
| **E11** | **Email is unique but not normalised.** | `User.email` is `@unique`, and nothing lowercases it on either side. Registration stores the address exactly as typed; `auth.ts` looks a user up with `findUnique({ where: { email } })` using the credential exactly as typed. So `Sean@example.com` and `sean@example.com` are two separate accounts, each of which can only be signed into with the capitalisation its owner originally used. Nobody is locked out today — the two sides agree, because neither normalises. | Three steps, in this order, and the middle one is a product decision rather than an engineering task. **(1) Measure**: count existing rows that collide case-insensitively, which is a read-only query and can be run at any time. **(2) Decide** what happens to each collision — merge two accounts and their stores, orders and Growth Points; keep the older and disable the newer; or contact both owners. There is no safe default, which is why this is not being chosen here. **(3) Migrate**: normalise on write and on lookup **in the same deploy**, backfill existing rows, and add a case-insensitive unique index. Doing the write side alone locks out every existing mixed-case user, which is exactly what a first attempt at this during Item 3 would have done and why it was reverted before it shipped. |

| ~~**E20**~~ | **RESOLVED 2026-09-01, by Sean against his real connected account.** The merchant financials layer and screen were provider-double proven and live-Stripe unproven; he opened Money on production, confirmed the figures are correct, and used Manage in Stripe to reach the real account. | What the double could never show — that a live Standard Connect account returns these shapes — is now observed rather than believed. The mapping, masking, tenant scoping and the payment-versus-payout distinction were already proven; this closes the half that needed his account. Nothing in the layer writes to Stripe, and that has not changed. |

## Genuinely unprovable locally, whatever we build

Recorded so nobody spends a day trying. These are not decisions and not work —
they are facts about what a laptop can observe.

| # | Item | Why no harness closes it |
|---|---|---|
| **E21** | **No provider outage has ever been observed.** The money path's failure behaviour is proven against INJECTED failures: a refused call, a thrown call, an abandoned claim, an unrecordable delivery. Every one was induced by the suite. | Nothing here should be read as evidence that a real Stripe incident, a real database outage or a real blob outage behaves this way — only that Genesis behaves correctly when told a dependency has failed, which is the half that is ours. Closing it means observing a real incident, which is not work anybody can schedule. Listed so nobody mistakes injected for observed. |
| **E13** | **No real provider has ever signed a request.** | Every signature in every suite is generated locally with a secret we chose. `verify-order-webhook-live` signs with Stripe's own SDK, which is stronger than a hand-rolled HMAC and still proves only that our code agrees with our own signing. Closing it needs a live account sending a live event — which is Connections. |
| **E14** | **PayPal's webhook verification has never run.** | It is a live API call against a transmission id, a certificate URL and a merchant's credentials. The handler it guards is now well covered; the verification in front of it cannot be exercised at all without PayPal. |
| **E15** | **No server action has been invoked over HTTP.** | An action is addressed by a build-specific id in a `Next-Action` header. Reconstructing it would couple a suite to a private Next detail that changes between versions, so a test built on it fails on an upgrade for no reason. The guards are proven at the function layer and the pages over HTTP. **Not external, and not work** — listed because it is the one boundary no lane reaches, and the honest answer is that it should stay unreached. |

---

## E19 — the receipts, audited end to end (2026-09-02)

**Nothing has been sent and Resend has not been enabled.** This is the audit
Sean asked for, the smallest safe fix (built, inert), and the plan.

### Why the sweep returns before creating any Job row

`runDueOrderNotifications` checks `isEmailConfigured()` as its very first
statement, before it reads a single order (`lib/orders/notificationSweep.ts`).
With no `RESEND_API_KEY` it returns `skipped: true` immediately. That is
deliberate and its comment says why: every individual notification checks
too, so without one decision up front a platform with no email produces one
report per unsent order per day, which is how a real signal gets buried.

### What actually prevents enqueueing

Only that check. There is no queue fault, no failed job, no exhausted key.
Confirmed against the live database: **`OutboundOperation` holds zero rows
for any `order-notification:` key**, and the only `Job` rows that have ever
existed are `telemetry.prune`, `retention.sweep` and `security.prune`.
Nothing has ever been claimed, so nothing is spent — the earlier note in this
file saying otherwise was wrong and is corrected above.

### Historical only, or future too?

**Both.** The inline path — the one that would send a receipt at the moment
of purchase — makes the same check first: `sendOrderConfirmation` returns
`email_not_configured` before it claims anything, precisely so an order is
never marked confirmed on a platform that cannot send. A purchase made right
now gets no receipt either. This is not a backlog problem with a healthy
present; nothing has ever worked, on either rail (both live rails are Stripe
— `stripeEvent.ts` and the PayPal return route both call it inline).

### Exactly what Resend configuration is required

Two variables, and `isEmailConfigured()` requires both:

- `RESEND_API_KEY` — the API key.
- `EMAIL_FROM_ADDRESS` — the single Genesis-controlled sending address. Store
  names appear as the display name in front of it (`displayNameFor`), so no
  per-store domain and no per-store DNS is needed.

Plus a verified sending domain in Resend for whatever `EMAIL_FROM_ADDRESS`
uses — ideally a dedicated subdomain, so a marketing send can never damage
transactional deliverability.

### How mass retroactive sending is prevented

This was the real danger and it was one variable away. `orders.notifications`
is **live and healthy right now** — it ran three times on 2026-09-02 and
succeeded in five milliseconds each time, by doing nothing — with `BATCH = 50`
and no upper bound on an order's age. Setting `RESEND_API_KEY` alone would
have made the next tick enqueue all seven orders at once, some six weeks old.

The fix is a **second, independent switch**: `EMAIL_NOTIFICATIONS_START_AT`,
an ISO timestamp. The sweep only considers orders at or after it, and with the
variable unset or unparseable it reaches back for **nothing at all** —
fail-closed in both directions, so a typo cannot silently become 1970. Turning
email on and authorising the backstop to reach backwards are now two separate
decisions and neither can be made by accident while making the other. The
inline path is untouched.

Also shipped, because Sean required it before go-live (E19a): `sendEmail` now
refuses RFC 2606 reserved addresses (`.test`, `.example`, `.invalid`,
`.localhost`) before the provider is even constructed, and **throws rather
than falsely claiming the order was confirmed**. Four of the seven orders are
`@example.test` and would otherwise have been guaranteed hard bounces in a
new domain's first batch.

### The three real customers

Not two — the earlier count in this file was wrong. Seven paid orders, all
Stripe, none notified. Four are `@example.test` beta rows. **Three are real
people**, all on `cubit-coil`:

| Placed | Amount | Buyer |
|---|---|---|
| 19 July | $29.99 | a real gmail address |
| 30 August | $69.80 | a real company address |
| 31 August | $47.83 | a real gmail address |

$147.62 between them, and the oldest has been waiting six weeks. The store
owner for all three is Sean, so the three merchant notices would come to him.

### How those three are delivered safely

`scripts/send-missed-receipt.ts`, written and **not run**. One order id per
invocation — no `--all`, no date range, because a bulk mode is precisely what
the horizon was added to remove. Dry run unless given `--send`, printing the
recipient, subject and what the platform currently believes about that order.
It goes through the real `sendOrderConfirmation`, so the claim column, the
`runOnce` ledger, tenant scoping and the reserved-address refusal are exactly
what a live order gets, and an already-confirmed order comes back
`already_sent` rather than sending twice.

**What is required from Sean**: approval of the sending plan itself, and
specifically whether a six-week-late receipt should acknowledge the delay. The
current template does not — it reads as an ordinary confirmation, which for
the 19 July order will arrive as a surprise. That is a wording decision, not
an engineering one, and it is the last thing standing between these three
people and their receipts.

### How future purchases are guaranteed a receipt

Two independent mechanisms, unchanged by any of this:

1. **Inline, at purchase.** Both live rails call `sendOrderConfirmation` the
   moment the order commits — the Stripe handler inside `after()` (strictly
   after the transaction, so a rolled-back order can never be confirmed), and
   the PayPal return route.
2. **The backstop, every 15 minutes.** `orders.notifications` finds paid
   orders older than a ten-minute grace with no confirmation claim and
   enqueues them onto the durable queue, which owns retries. This is the
   mechanism that catches the PayPal redirect nobody redelivers.

Both are idempotent through `runOnce` and the claim columns, so the two
cannot double-send. The horizon narrows only what the *backstop* may reach
backwards to; anything placed after it is fully covered by both.

### Deployment and verification plan

1. **Deploy the code first, with nothing configured.** The horizon and the
   reserved-address guard are inert while `RESEND_API_KEY` is unset — the
   sweep already sends nothing. This can ship today and change no behaviour,
   which is the point of doing it before the credential exists.
2. **Verify inertness in production**: `orders.notifications` keeps
   succeeding, `Job` still holds no notification rows, all seven orders still
   have null claims.
3. **When Resend is ready**, set `RESEND_API_KEY` and `EMAIL_FROM_ADDRESS`
   and **leave `EMAIL_NOTIFICATIONS_START_AT` unset**. Nothing retroactive
   can happen. Verify: the sweep now reports `skipReason: "no_horizon"`
   rather than `email_not_configured`.
4. **Prove the live path on a real purchase** — one test order on a real
   address — before anything historical is touched. That is the check that
   matters, because it is the one that protects every future customer.
5. **Then set `EMAIL_NOTIFICATIONS_START_AT`** to the moment of step 3, so
   the backstop covers everything from go-live forward and nothing before it.
6. **Then, and separately, the three historical receipts** — one
   `send-missed-receipt.ts` invocation each, dry run first, after Sean has
   approved the wording.

Steps 3 to 6 are all gated on Sean. Steps 1 and 2 are not.

## Blocked by Connections (recorded here, out of scope by instruction)

Social publishing and its OAuth apps; the eleven connector webhooks; any proof a
real provider signature verifies; the Printful live economics check; EasyPost
account verification and live labels. All are named in
`BACKEND_FOUNDATION_GAPS.md` and `PRE_CONNECTIONS_CHECKLIST.md`; none is worked
on during the locked sequence.
