# The Connections milestone — evidence before scope

**Investigation only, 2026-08-25. Production baseline `6650011`. No production
code changed.** Every claim names its evidence. Nothing here is proposed from
the roadmap.

Stop for approval before implementation.

---

## 1. The finding that should decide the scope

Read from the production database, read-only:

**BusinessRecords by source**

| Source | Records | |
|---|---|---|
| `genesis_upload` | 164 | first-party |
| `genesis_promotion` | 48 | first-party (yesterday's identity facts) |
| **`quickbooks`** | **41** | 25 document, 16 transaction |
| `genesis_design` | 21 | first-party |
| `genesis_storefront_media` | 18 | first-party |
| `genesis_generated` | 4 | first-party |

**BusinessEvents by source**

| Source | Events |
|---|---|
| **`quickbooks`** | **43** |
| `internal` | 4 |

**QuickBooks is the only connector that has ever produced business data — and it
has been dead since 2026-08-01.** 43 of the platform's 47 business events came
from it. Nothing has arrived from any connector in 24 days.

And the two connectors that *are* alive have produced nothing at all:

| Connector | State | Records ever written |
|---|---|---|
| **Mailchimp** | CONNECTED, synced today, **0 failures** | **0** |
| **Google Calendar** | CONNECTED, 11 failures, dead since 08-06 | **0** |

Mailchimp reports success every single day and has never written a record. That
is either an empty account or a silent no-op, and **nothing in the system can
currently tell those apart** — a successful sync that writes nothing looks
identical to a successful sync that had nothing to write.

---

## 2. What is already built, and works

Not to be rebuilt.

| | Evidence |
|---|---|
| Six real connectors with OAuth, encrypted credentials, signed single-use state | `lib/integrations/`, `COMPLIANCE.md` §2–4 |
| Scheduler with exponential backoff, rate-limit handling, per-store isolation | `lib/intelligence/scheduler.ts` |
| Evidence-grounded connection recommendations — real revenue, real customers, never a category match alone | `lib/integrations/gaps.ts` (Ch.4 M1) |
| Connection gaps that J4 *speaks* rather than lists | `a21130b` |
| Honest staleness on connector-derived summaries | `df23719`, `176da57`, `9bcdada` |
| **A dead connection now asks to be reconnected** | `6650011`, deployed today |
| Change detection → insights → the intelligence cycle | `lib/intelligence/changeDetection.ts` |

---

## 3. What is blocked, and cannot be unblocked by engineering

| | Blocked by |
|---|---|
| Mailchimp / Facebook / Instagram / TikTok — new connections | client credentials absent (U5) |
| QuickBooks — the only productive connector | owner re-consent (U2) |
| Google Calendar | OAuth app unpublished (U3) |
| Toast POS, Square, Calendly, Xero, HubSpot, Twilio | `connector: null` — never built; Square additionally needs credentials |

**6 of 12 catalog entries have no implementation. Of the 6 that do, 4 cannot be
newly connected and 1 is dead.** Any milestone whose value depends on connecting
a new provider cannot proceed.

---

## 4. Where the product contradicts its own vision

`VISION.md` Chapter 4 is explicit:

> *"Never presented as raw settings to configure — J4 recommends each connection
> as a real, earned capability unlock, grounded in the business's own real
> state… never a generic settings-page checklist."*

`app/dashboard/connections/page.tsx` renders a "Recommended for your business"
section — which *is* the earned-unlock idea, and it works — and then, below it,
**every one of the 12 catalog entries grouped under all 7 category headings**,
including the 6 that cannot be connected at all.

So the screen is the earned unlock *and* the generic checklist, stacked. The
checklist half is the larger half.

---

## 5. Three candidate scopes

### A — Connection truthfulness *(recommended)*

Make the system honest about connections it already has, since that is the part
not blocked by anything.

- **A sync that writes nothing says so.** Mailchimp's daily success is currently
  indistinguishable from a sync that found data. Record what a sync actually
  wrote, so "connected and producing nothing" becomes a visible state rather
  than an assumption.
- **The catalog stops advertising what cannot be connected.** Six entries with
  no implementation are rendered as cards today.
- **Connection value is stated in business terms** — what a connection has
  actually contributed, not that it is connected.

*Unblocked by anything. Directly serves VISION Chapter 4. Builds on `gaps.ts`
and the health work deployed today rather than beside it.*

### B — Recover the one connector that works

Make QuickBooks reconnection a guided path rather than a warning, and make the
41 records and 43 events it produced visible as what was lost.

*Partially blocked: the reconnection itself is U2 and only Sean can do it. The
guided path can be built; it cannot be proved end to end.*

### C — Build a new connector

Square, Xero, HubSpot, Calendly.

*Blocked by credentials for every candidate. Also contradicts your standing
instruction not to expand the connector catalog, and `VISION.md` line 76 puts
additional integrations in P2, off the critical path.*

---

## 6. Open decisions for Sean

**C1 — Which scope?** Recommendation: **A**. It is the only one that can be
finished and proved with what exists today, and it is what Chapter 4 actually
asks for. B is worth doing but cannot be completed without you. C is blocked and
out of scope by your own instruction.

**C2 — Does the catalog keep its unbuildable entries?** Six entries render as
cards for providers with no implementation. Options: remove them; keep them
behind an explicit "not available yet" that the recommendation engine never
surfaces; or keep as-is. This is a product call, not a cleanup.

**C3 — Is "connected but producing nothing" a finding J4 should raise?** A
connection that has succeeded daily for weeks and written nothing may be an
empty account, which is fine and not worth mentioning — or a connector that
silently does nothing, which is not. Whether J4 says something, and after how
long, is a judgment about interrupting an owner.

**No production code changes until these are answered.**

---

## 7. Decisions taken — 2026-08-25

**C1 — Scope A: connection truthfulness.** The Connections foundation must be
truthful before more providers are added. The smallest production-safe scope:

1. A connection is never represented as healthy when it is stale, dead, or
   unable to sync.
2. Four states are distinguishable where the evidence supports them:
   **Connected**, **Needs reconnection**, **Failed**, and **Connected — no data
   received**.
3. Provider error messages are preserved verbatim, and status is stated in terms
   an owner can act on.
4. A successful sync or a data state is never invented where the provider
   produced nothing.

**C2 — Keep the whole catalog.** A future provider is not removed because its
credentials or implementation are missing. It is marked honestly as *coming
later* or *unavailable* instead of being presented as currently connectable.

**C3 — "Producing nothing" is not "broken".** If authentication is valid and the
provider returns zero business data, that is represented honestly as **Connected
— no data received**, and it does **not** raise a health warning. Escalation to
*needs reconnection* happens only when the evidence shows an actual failure or
staleness.

**Out of scope, explicitly:** new provider implementations, social connections,
and anything in business intelligence. No identity data is touched.

### The shape this takes

One function, `connectionHealthOf`, is the single definition of what a
connection's state is. Both the Connections screen and the attention path read
it, so what the owner is shown and what J4 raises cannot disagree — the same
"one definition, two callers" rule `needsDatabase` and `hasWorkingPaymentMethod`
already follow in this repository.

Precedence, highest first, because more than one can be true at once:

| | Condition | Raises attention |
|---|---|---|
| `unavailable` | no implementation, or OAuth credentials absent | no |
| `not_connected` | no row, or DISCONNECTED | no |
| `failed` | verification failed — the provider said why | **yes** |
| `needs_reconnection` | 3+ consecutive sync failures | **yes** |
| `connected_no_data` | healthy, and has never written a record | **no (C3)** |
| `connected` | healthy, and has produced data | no |



---

## 8. As built — 2026-08-25

**Not deployed.** Committed and verified locally; production remains `6650011`.

### One definition, two consumers

`lib/integrations/connectionHealth.ts` is now the single answer to "what is this
connection". The Connections screen and the attention path both read it, so what
the owner is shown and what J4 raises cannot disagree.

Before this there were two definitions and they said different things about the
same row. The screen asked `status !== "DISCONNECTED"` — so a **FAILED
connection rendered as a working one**, with Recheck and Sync buttons and no
indication anything was wrong. The attention path asked
`status in (FAILED, NEEDS_ATTENTION)` and never looked at the scheduler's
counter, which is how QuickBooks stayed silent for 24 days.

Both were reading one column that answers a narrower question than either was
asking. `status` is the last *verification*, re-run only when somebody presses
Recheck. `syncFailureCount` is the *scheduler's* counter, reset by any success.
Neither alone is "is this working".

### What each state means

| State | Condition | Raises attention |
|---|---|---|
| `unavailable` | no implementation, or OAuth credentials absent | no |
| `not_connected` | no row, or DISCONNECTED | no |
| `failed` | verification failed — provider's message kept verbatim | **yes** |
| `needs_reconnection` | 3+ consecutive sync failures | **yes** |
| `connected_no_data` | healthy, has never written a record | **no (C3)** |
| `connected` | healthy, and counts what arrived | no |

Precedence is ordered because more than one can be true at once, and the most
actionable thing wins: a failed verification outranks a failing sync, which
outranks having produced nothing.

### Availability is declared by the connector

`IntegrationConnector.configured?()` — optional, implemented by the five OAuth
connectors that read platform credentials from the environment. **Declared by the
connector, not by a list somewhere else**, because the connector is what reads
those variables and is the only thing that cannot fall out of step with itself.

This is what stops Facebook, Instagram and TikTok offering a Connect button that
could only ever throw. They stay in the catalog (**C2**) and read *Coming later*.
Mailchimp is unaffected: its catalog entry is `api_key`, and that path works
without platform credentials — which is exactly the case `COMPLIANCE.md` said
would keep working.

### C3, held

`connected_no_data` **does not raise**. An account with no campaigns is an
ordinary thing to have, and telling an owner their connection is broken because
their Mailchimp is empty would be wrong. What changed is only that the two cases
stopped looking identical: Mailchimp has synced successfully every day with zero
failures and has never written a record, and until now that was indistinguishable
from a connection returning real data.

### Two suites became one

`verify-connection-health.ts` was written yesterday against the interim rule that
lived inside `getIntegrationIssues`. That rule now lives in `connectionHealthOf`,
so the suite was testing an implementation that no longer exists separately. Its
one unique assertion — the `BusinessContext` staleness gate — moved into
`verify-connection-truthfulness.ts` and the file was deleted.

That was not tidiness. Running both exhausted the harness's single PGlite
connection and deterministically broke the two suites that ran after them
(`two-factor`, `update-product-image`) — reproduced twice, and confirmed by
removing the new suite and watching 42/42 return. Two descriptions of one thing
cost real coverage, which is the milestone's own subject.

### Gates

`tsc` clean · `next build` compiled · eslint **70 problems (2 errors, 68
warnings) — baseline** · shared runner **42/42** · standalone **66/68** (the two
known baseline failures) · `verify-connection-truthfulness.ts` — **44
assertions, 8 negative controls**, all catching.

`integrationStatus` was removed from `ConnectorCard` rather than left unused: an
unread raw column sitting beside `health` is an invitation to read the field this
milestone exists to stop reading.

### Out of scope, untouched

No new provider implementations. No social connections. No BI or Learn changes.
No identity data. No storefront code.


---

## 9. C1 deployed and verified — 2026-08-25

**Deployed commit `4376b8d`**, from the build log:

    Cloning github.com/6eanmclay/genesis-ai (Branch: master, Commit: 4376b8d)
    91 migrations found in prisma/migrations
    No pending migrations to apply.
    ✓ Compiled successfully in 33.5s

14 files. No `prisma/` changes, no storefront, nothing under `lib/intelligence/`
or `lib/businessModel/`.

### Every production connection, as the deployed code now sees it

| State | Count |
|---|---|
| `connected_no_data` | **9** |
| `failed` | **6** |
| `needs_reconnection` | **2** |

    MAILCHIMP         connected_no_data   Cofoundr            fails=0   recs=0    silent
    PRINTFUL   × 4    connected_no_data                       fails=0   recs=0    silent
    PAYPAL     × 2    connected_no_data                       fails=0   recs=0    silent
    STRIPE            connected_no_data   Cubit & Coil        fails=0   recs=0    silent
    STRIPE     × 6    failed                                  fails=0   recs=0    RAISES
    GOOGLE_CALENDAR   needs_reconnection  Cofoundr            fails=11  recs=0    RAISES
    QUICKBOOKS        needs_reconnection  Cofoundr            fails=14  recs=41   RAISES

**Not one connection is reported as plain `connected`.** Every one is either
failing, stale, or has never returned a record — which was true yesterday too,
and simply could not be seen.

### The six checks

| | Result |
|---|---|
| `connectionHealth` is the single source of truth | **PASS** — the attention path and `connectionHealthOf` agree for all 16 stores, 8 items raised, **0 mismatches**, computed independently and compared |
| Failed/stale no longer present as healthy | **PASS** — all 8 classify as `failed`/`needs_reconnection` and raise |
| `needs_reconnection` at 3+ consecutive failures | **PASS** — GOOGLE_CALENDAR=11, QUICKBOOKS=14; control: 0 connections sit between 1 and 2 |
| `connected_no_data` does not raise | **PASS** — 9 in production, every one silent |
| Unavailable / not-connected accurate | **PASS**, see below |
| No identity / storefront / BI / Learn drift | **PASS** — 48 INFERENCE facts across 12 stores, **0 OWNER**, blueprint intact in 12; cursors 12, outputs 894, beliefs 1 |

### One check that first read FAIL, and why it was my instrument

`configured()` reads environment variables, and the verification script runs on
this machine against `.env.livecheck` — which holds a database URL and nothing
else. So it reported Google Calendar and QuickBooks as *unavailable*, which is
true of this laptop and false of production.

Verified against the production environment directly instead, names only:

| Variable | Production |
|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID` / `_SECRET` | **present** |
| `QUICKBOOKS_CLIENT_ID` / `_SECRET` | **present** |
| `FACEBOOK_*`, `TIKTOK_*`, `MAILCHIMP_*` | **absent** |

So in the deployed runtime Google Calendar and QuickBooks are available, and
Facebook, Instagram and TikTok read *Coming later* — which is the intended
behaviour. Recorded rather than quietly re-run, because a local environment
answering a production question is exactly the shape of a false green.

### C1: CLOSED

Scope A is deployed and verified. C2 and C3 are satisfied by what shipped and
were not extended beyond it: the catalog still holds all 12 providers, and
`connected_no_data` raises nothing.

**Production baseline: `4376b8d`.**


---

## 10. R1 — the state's own action — built 2026-08-25

**Not deployed at time of writing.** Production is `4376b8d`.

### The gap C1 created by being honest

C1 made the system say *"it needs reconnecting"*. The card offered **Recheck,
Sync now, Disconnect** — and nothing that reconnects. The only route back was to
Disconnect first, an action whose own comment two files away says *"disconnecting
the wrong one is not recoverable by the owner"*, and then Connect.

Being told what is wrong and given no way to fix it is its own kind of
dishonesty, and it is the largest gap in Connections that needs no credential.

### What was built

**A Reconnect action, offered exactly where the state asks for it.**
`needsOwnerAction` is true for `needs_reconnection` and `failed`, and for
nothing else — a working connection showing Reconnect would send an owner
through a provider's consent screens for no reason.

It is `connectIntegration` unchanged, **not a second mechanism**. Every OAuth
callback in `lib/integrations/` upserts, so re-consent replaces the stored
credentials in place. That is what reconnection *is*; there was nothing to build
but the way in.

Disconnect stays. Reconnect is a better route back, not the only one.

**And the owner is now sent where the fix actually is.** Every integration issue
linked to `/dashboard/payments`, which is right for the two payment rails and
wrong for everything else — including QuickBooks and Google Calendar, the two
connections that were telling owners to reconnect. They are managed on
`/dashboard/connections`. So the system said "reconnect this" and sent them to a
screen with nothing to click.

`whereToFix` derives the destination from the catalog rather than a second
hand-kept list: a provider is managed on Connections exactly when it has a
catalog entry. Stripe and PayPal are deliberately not in that catalog and keep
their own screen.

### `connectionHealth` untouched

R1 reads the states C1 defined and adds nothing to them. The single source of
truth is unchanged.

### One gap found and recorded, not fixed

**Printful and EasyPost have no dashboard screen that manages them at all.**
Both are connected during onboarding and appear nowhere afterwards, so a failure
in either has no honest destination. `whereToFix` sends them to Connections as
the least-wrong answer, and the comment says so. Inventing a link to a screen
that does not exist would be worse than an imperfect one.

### Gates

`tsc` clean · `next build` compiled · eslint **70 problems — baseline** · shared
runner **42/42** · standalone **66/68** (the two known baseline failures) ·
`verify-connection-truthfulness.ts` — **52 assertions, 14 negative controls**.

One gate of mine was green for the wrong reason and was fixed: checking the
whole file for `connectIntegration.bind` passed with the Reconnect action swapped
out, because the not-connected branch has a Connect button using the same call.
The claim is about that button, so the assertion is now scoped to its block.


---

## 11. R1 verified, and the sweep that followed — 2026-08-25

**R1 deployed: `8057684`.** 91 migrations found, none pending, compiled clean.

### R1 in production

| Check | Result |
|---|---|
| Reconnect offered only for `needs_reconnection` / `failed` | **PASS** — 8 production connections qualify |
| Healthy and `connected_no_data` show none | **PASS** — 9 correctly show none |
| Reuses the existing OAuth flow | **PASS** — `connectIntegration`, scoped to the Reconnect block |
| Disconnect retained | **PASS** |
| Routes to where each provider is managed | **PASS** — `STRIPE → /dashboard/payments`, `GOOGLE_CALENDAR` and `QUICKBOOKS → /dashboard/connections` |

### One alarm of mine that was wrong

I flagged `/dashboard/payments` as carrying C1's old pattern —
`status !== "DISCONNECTED"` — and expected the six FAILED Stripe connections to
render as "✓ Connected" there. **They do not.** That page already routes its
badge through `paymentBadgeFor`, which returns *"Not working"* for FAILED, and it
already has a Reconnect button and the line *"This store can't take payments
through Stripe right now. Reconnect to fix it."* The loose variable only chooses
between the Connect button and the manage cluster, and a broken connection
correctly lands in the cluster that contains Reconnect.

The Payments screen was right before I looked at it. Recorded because I nearly
"fixed" something correct.

### The sweep, and the one real find

Every remaining place deciding connection state was checked. All strict and
correct — `hasWorkingPaymentMethod`, `gaps.ts`, onboarding launch, the storefront
action — except one:

**`OrdersWorkspace.tsx` rendered a FAILED EasyPost connection as "✓ Connected"
and let it buy shipping labels.** `canBuyLabel` was gated on
`status !== "DISCONNECTED"`, so a store whose credentials had stopped verifying
was still offered **Buy label**, and the purchase would fail at the provider.
That is the worst of the three locations, because it gates an action that spends
money.

Now: `uspsWorking` is strict — only a verified-working connection can buy a
label, exactly as `hasWorkingPaymentMethod` is strict about taking money. Broken
is its own state showing *"Not working"* and a line saying labels cannot be
bought until the key is replaced, with the API-key form still on screen —
pasting a current key **is** how an `api_key` connector reconnects, and hiding it
would leave an owner told what is wrong with no way to fix it.

No production store has an EasyPost connection today, so there is no live
impact — the defect was real and is closed before it could bite.

`connectionHealth` untouched throughout.

### Gates

`tsc` clean · `next build` compiled · eslint **70 — baseline** · shared runner
**42/42** · standalone **66/68** · `verify-connection-truthfulness.ts` — **57
assertions, 18 negative controls**.


---

## 12. R2 — a rail is not a data source that has gone quiet

### The change, in full

`ConnectionEvidence` gained one optional field:

```ts
syncs?: boolean;   // defaults to true
```

and one branch became conditional on it. That is the whole change to
`connectionHealth` — 28 lines including comments, no new state, no changed
precedence, no changed attention behaviour.

`IntegrationConnector.sync` was **already optional**, and several connectors
deliberately do not implement it. `stripe.ts` says so outright — *"the absence of
`sync` here is the answer"* — and `printful.ts` likewise. They are payment and
fulfilment rails, not sources of the store's own records, and will never write
one. So the caller asks the connector, and nothing keeps a list.

`syncs` defaults to **true**, so every call site written before R2 means exactly
what it meant before.

### Before and after, on real production rows

**8 of 17 connections were being described falsely** — five Printful, two PayPal,
one Stripe:

    before: Connected — no data received
            "Connected and syncing. This provider has not returned any business data yet."
    after:  Connected
            "Connected. This provider does not send business data to Genesis."

False on both halves: they do not sync, and there is no *yet*.

| State | Before | After |
|---|---|---|
| `connected` | 0 | **8** |
| `connected_no_data` | **9** | **1** |
| `failed` | 6 | 6 |
| `needs_reconnection` | 2 | 2 |

**The one remaining `connected_no_data` is Mailchimp** — the only connector that
genuinely syncs, succeeds daily, and has returned nothing. That is precisely the
case the state was invented for, and it is now the only case wearing it.

*(I had estimated 7. The measured figure is 8 — Printful is connected on five
stores, not four.)*

### C1 preserved, and checked rather than asserted

**Attention-raising: 8 before, 8 after.** No state's `raisesAttention` changed,
precedence is untouched, and Reconnect still appears for exactly
`needs_reconnection` and `failed`. Two negative controls specifically break C1
behaviour — a rail's failed verification, and `connected_no_data` starting to
raise — and both are caught.

### Two defects in my own tests, found by the controls

**A gate that could never fail.** `!/\\d/.test(...)` matches a literal backslash
followed by `d`, not a digit, so "a rail invents no count" was green with the
count restored. Fixed to `/\d/`.

**A suite that crashed instead of failing.** Breaking C1's FAILED branch made
`failedItem[0].severity` throw, which aborted the run — hiding every assertion
after it, including the ones that would have named the regression. With the
accesses optional-chained, the same break now reports **13 failures instead of
8**. Five real failures had been invisible behind the crash. A suite that stops
early looks exactly like one that had nothing more to say.

### One thing removed rather than kept

`syncs` was initially passed by the attention path too. A negative control proved
it could not matter there — `getIntegrationIssues` drops every non-raising state
before it reads a message, and both connected states are silent. It was a
parameter that could never change an outcome, so it is gone, and a gate asserts
it stays gone.

### Gates

`tsc` clean · `next build` compiled · eslint **70 — baseline** · shared runner
**42/42** · standalone **66/68** · `verify-connection-truthfulness.ts` — **81
assertions, 25 negative controls**.


---

## 13. R2 deployed and verified — 2026-08-25

**Deployed commit `e99a2b4`.** 91 migrations found, none pending, compiled clean.

### Production, after

| State | Count |
|---|---|
| `connected` | **8** |
| `connected_no_data` | **1** |
| `failed` | 6 |
| `needs_reconnection` | 2 |

- Every non-syncing connector is plainly **Connected** — none says "no data",
  none claims to be syncing, none says "yet", **none invents a record count**.
- `connected_no_data` is down to **Mailchimp alone** — the one connector that
  genuinely syncs and has returned nothing.

### C1 non-regression

**Attention-raising unchanged at 8.** `failed` still 6, `needs_reconnection`
still 2, and no `connected*` state raises. The 6 failed rails still carry the
provider's own message verbatim.

### One more check of mine that was wrong

"No connected rail invents a record count" first read FAIL — because I applied it
to **all** rails including the six `failed` ones, whose detail is the provider's
own sentence and legitimately contains digits (`acct_1U07coPiGlsEL0FC`). Narrowed
to the claim actually being made: **8 connected rails, 0 inventing a count.**

Third time this session a verification script has answered a slightly different
question than the one asked. Recorded because the pattern is the point.

---

## 14. R3 — as far as it goes without re-consent: COMPLETE

Everything buildable is built, and most of it already was:

| | |
|---|---|
| J4 speaks about it | **since 2026-08-07** — the AI review layer has been saying "your QuickBooks connection is still failing its token refresh (400)" for weeks |
| A deterministic attention card | `6650011` — `getIntegrationIssues` feeds `runDeterministicObservationSweep` → `communicateFinding` → a spoken finding |
| The message names what stopped and when | *"QUICKBOOKS has not synced since 8/1/2026 — 14 attempts have failed. It needs reconnecting."* |
| It routes to the right screen | `8057684` |
| A Reconnect button is there | `8057684` |

**What QuickBooks delivered before it died:** 25 documents, 16 transactions, 43
business events, newest 2026-08-01.

Nothing further can be built. A retired refresh token can only be replaced by
fresh consent, and the owner has now been told, repeatedly, by several
independent paths. **The system has done its part.**
