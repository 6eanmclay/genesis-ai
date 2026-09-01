# The master list, mapped against what exists

**Assessed 2026-08-30 against `292c5b0`.** Forty-seven items, checked against the
repository rather than against memory — because item 42 of the list is "don't
rebuild things that already exist", and this session has already found that
warning to be well earned four separate times.

Four verdicts, and the split is the point:

| | Count | Meaning |
|---|---|---|
| **Already built** | 9 | Exists now. Rebuilding it would be the mistake item 42 names. |
| **Buildable in this window** | 11 | No Connections, no credential, no paid infrastructure, no open product decision. |
| **Blocked by Connections** | 18 | Needs a provider account, an OAuth registration, or an API we cannot call. |
| **Needs a decision or is a large feature** | 9 | Real work, but it needs scoping or a decision from Sean first. |

---

## Already built — do not rebuild

| # | Item | Where it lives |
|---|---|---|
| **30** | J4 cannot bypass Genesis's controls | Every guard runs outside the model. `lib/permissions.ts`, `lib/execution/` verification, `runOnce`, the boundary guard. J4 proposes; deterministic code authorizes and executes. |
| **31** | Independent cybersecurity layer, infrastructure first | `lib/security/signals.ts` is a separate stream from `SecurityEvent`, written by deterministic infrastructure and read by nothing that reasons. Retention, a filtered read layer and `/admin/security` shipped this session. **No model chosen, deliberately.** |
| **33** | Security/telemetry correlation | `lib/observability/correlation.ts` puts one id on six tables; `lib/admin/trace.ts` assembles them; `/admin/operations` renders it. |
| **44** | J4 is not the authority over money | Already structural. The dispute handler, `runOnce`, the Growth Point ledger and every payment path are deterministic code J4 cannot reach. |
| **45** | External AI is not a single point of failure | Partly. `genesisModelFailureMessage` degrades honestly per failure kind and the message is saved rather than lost. See item 28 below for what is *not* proven. |
| **19** | Order detail page | `app/dashboard/orders/OrderDetail.tsx`, 339 lines, reached from `/b/[slug]/orders/[orderId]`. Customer, items, payment, shipping, fulfilment all present. |
| **20** | Order timeline | Substantially there — the detail page reads `deliveredAt`, `fulfilledAt`, refund and dispute state. What is missing is presentation, not data. |
| **47** | Reversibility | `lib/execution/executables/orders.ts` already supports marking fulfilled and un-fulfilling, with guards. Disputes, refunds and charge-backs got full lifecycle treatment this session. |
| **27** | Scheduled business analysis | `lib/scheduler/registry.ts` runs `intelligence.cycles` and `ops.alerts`; `lib/intelligence/` detects change and notifies. |

---

## Buildable now — no Connections, no credential, no decision

Ordered by value. Items already in the locked sequence are marked.

| # | Item | Note |
|---|---|---|
| **32** | Telemetry audit and instrumentation | **Locked item.** 11 subsystems declared, 5 instrumented; 3 declared events never emitted. Known and measured. |
| **21, 22, 23** | Safer fulfilment controls, reversible fulfilment, clearer order state | Pure owner-facing work over data that already exists. Folds naturally into locked item 5 (owner-facing failure recovery). |
| **18** | Clickable order details from Commerce | The detail page exists; the list does not link to it consistently. Small. |
| **28** | Graceful degradation | Partly built and **entirely unproven**. Nothing tests that Genesis keeps serving with the model unavailable, Stripe unreachable, or blob storage down. A failure-injection suite is buildable now and would be genuinely new evidence. |
| **29** | No single intelligence-provider dependency | `lib/genesisModel.ts` is already the one seam. Making the provider swappable behind it is refactoring we control. |
| **11, 14, 15** | Affiliate infrastructure, attribution, commission lifecycle | **Buildable without Connections.** A `Referral` model already exists for Growth Point signups; affiliates are a different, larger model. Needs a product decision on payout mechanics (see below) but the *link → visit → order → commission* chain is ours. |
| **16** | Refund/dispute commission reversal | Depends on 15, and the dispute lifecycle it must hook into shipped this session. |
| **24** | Unified business data layer | `lib/businessModel/` already maps orders, products, customers and transactions into one canonical shape. Extending it is ours. |
| **41** | Owner-friendly explanations | Prompt and presentation work, no external dependency. |
| **43, 46** | Never invent provider capabilities; never confuse analytics with revenue | Not features — **standing rules**. Best enforced as assertions in the suites that would otherwise fabricate, the way `connection-truthfulness` already does. |
| **25** | Revenue attribution | The *direct* and *affiliate* halves are buildable now. The social half is Connections. |

---

## Reassessment, 2026-09-01 — after real orders

The ranking above was written before Genesis had a paying customer. It is kept
for its audit of what was already built, and superseded for priority.

**The finding that outranks every item below**: fifty commits sit ahead of
`master` and none of it is deployed. Every screen this session built — the order
detail that shows what is in the box, the packing slip, search, tracking
correction, the waiting-customer card — is invisible to the merchant it was
built for. No amount of further building changes that.

### Already built. Do not rebuild.

The merchant loop, end to end, except where marked:

| | |
|---|---|
| Customer buys | Stripe and PayPal checkout, bag and single-product |
| Genesis records it | Order + OrderItem, one payment can only ever become one order |
| Merchant knows | waiting-customer attention card, operational-failure cards. **Email built and dark** |
| Merchant fulfils | order detail with every line item, money breakdown, history, packing slip, order search, tracking entry AND correction. **Label purchase needs EasyPost** |
| Customer is told | four notification kinds, claim-based idempotency, durable retry. **All dark without Resend** |
| Merchant tracks what happened | order history, execution log, `financialsForStore()`. **No financials screen** |

Also built and not to be rebuilt: account closure, retention, the job queue,
webhook delivery + replay, security signals, correlation ids, the scheduler
registry, the isolation guard's schema cross-check, and restore verification.

### Still missing, and buildable now

| Rank | Item | Why |
|---|---|---|
| **P0** | **Stripe financials screen** | The data layer is built and proven (`6b318a9`) and nothing renders it. "When do I actually get paid" is a question a real merchant has weekly and Genesis cannot answer on screen. Must use `financialsForStore()` and `FinancialsProvider`. |
| **P1** | **Telemetry gaps (item 32)** | Three declared events have never fired. Small, and an honesty gap in the thing that reports honesty. |
| **P2** | **Business data layer (item 24)** | Real, but its value is mostly to J4, which is deferred. |
| **P2** | **Owner-friendly explanations (item 41)** | Same — improves J4's voice, and J4 is not the constraint today. |
| **P2** | **Provider swappability (item 29)** | Refactoring behind a seam that already works with one provider. Speculative until there is a second. |

### Blocked externally

`EXTERNAL_BLOCKERS.md` is authoritative. The ones that gate merchant-visible
work: **E6** the migration gate (a decision, not work), **E19/E19a** Resend and
the reserved-TLD guard that must ship with it, **E20** live Stripe verification,
**E21** an observed provider outage, **E18** tax. Plus EasyPost for labels and
every social API.

### Premature, deliberately

Affiliates (link → order → commission is buildable; seven orders is not a
traffic problem), social connections and revenue analytics, J4 business
intelligence over commerce data this thin, and Stripe Instant Payouts.

### The philosophy, recorded because it was not written down anywhere

Sean, 2026-09-01: Genesis takes **no percentage** of a merchant's revenue and
**does not sell their data**. Checked before writing this — it appears nowhere
in the repository except as an unrelated note about a measurement model having
no percentage field. It belongs with the frozen principles rather than in a
backlog, and any pricing, affiliate or analytics work has to be read against it.

---

## Queued by Sean, 2026-09-01 — not forgotten, not started

Named explicitly so none of it drifts off the list. Nothing here begins until
the Connections phase is entered deliberately.

| Item | State | Note |
|---|---|---|
| **Merchant Stripe financials/payout UI** | **Required follow-up.** The data layer is built and proven (`6b318a9`). | Must use `financialsForStore()` and the `FinancialsProvider` architecture. Sean: "Do not build it as a parallel Stripe system." |
| **Live Stripe verification** | **E20, outstanding.** | One read against a real connected account. Sean: do not modify the Stripe account or payout settings during development. |
| **EasyPost shipping/label connection** | Connections. | Buying postage inside Genesis. The manual tracking path works today, including correction. |
| **Merchant new-sale email via Resend** | Built, dark. E19. | Backstop, idempotency and the order link all shipped; nothing sends without a provider. |
| **Customer transactional email** | Built, dark. E19. | Confirmation, shipping, delivery, refund. Separate events from the merchant notice. |
| **Reserved-TLD guard** | **E19a — required BEFORE email goes live.** | Four production stores have `@example.test` owners that would hard-bounce on day one. |
| **Affiliates** | Buildable, deliberately deferred. | Link → visit → order → commission is ours; payout mechanics need a decision. Premature at this order volume. |
| **Social connections, revenue and analytics** | Connections. | |
| **J4 business intelligence** | Deferred. | The engine exists; the data is thin. |
| **Checkout / order / fulfilment improvements** | Partly shipped. | Order detail, line items, money breakdown, history and tracking correction are live. Packing slip, order search and bulk fulfilment remain. |

---

## Blocked by Connections

Items **3, 4, 5, 6, 34, 35, 36, 37** (social metrics, cross-platform comparison,
social revenue, total social value, the connection framework itself, social API
connections, richer social integrations, provider capability awareness) and
**8, 9** (Stripe payout management and Instant Payouts — these need a live
connected account and Stripe's payout APIs).

Also **2, 7, 26, 38, 39, 40** in their *full* form: J4 analysing "the entire
business" is only as good as the data connected to it, and today that is the
store's own commerce. The engine exists; the inputs do not.

`EXTERNAL_BLOCKERS.md` remains the authoritative list of what unblocks each.

---

## Needs a decision or scoping first

| # | Item | What is unresolved |
|---|---|---|
| **12, 13** | External and Genesis-user affiliates | Whether an affiliate needs an account, what identity they get, and how they are paid. Payout mechanics are a money decision, not an engineering one. |
| **17** | Affiliate performance intelligence | Depends on 11–16 existing first. |
| **10** | Unified financial intelligence | Needs the payout and fee data that only a connected Stripe account provides. |
| **9** | Instant Payouts | Explicitly must use Stripe's own mechanism — correct, and it needs the account. |
| **42** | Don't rebuild what exists | **Not a task.** It is a working practice, and the audit at the top of this document is what honouring it looks like. |

---

## What this changes about the locked order

Nothing is removed. Three master-list items fold into work already sequenced:

- **21, 22, 23, 18** join **locked item 5** (owner-facing failure recovery) —
  same surface, same data, same session.
- **32** *is* **locked item 6**.
- **28** (graceful degradation, unproven) is a genuinely new candidate and the
  strongest addition the master list makes: it is buildable now, needs nothing
  external, and would prove a property the whole architecture claims.

The affiliate cluster (11, 14, 15, 16) is the largest buildable-now item on the
list and the one that most deserves its own sequenced slot — after the current
locked items, and after a short decision on payout mechanics.
