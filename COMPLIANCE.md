# Integration security & compliance

*Started 2026-08-20, prompted by Intuit's production-key questionnaire. The
questionnaire is a benchmark, not the goal: every item below is a real property
Genesis should have whether or not Intuit ever asks.*

**The rule for this document: nothing is marked compliant unless there is
evidence — a file, a test, or a measurement. "Probably fine" is recorded as
NEEDS VERIFICATION, and a gap is recorded as a gap.**

---

## Status summary

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | OAuth 2.0 where the provider offers it | **Compliant** | 7 connectors; no implicit flow anywhere — see §1 |
| 2 | CSRF protection on the OAuth callback | **Compliant** | `oauthState.ts`; 13 assertions incl. the original attack |
| 3 | Credentials encrypted at rest | **Compliant** | `credentials.ts`, AES-GCM via `INTEGRATION_ENCRYPTION_KEY` |
| 4 | Credentials never reach the browser | **Compliant** | `toStatusView()`; asserted with a planted ciphertext |
| 5 | Credentials never written to logs | **Compliant** | audited — see §5 |
| 6 | Refresh-token rotation handled | **Compliant** | `tokenRefresh.ts`; 15 assertions |
| 7 | Expired / invalid grant handled honestly | **Compliant** | 400 → "please reconnect", surfaced in the UI |
| 8 | Revocation at the provider on disconnect | **Compliant** | every provider that offers it — see §8 |
| 9 | Tenant data isolation | **Compliant** | `tenantIsolation.ts` refuses unscoped access |
| 10 | Transport security | **Compliant** | HTTPS-only hosting; no plaintext endpoints |
| 11 | API error handling & backoff | **Partial** | sync backoff real; per-call 429 handling — see §11 |
| 12 | Owner-visible recovery path | **Compliant** | Recheck / Sync now / Disconnect + reconnect form |
| 13 | Static egress IP | **Needs Intuit clarification** | see §13 |

---

## 1–2. OAuth and CSRF

Authorization code flow throughout; no implicit flow exists in the codebase.

**No owner is asked to paste a key a provider would have delegated.** Mailchimp
was the last exception that had not earned itself — it collected an API key
while supporting OAuth2, which hands over the whole account permanently in a
form the owner cannot see, narrow, or withdraw from Genesis's side. It uses
OAuth now. The three remaining API-key connectors are genuine: PayPal (the
merchant's own app credentials), EasyPost and its per-store key — no OAuth
exists at either. Each states its reason in `apiKeyExceptionReason`, asserted.

Mailchimp's OAuth takes no scope parameter, and neither does Printful's. An
empty `scopes` array must mean "none exist", never "nobody filled this in", so
those two carry a `noScopesReason` and the suite requires one. It used to exempt
Printful by name, which would have silently swallowed the next connector that
shipped with `scopes: []` by accident.

Stores connected the old way keep working — their credentials are still an API
key and are still used as one, so nobody is forced to reconnect mid-campaign.
`scripts/verify-mailchimp-auth.ts` asserts both shapes and that they are never
confused for one another.

The `state` parameter was the most serious finding of the integration audit. It
carried the storeId in plain sight, which meant nothing was doing the job
`state` exists for. A crafted callback could bind an attacker's provider account
to a signed-in owner's store — and under Stripe's `read_write` scope that is the
account payouts answer to.

`state` is now **signed** (HMAC over the payload), **single-use** (nonce in an
httpOnly cookie, cleared on use), **session-bound** (the payload names the user
who began the flow, re-checked at callback), **expiring** (60 minutes), and
**provider-bound** (a Stripe state cannot complete a Square connection).

Evidence: `scripts/verify-integration-framework.ts` runs the original attack and
every variant — bare storeId, wrong signing key, edited payload, replayed nonce,
different user, expired, wrong provider — and asserts each fails.

## 3–4. Credential storage and exposure

Encrypted at rest with AES-GCM. `status()` returns `IntegrationStatusView`,
which structurally cannot carry the credentials blob; the test plants a
`SHOULD-NEVER-APPEAR` ciphertext and asserts it cannot survive serialization.

No server action or page returns credentials to a client component. The one
place a decrypted key is used at request time (EasyPost rating, Stripe checkout)
it stays server-side inside a server action.

## 5. Logging

Audited by grep across `lib/` and `app/` for any log call referencing
`accessToken`, `refreshToken`, `apiKey`, `clientSecret` or `credentials`. One
hit, and it logs *the absence* of credentials, not a value:

```
[paypal/return] no credentials for store <id>
```

Error logging deliberately records error **type, HTTP status, provider request
id and the OS-level cause** — never request bodies or headers, which is where
tokens live.

## 6–7. Token lifecycle

**A real production outage, and its fix.** QuickBooks was dead for eighteen days
because `refreshAccessToken` discarded the rotated refresh token. Intuit issues a
new refresh token roughly every 24 hours and retires the previous one; the
connector kept only the access token and never wrote anything back, so the first
refresh succeeded and every one after presented a retired token.

Timeline: connected 2026-07-31, last successful sync 2026-08-01 (≈24h, Intuit's
rotation interval), then eleven consecutive `token refresh failed (400)`.

Both QuickBooks and Google Calendar now persist the whole credential set through
a shared, tested merge — *keep whatever the provider just sent; fall back only
when it sent nothing*. Fifteen assertions, including three chained refreshes: the
exact sequence that used to break on the second.

A 400 now says **"please reconnect"** rather than a bare status code, because a
retired refresh token is only repairable by fresh authorization, and the owner is
the only one who can do it.

**One honest wrinkle.** Phase 0 added an optional framework-level `refresh()` to
the connector contract, and no connector implements it — the framework suite
prints `connectors implementing refresh(): (none yet)` on every run. That is not
a gap in behaviour: each connector refreshes inline, immediately before any API
call that needs a live token, which is where a refresh actually belongs. The
unused contract method is the thing that should go, and it is recorded here so
the printed "(none yet)" is not mistaken for missing refresh.

## 8. Revocation on disconnect

**The defect:** deleting a stored token is not revoking it. Outside Stripe,
disconnect cleared our copy and left the grant live at the provider — while the
owner had just been told access ended. That gap between what the button says and
what is true is the real problem; Intuit asking about it is only how it surfaced.

Every provider that offers revocation now gets it:

| Connector | Revokes | How |
|---|---|---|
| Stripe | ✅ | `oauth.deauthorize` (already did) |
| QuickBooks | ✅ | Intuit `/v2/oauth2/tokens/revoke` |
| Google Calendar | ✅ | `oauth2.googleapis.com/revoke` |
| Facebook / Instagram | ✅ | Meta `DELETE /{user-id}/permissions` |
| TikTok | ✅ | `open.tiktokapis.com/v2/oauth/revoke/` |
| Printful | — | **Printful documents no revocation endpoint** |
| Mailchimp | — | **Mailchimp documents none either** — the user withdraws it in their account |
| PayPal / EasyPost | — | API key — the merchant rotates it at the provider |

**Printful was recorded as a gap and was not one.** The first version of this
document asserted "Printful supports revocation and this does not use it". Their
OAuth documentation covers authorize, token, refresh and scopes and nothing else;
a token "remains valid until it expires or is manually deleted" in their portal.
Reading the docs is what corrected it. The suite now asserts Printful is the only
non-revoking OAuth connector, so if they ever ship an endpoint the test fails and
says so.

**Meta needed a real change, not a call.** `DELETE /{user-id}/permissions` needs
the Meta user id and a user token, and connect() discarded both the moment it had
a Page token. Both are captured now. A connection made *before* this change
cannot be revoked — `GET /me` with a Page token returns the Page, not the person,
so the user id is not recoverable after the fact. Those log the reason and
disconnect locally rather than pretending. Reconnecting fixes it permanently.

Revocation is **best-effort by design**: if the provider is unreachable the local
disconnect still proceeds, because refusing would trap an owner in a connection
they asked to end. Failures are logged — reason only, never the token.

This is declared in data, not prose: `capabilities.revokesOnDisconnect` on every
connector, asserted by name in the framework suite.

## 9. Tenant isolation

`lib/tenantIsolation.ts` refuses any Prisma read or write on a tenant-owned table
that lacks a store-scoping filter — enforced at the client, not by convention. A
real bug it caught: `designateAsset` performing an unscoped update.

Per-store credential boundaries are structural, not conventional. EasyPost has no
platform-wide key and `resolveStoreEasyPostClient` takes a storeId with no
environment-variable variant, so Genesis cannot fund a merchant's postage from a
shared account.

## 11. API error handling — PARTIAL

**Real:** connector sync failures record `syncFailureCount` and back off
exponentially (capped at 24h) in `lib/intelligence/scheduler.ts`, so a broken
connection is not hammered. Stripe's SDK retries transport failures internally. A single unreadable
EasyPost tracker does not fail an entire sync.

**Gap:** there is no explicit per-call handling of HTTP **429** or `Retry-After`
in the hand-written `fetch` connectors (QuickBooks, Google, Meta, TikTok). A rate
limit currently surfaces as a generic failure and is retried on the next
scheduled pass rather than when the provider says to. Not urgent at current
volume; recorded honestly rather than claimed.

## 12. Owner-visible recovery

A connected integration offers **Recheck**, **Sync now** and **Disconnect**; a
disconnected one offers the connect form. `lastError` is surfaced on the card
rather than kept in logs, so "QuickBooks needs reconnecting" is something the
owner reads, not something only a developer could discover.

The badge must match the truth. Both cards used to ask "is the row not
DISCONNECTED?" and render a green **Connected** on the strength of it — so six
real stores were told they could take payments through Stripe accounts that had
failed verification and could not take a cent. PayPal went further and rendered
**Connected** and **Needs attention** side by side, two contradictory answers to
the only question the card exists to answer.

Only a connection that actually verified says Connected now, and the rule is one
shared function rather than two cards each deciding for themselves what
"connected" means — `lib/integrations/paymentBadge.ts`, asserted by
`scripts/verify-payment-badge.ts`, including the case where no status has an
answer, which is how the original dishonesty survived review.

## 13. Static egress IP — NEEDS INTUIT CLARIFICATION

Intuit's questionnaire asks for the IP address the app is hosted at. Genesis runs
on Vercel serverless in the US and has **no static egress IP** — outbound calls
originate from rotating provider addresses.

There is no honest single answer, and inventing one would either fail review or,
worse, pass and then not match reality. This needs Intuit to confirm what they
expect for serverless hosting. Vercel Secure Compute would provide a fixed egress
IP if they require one.

---

## Verification

Everything above marked Compliant is covered by the deterministic suites, run
together on every change:

```
scripts/verify-integration-framework.ts   OAuth state, credentials, capabilities, revocation
scripts/verify-token-refresh.ts           rotation, chaining, expiry
scripts/verify-stale-executions.ts        pending-vs-failed execution semantics
scripts/verify-payment-badge.ts           what a payments badge may claim
scripts/verify-mailchimp-auth.ts          OAuth conversion without breaking existing connections
```

No item here is marked compliant on the strength of reading the code alone.
