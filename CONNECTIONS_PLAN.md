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

## 7. Decisions, kept separate from engineering

None of these is a task and none is blocked on code.

| # | decision |
|---|---|
| **U7** | whether the migration gate returns — every push to `master` migrates production with no review step |
| **U8** | the live end-to-end payment test; the money path has never moved real money under this code |
| **E18** | whether Genesis collects tax at all. If yes it is Stripe Tax plus a column for `total_details.amount_tax` — real work, not a display fix |
| **E12** | switching security-signal deletion on; it deletes evidence, so the horizons want reading against a real footprint first |
| **E12b** | switching the retention sweep on; it clears stored provider delivery bodies at 30 days |
| **E13b** | retention horizons for five tables nobody has decided about, including the audit trail and the idempotency record |
| **E16** | how long a transaction record must be kept after an account closes — the one genuinely legal question, deliberately not guessed |
| **E17** | whether closing an account unpublishes its storefronts, transfers them, or leaves them running |

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
| 10 | `ALIEXPRESS_APP_KEY` / `_SECRET` | credential | AliExpress |

**Not blocked, and not a credential: D4, the Printful live economics check.**
`PRINTFUL_CLIENT_ID`/`_SECRET` are set and six stores are connected and syncing,
so `scripts/check-printful-economics-live.ts` can run today. It is a read-only
check that calls Printful's own API with Sean's production credentials, so it is
his to authorise rather than something to run unasked — but it is **not blocked**
and this plan previously said it was.

Each connector's credential requirement is read from its own `configured()` and
asserted true-and-false by `verify-configured-truthfulness`, so the variable
names above cannot drift from the code without a suite going red. What that
suite cannot see is whether a variable is set in **production** or whether an
account is connected, which is what this audit checked separately.
