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
| **C2** | **Gap 17 — the connector webhook contract test.** Every connector declaring `webhooks` must fail closed: no secret, wrong signature, hostile payload, and a delivery the pipeline never verified. | ready |
| **C3** | **`configured()` must be TRUE, not merely declared.** Printful is asserted both ways against the real environment; no other OAuth connector is. A `configured()` that always answers `true` rebuilds C1 somewhere else — and Twilio shipped exactly that once. | ready |

Everything else in Connections waits on a credential, an account, an app review,
or a decision above.
