# Connections — execution plan

**Opened 2026-09-16**, after the pre-Connections checkpoint closed and everything
outside Connections was deployed at `5aee98a`.

Built by tracing the existing code rather than from the wish list: every row below
names what is actually implemented today and the exact external thing it waits on.
Nothing here assumes a credential, fakes a provider response, or calls an
integration verified without evidence.

## The four categories

| category | meaning |
|---|---|
| **ENGINEERING-READY** | can be completed with no credential, account or third-party approval |
| **NEEDS SEAN** | a credential, an account, or a decision only the owner can make |
| **EXTERNALLY BLOCKED** | waits on a third party — app review, account verification, provider support |
| **DEFECTIVE** | implemented and wrong; a defect to fix, not a dependency to wait on |

---

## 1. Connector inventory, as built

Read from `CONNECTOR_CATALOG` and each connector's own declarations — 13 entries,
10 built, 3 placeholders with `connector: null`.

| connector | auth | sync | webhooks | platform credential |
|---|---|---|---|---|
| Google Calendar | oauth | yes | **none** | `GOOGLE_CALENDAR_CLIENT_ID` / `_SECRET` |
| QuickBooks | oauth | yes | **none** | `QUICKBOOKS_CLIENT_ID` / `_SECRET` |
| Mailchimp | oauth | yes | **none** | `MAILCHIMP_CLIENT_ID` / `_SECRET` |
| Facebook | oauth | yes | **none** | `FACEBOOK_CLIENT_ID` / `_SECRET` |
| Instagram | oauth | yes | **none** | shares the Facebook app |
| TikTok | oauth | yes | **none** | `TIKTOK_CLIENT_KEY` / `_SECRET` |
| Twilio | api_key | no | **none** | none — the merchant's own key |
| Printful | oauth | no | **none** | `PRINTFUL_CLIENT_ID` / `_SECRET` |
| Square | oauth | yes | **none** | `SQUARE_CLIENT_ID` / `_SECRET` |
| Xero | oauth | yes | **none** | `XERO_CLIENT_ID` / `_SECRET` |
| *toast-pos, calendly, hubspot* | — | — | — | not implemented, and marked so |

**EasyPost is not in this catalog** and is the one connector that declares
`webhooks` — it is configured platform-wide rather than per store.

---

## 2. Social publishing + OAuth apps → **EXTERNALLY BLOCKED**

`lib/social/publisher.ts` is a built seam with a **deliberately empty registry**.
`publisherFor` returns null for all four platforms and every caller is written for
that answer. Nothing is stubbed and no path pretends a post went anywhere.

Waits on, in order: Sean registering the Meta and TikTok apps → **provider app
review** for publishing permissions → then one publisher per platform.

The standing rule holds and is why this cannot start early: *never fake a
publisher to make the Story offer render.* A publisher written against no account
would be an unverifiable implementation that looks finished.

## 3. Connector webhooks (gap 13) → **EXTERNALLY BLOCKED**, with one ready piece

Ten built connectors declare no webhooks. Their signature schemes cannot be
verified against a live account, and gap 13's own judgement stands: *an
unverifiable implementation is worse than none because it looks finished.*

**The ready piece is gap 17, the connector contract test** — `verify()` must be
proven to fail closed and never let an invalid delivery through, for *every*
connector that declares webhooks rather than for EasyPost alone. That is a test,
not an integration, and needs no credential. It covers one connector today and
governs the next one added.

## 4. Real provider-signature verification → **EXTERNALLY BLOCKED** (E13)

No real provider has ever signed a request to this system. EasyPost's verifier is
implemented and correct by inspection — HMAC over exact bytes, never throwing on a
hostile payload, refusing when the secret is absent — but a real signed delivery
needs a real account.

What *can* be proven without one, and is gap 17's job: that the verifier fails
closed, that the pipeline refuses anything it did not verify, and that a missing
secret refuses rather than accepts.

## 5. Printful live economics → **EXTERNALLY BLOCKED** (D4/E-list)

`scripts/check-printful-economics-live.ts` is the legitimate read-only path and
says so in its own header: a check, not a suite, run by a person, never part of
the regression. It needs `PRINTFUL_CLIENT_ID`/`_SECRET` and a connected account.
Not to be worked around.

## 6. EasyPost verification + live labels → **NEEDS SEAN / EXTERNALLY BLOCKED** (U6)

Account verification is an EasyPost support ticket. The per-store architecture is
finished behind it. Live label purchase stays blocked until the account clears.

---

## 7. Decisions — ANSWERED BY SEAN 2026-09-17

All eight were put to Sean and all eight came back. Seven are "leave it as it
is", which is a decision and is recorded as one: the standing behaviour is now
deliberate rather than merely unreviewed, and none of them may be changed
without him reopening the row.

| # | decision | standing instruction |
|---|---|---|
| **U7** | **REINSTATE the review gate.** "I do not want schema migrations reaching production automatically without a review checkpoint." | **DECIDED — this is now engineering work.** See §10. |
| **U8** | **Do not run a real purchase yet.** Explicitly pending Sean's authorization. | The money path stays unproven against real money, knowingly. Do not run one. |
| **E18** | **Leave tax collection unchanged.** Do not implement Stripe Tax. | Orders keep saying "Not recorded — check Stripe" rather than printing a zero, which remains the honest answer. |
| **E12** | **Leave security-signal pruning in dry-run.** | No evidence is deleted until the real footprint has been reviewed. The handler's dry-run default stands; do not add the `apply` flag. |
| **E12b** | **Leave the retention sweep inert.** | Stored provider delivery bodies are kept. Do not enqueue it with `apply`. |
| **E13b** | **Leave the horizons undecided and inert.** | Explicitly: **do not introduce deletion that could make `OutboundOperation` idempotency keys reusable** — a deleted row makes its key reusable and a replay could genuinely happen twice. |
| **E16** | **Pending.** Sean will not make a legal-retention decision without the appropriate legal basis. | Closure keeps the business's orders, amounts, customer emails and provider ids indefinitely, and that continues. |
| **E17** | **Leave closed-account storefront behaviour unchanged.** | A closed account's stores keep `published: true` and keep taking checkouts. Do not unpublish, transfer, or alter this. |

---

## 8. What is actually engineering-ready

| # | item | state |
|---|---|---|
| **C1** | **Mailchimp offered a Connect button that could only ever throw.** No `configured()`, and the catalog said `api_key` while the connector said `oauth`. | **DONE `4f3fc80`** — and the assertion that should have caught it was a hardcoded list that omitted Mailchimp; it is now a derived rule plus a catalog/connector agreement sweep. |
| **C2** | **Gap 17 — the connector webhook contract test.** Every connector declaring `webhooks` must fail closed. | **DONE `4b78bb7`** — sweeps the registry via a new `allConnectors()`, 73 assertions. The first version was **vacuous** and only sabotage found it: with no secret configured, `verify()` refused before reaching the signature, so a verifier broken to accept unsigned deliveries passed the suite green. It now runs with a secret generated in-process. |
| **C3** | **`configured()` must be TRUE, not merely declared.** | **DONE `30fafa8`** — every declaring connector proven both ways against the real environment, and the configured / not_connected / connected states held apart. |

Everything else in Connections waits on a credential, an account, an app review,
or a decision above.

---

## 9. The engineering-ready list is now empty

C1, C2 and C3 are shipped. Nothing further in Connections can be completed
without one of:

### Corrected 2026-09-17 by the closure audit

The first version of this table was **wrong on three rows**. It listed Google
Calendar, QuickBooks and Printful as waiting on credentials. Production already
holds all six of those variables — checked by listing production's variable
NAMES, and confirmed against the live `StoreIntegration` rows. Their blockers
are real but are something else entirely, and calling them "needs a credential"
would have had Sean go looking for something he had already supplied.

**Production holds:** `GOOGLE_CALENDAR_*`, `QUICKBOOKS_*`, `PRINTFUL_*`,
`STRIPE_*`, `ELEVENLABS_*`, `ANTHROPIC_API_KEY`, `INTEGRATION_ENCRYPTION_KEY`.

**Production does NOT hold:** `MAILCHIMP_*`, `FACEBOOK_*`, `TIKTOK_*`,
`SQUARE_*`, `XERO_*`, `ALIEXPRESS_*`, `EASYPOST_*`, `RESEND_API_KEY` /
`EMAIL_FROM_ADDRESS`.

**Live connection state, 18 `StoreIntegration` rows:**

| provider | state |
|---|---|
| PRINTFUL | **6 CONNECTED, all synced today, 0 failures** |
| MAILCHIMP | 1 CONNECTED, synced today, 0 failures — on the **legacy pasted key**, which is why it works without `MAILCHIMP_*` |
| PAYPAL | 2 CONNECTED, synced today |
| STRIPE | 1 CONNECTED; **6 FAILED** on testmode/live key mismatch (**U4**) |
| GOOGLE_CALENDAR | 1 CONNECTED but **23 consecutive failures**, last synced 2026-08-06 |
| QUICKBOOKS | 1 CONNECTED but **26 consecutive failures**, last synced 2026-08-01 |
| SQUARE, XERO, FACEBOOK, INSTAGRAM, TIKTOK, TWILIO, ALIEXPRESS, EASYPOST | **no rows at all** |

### What each remaining item actually waits on

| # | what is needed | category | unblocks |
|---|---|---|---|
| 1 | **Meta app registration → Meta app review** | provider action | `FACEBOOK_CLIENT_ID`/`_SECRET` become obtainable; Facebook + Instagram connect; then a publisher |
| 2 | **TikTok app registration → TikTok app review** | provider action | `TIKTOK_CLIENT_KEY`/`_SECRET`; TikTok connect; then a publisher |
| 3 | **Publish the Google Cloud OAuth consent screen** (**U3**) | provider action | stops Google expiring every refresh token after 7 days. **Credentials are already set** — this is why Google Calendar has failed 23 times since 2026-08-06 |
| 4 | **Re-authorize QuickBooks** (**U2**) | account action | a retired refresh token can only be replaced by fresh consent. **Credentials are already set** — 26 failures since 2026-08-01 |
| 5 | **Reconnect six stores' Stripe** (**U4**) | account action | the six FAILED rows; `lastError` names the exact account each time |
| 6 | **EasyPost account verification** (**U6**) → then `EASYPOST_API_KEY`, `EASYPOST_WEBHOOK_SECRET` | provider action, then credential | live labels, and the **first real provider signature this system has ever seen** (**E13**) |
| 7 | `MAILCHIMP_CLIENT_ID` / `_SECRET` | credential | **NEW** Mailchimp connections only. The existing one is healthy on a legacy key and is unaffected |
| 8 | `SQUARE_CLIENT_ID` / `_SECRET` | credential | Square |
| 9 | `XERO_CLIENT_ID` / `_SECRET` | credential | Xero |
**AliExpress is NOT on this list** (Sean, 2026-09-17): "not a provider we are
pursuing. Do not ask me for its credentials or count it as unfinished work." The
connector stays built and registered — it is not deleted, and
`verify-configured-truthfulness` still proves its `configured()` honest — but it
is not unfinished work and its credentials are not wanted.

---

## 8a. Traffic intelligence is NOT a Connection (Sean, 2026-09-17)

**The distinction this plan has to hold:**

| capability | needs a provider connection? |
|---|---|
| publishing a post; reading a provider's own API data (followers, reach, invoices) | **yes** — that is the provider's data and only the provider has it |
| **observing traffic arriving at the merchant's own website** | **no** — that is the merchant's own site telemetry, and Genesis serves the site |

Genesis can know where visitors came from because the storefront is ours. A
connected Facebook account is required to read Facebook's insights; it is *not*
required to record that a visitor arrived from `facebook.com`. Nothing in this
section may acquire a provider dependency.

### What is already captured — traced 2026-09-17, nothing to add

`StoreVisit` has recorded every storefront arrival since `759459b`
(2026-09-01). Against Sean's list:

| asked for | captured | read today |
|---|---|---|
| source / referrer | `StoreVisit.source` — host, never a full URL | yes |
| tracked link / campaign | `StoreVisit.campaign`, `Order.attributionCampaign` | **no** |
| landing page | `StoreVisit.landingPath` | **no — captured on all 933 visits and read by nothing** |
| timestamp | `firstSeenAt` / `lastSeenAt` | window only |
| visits / clicks | one row per visit, idempotent per `visitToken` | yes |
| conversion / order relationship | `Order.attributionKind/Source/Campaign/Evidence/VisitId` — frozen at purchase | counted, never followed |
| direct / unknown | `attributionKind` + `evidence` (why it was attributed) | yes |

**Production, read-only 2026-09-17: 933 visits across 8 stores** —
`direct_unknown` 582, `observed_referral` 308, `explicit_tracking` 43; 216
visits recorded products viewed; **17 orders, 10 of them attributed and all 10
carrying `attributionVisitId`**, so the visit→order join is real and populated;
`campaign` is set on 1 visit.

**Nothing needs to be collected. The pipeline is richer than the request.**

### The actual gap: J4 does not know any of it

`BusinessUnderstanding` contains no traffic at all, so J4 cannot answer a
question about it. Worse, `lib/businessModel/businessMap.ts` still states there
is *"no traffic attribution anywhere in the schema"* — true when written, false
since `759459b`, and it is the sentence that justifies not drawing the
`Traffic` node.

An owner surface does exist (`/dashboard/marketing`, via
`lib/dashboard/visitorSources.ts`), and it carries four hard-won truthfulness
rules that any new work must inherit rather than re-decide: orders are counted
by `attributionKind` and never by `attributionSource`; `StoreVisit` is the
source of truth and never the empty `StoreTrafficDay` rollup; a host is shown as
the host it is (`m.facebook.com` stays separate from `facebook.com`); and the
dominant kind leads because it is dominant, so `direct_unknown` is never tucked
out of sight.

### Proposed — smallest real-data implementation, NOT YET BUILT

1. **Give J4 the traffic it can already see.** One read into
   `BusinessUnderstanding`, sourced from the existing `getVisitorSources`. No
   new table, no new collection, no provider. This is the whole of Sean's ask.
2. **Surface `landingPath`.** Captured on every visit and never read; it is the
   only field that answers "what happened afterward" from data we hold.
3. **Correct the stale `businessMap.ts` sentence**, and *separately* decide
   whether the `Traffic` node is now drawable — the data supports it, but
   drawing it is a product decision about the map, not a consequence of this.

**Deliberately excluded, inheriting the existing doctrine:** no conversion rate
(visits and attributed orders are differently scoped populations, so a ratio is
arithmetic rather than a fact), no "top channel" ranking, no campaign section
that implies campaigns exist when one visit carries one, and no host collapsing.

---

## 9a. Zendrop and Spocket — wanted, and traced before assuming

Sean, 2026-09-17: these are the two sourcing/fulfilment connections actually
wanted. Neither exists in this repository — no connector, no catalog entry, no
reference anywhere. **Neither is built, and neither may be built yet**, because
"do not build them if external/provider requirements are not established" and
for one of them they are not.

### Zendrop — partially established

What the provider's own developer documentation states today:

| | |
|---|---|
| surface | an **MCP server**, described as "a secure API layer that enables AI assistants to interact with your Zendrop store". **Not** a conventional merchant REST API — that distinction matters before anyone designs against it |
| auth | **OAuth 2.0, Authorization Code with PKCE** ("recommended for apps"), or scoped **access tokens** |
| scopes | `catalog:read`, `orders:read`, `orders:write`, `stores:read`, `stores:write`, `my_products:write`, `billing:read` |
| capabilities | product discovery, order management (counts, statuses, issues), store/fulfilment settings, inventory and listings |
| rate limits | 120 reads/min, 30 writes/min, 10 fulfilment actions/min |
| webhooks | **not mentioned in the documentation.** Absence of a statement is not a statement of absence — it is unestablished |

**The gating unknown, and it is the one that decides everything:** the
documentation says to "generate an access token or OAuth credentials" but does
**not** say whether an app obtains OAuth client credentials self-serve or
through a partner/approval process. Until that is known, nobody can say whether
Zendrop is a credential Sean can supply or a provider review he must pass —
which is the difference between two different rows of this plan.

### Spocket — NOT established

**Nothing about Spocket's integration requirements could be confirmed from a
first-party source.** Third-party write-ups describe a "Developer Settings →
API Key" flow, and an API directory carries a Spocket entry whose
authentication, developer-docs and app-listing fields are all **blank**. No
official Spocket developer portal or API reference was found.

So the honest state is: a Spocket API is asserted by others and documented by
nobody we can cite. **Assuming an API-key model on that basis is exactly the
assumption Sean's instruction forbids.**

### What would establish them

Neither needs engineering yet. Both need a first-party answer:

| provider | the question |
|---|---|
| Zendrop | how does an application obtain OAuth client credentials — self-serve in an account, or partner/approval? And does it deliver webhooks? |
| Spocket | is there a first-party API at all, and what are its auth model, endpoints and access requirements? A Spocket account with developer settings visible would answer it |

Once answered, each becomes an ordinary connector: a module in
`lib/integrations/` and one line in the registry, with `configured()` and — if
the provider signs deliveries — `webhooks`, both already governed by
`verify-configured-truthfulness` and `verify-webhook-verifier-contract`.

---

**Not blocked, and not a credential: D4, the Printful live economics check.**
`PRINTFUL_CLIENT_ID`/`_SECRET` are set and six stores are connected and syncing,
so `scripts/check-printful-economics-live.ts` can run today.

**Classified 2026-09-17 as ACTIONABLE — AWAITING OWNER AUTHORIZATION**, which is
its own category and deliberately not "credential-blocked". Sean: "this is
different because the credentials already exist, but it makes a live production
API call. Do not run it without my explicit authorization."

So it sits in no queue and needs nothing bought or registered. It needs one
word from Sean, and until then it is not run.

Each connector's credential requirement is read from its own `configured()` and
asserted true-and-false by `verify-configured-truthfulness`, so the variable
names above cannot drift from the code without a suite going red. What that
suite cannot see is whether a variable is set in **production** or whether an
account is connected, which is what this audit checked separately.
