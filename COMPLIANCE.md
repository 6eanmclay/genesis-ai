# Production-readiness audit

*Started 2026-08-20, prompted by Intuit's production-key questionnaire and then
continued well past it. The questionnaire was a benchmark, not the goal — and
once the integrations were done the same standard was applied to authentication,
authorization, the checkout and fulfilment paths, and every place Genesis tells
somebody that something happened.*

**The rule for this document: nothing is marked compliant unless there is
evidence — a file, a test, or a measurement. "Probably fine" is recorded as
NEEDS VERIFICATION, and a gap is recorded as a gap. Code that looks like it
supports something is not evidence that it does.**

---

## Action required from Sean

Everything on this list is blocked on an external credential, account, or
approval — not on engineering. Nothing else waits on any of it; the code is
written and tested, and each item simply switches something from "built" to
"usable". **None of it blocks Intuit, and Intuit does not block any of it.**

**Provider credentials that do not exist in production yet.** Checked against
Vercel, not assumed:

| Missing | Consequence today | To fix |
|---|---|---|
| `MAILCHIMP_CLIENT_ID` / `_SECRET` | nobody can connect Mailchimp (existing key-based connections are unaffected) | register an app in Mailchimp's developer console |
| `FACEBOOK_CLIENT_ID` / `_SECRET` | Facebook **and** Instagram cannot connect at all | one Meta app covers both |
| `TIKTOK_CLIENT_KEY` / `_SECRET` | TikTok cannot connect | register a TikTok developer app |
| `SQUARE_CLIENT_ID` / `_SECRET` | the Square connector cannot be built | register a Square application |
| `ALIEXPRESS_APP_KEY` / `_SECRET` | AliExpress cannot be searched for products; the source is registered and refuses rather than showing invented ones (§45) | register an AliExpress Open Platform app |

**Multi-business context — resolved, with one step left.** *Which business am I
in* is now an explicit, stored fact rather than a recency guess (§49), and the
domain was already store-scoped throughout (§48). What remains is putting the
business in the URL so a link can address one and two tabs can hold two: a route
migration across 28 screens, plus lifting `StoreDraft.userId`'s unique constraint
so an account can create a second business while a first is still in onboarding.
Not blocking correctness today; blocking the switcher.

**A decision, not a credential: should the migration gate come back?**
`20260820060000_product_sourcing` is **already applied to production** — not by
a deliberate step, but by the Vercel build, because `package.json`'s build script
has run `prisma migrate deploy` again since 2026-08-13 and `DEPLOYMENT.md` said
otherwise for a week (§46). The schema was verified correct against production
directly. Nothing is broken. But every push to `master` now migrates the
production database with no review step, which is exactly what Track 0 removed
on 2026-08-01, and the reason it was reversed is not recorded anywhere. Whether
to reinstate the gate is Sean's call, and it has been left alone rather than
quietly changed back.

**The integration encryption key has no backup, and cannot be read back.**
`INTEGRATION_ENCRYPTION_KEY` is stored in Vercel as a *Sensitive* variable, which
is write-only by design: `vercel env pull` returns `[SENSITIVE]`, the dashboard
will not reveal it, and there is no support path to recover it. Searched on
2026-08-28: it is not in any file on the development machine, and the shell
history holds the command that generated it (`randomBytes(32).toString("base64")`)
but not its output.

So the only copy that can decrypt stored integration credentials lives inside
Vercel's runtime. **If that variable is ever deleted, or the project recreated,
every stored credential across every store becomes permanently undecryptable** —
Printful, PayPal, Stripe Connect, QuickBooks, Google Calendar — and every
connected business has to reconnect from scratch. There is no partial recovery:
AES-GCM without the key is not a hard problem, it is an impossible one.

This is not a defect in the encryption. Requirement 3 is still met, and the local
key failing to decrypt production credentials is that design working, and the
economics-check note further down records the same behaviour. What is missing is
**custody**: a secret with no second copy is a single point of failure for every
integration in the product.

To fix, in order:

1. **Retrieve it while it is still retrievable** — from a password manager if it
   was saved there. It cannot be recovered from Vercel.
2. **Store it somewhere durable and access-controlled**, with the fact that it is
   unrecoverable written next to it.
3. **Then decide on rotation.** Rotating is a real operation, not a config
   change: every `StoreIntegration.credentials` row must be decrypted with the
   old key and re-encrypted with the new one in a single migration, or every
   connection breaks. That work is not scoped and is not urgent; step 2 is.

If step 1 fails — the key is genuinely gone — nothing breaks today, because the
running production deployment still holds it. The exposure is that the system is
one deleted environment variable away from a total, unrecoverable loss of every
integration, and no warning would precede it.

**Reconnections you have to do yourself**, because only the account holder can
re-authorize:

- **QuickBooks** — dead since 2026-08-01. The rotation bug that killed it is
  fixed, but a retired refresh token can only be replaced by fresh consent.
- **Google Calendar** — publish the OAuth app first. While the consent screen is
  in *Testing*, Google expires every refresh token after seven days, so
  reconnecting before publishing buys one week and then breaks again.

**Email does not work at all, and that reaches customers.** There is no
`RESEND_API_KEY` in production, so `isEmailConfigured()` is false on every store.
Three things silently do not happen:

- a customer is never told their order shipped, even after a label is bought
- password reset cannot send
- the Marketing Engine's send milestone stays paused, as it has been

Nothing pretends otherwise — `sendEmail` throws rather than faking success, and
as of 2026-08-20 buying a label tells the owner in plain words that the customer
was not emailed and that they need to send the tracking number themselves. But
that is damage control, not a working store. **A Resend account and a verified
sending domain is the single highest-value item on this page** for "real
customers place real orders".

**Waiting on someone else:**

- **EasyPost** — account verification. You have a support ticket open; the
  per-store architecture is finished and tested behind it.
- **Intuit** — what they expect for a "hosting IP address" from a serverless
  platform. See §13; there is no honest single answer to give them.
- **PayPal** — their delegated (multiparty) onboarding needs PayPal's approval
  before live use. Worth applying for only if you want sellers to connect PayPal
  without pasting their own app credentials. Not required for the current flow.

**Your decision, not a blocker:**

- **The live end-to-end payment test.** You explicitly chose not to run real
  money through checkout yet. Everything up to that point is verified; that one
  proof is not, and it is recorded as unverified rather than assumed.

---

## Status summary

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | OAuth 2.0 where the provider offers it | **Compliant** | 7 connectors; no implicit flow anywhere — see §1 |
| 2 | CSRF protection on the OAuth callback | **Compliant** | `oauthState.ts`; 13 assertions incl. the original attack |
| 3 | Credentials encrypted at rest | **Compliant** | `credentials.ts`, AES-GCM via `INTEGRATION_ENCRYPTION_KEY` — but the key itself has no backup; see Action Required |
| 4 | Credentials never reach the browser | **Compliant** | `toStatusView()`; asserted with a planted ciphertext |
| 5 | Credentials never written to logs or records | **Compliant** | `providerError.ts`; 21 assertions — see §5 |
| 6 | Token expiry & rotation handled | **Compliant** | `tokenRefresh.ts`; 21 assertions — see §6 |
| 7 | Expired / invalid grant handled honestly | **Compliant** | 400 → "please reconnect", surfaced in the UI |
| 8 | Revocation at the provider on disconnect | **Compliant** | every provider that offers it — see §8 |
| 9 | Tenant data isolation | **Compliant** | `tenantIsolation.ts`; 34 assertions — see §9 |
| 10 | Transport security | **Compliant** | HTTPS-only hosting; no plaintext endpoints |
| 11 | API error handling, rate limits & backoff | **Compliant** | shared `rateLimit.ts`; 36 + 22 assertions — see §11 |
| 12 | Owner-visible recovery path | **Compliant** | Recheck / Sync now / Disconnect + reconnect form |
| 13 | Static egress IP | **Needs Intuit clarification** | see §13 |
| 14 | Password policy & session eviction | **Compliant** | `passwordPolicy.ts`; 30 assertions — see §14 |
| 15 | Brute-force limits & cron gate | **Compliant** | `attemptThrottle.ts`, `cronAuth.ts`; 27 assertions — see §15 |
| 16 | Authorization on every server action | **Compliant** | every `"use server"` export audited — see §16 |
| 17 | No false success states | **Compliant** | 4 fixed, 5 verified honest — see §17 |
| 18 | Scheduled work fails in isolation | **Compliant** | 3 loops + 3 stages isolated — see §18 |
| 19 | Spot-checked and correct | **Verified** | routes, uploads, checkout routing — see §19 |
| 20 | OAuth CSRF on every callback | **Compliant** | signed state on all 3 routes; 8 assertions — see §20 |
| 21 | Money always leaves a trace | **Compliant** | 3 paths fixed; now DB-tested — see §21, §26 |
| 22 | Each fix proven against the old code | **Compliant** | 9 defects reproduced then blocked — see §22 |
| 23 | Growth Points cannot leak | **Compliant** | `planDeduction`; 21 assertions — see §23 |
| 24 | Role matrix pinned | **Compliant** | owner-only permissions asserted by name — see §24 |
| 25 | Webhook forgery & replay | **Compliant** | `resolveWebhookStore`; 14 assertions — see §25 |
| 26 | Database-backed testing | **Compliant** | in-process Postgres, real migrations — see §26 |
| 27 | Tests cannot touch real data | **Compliant** | env + marker table; both required — see §27 |
| 28 | Webhook handlers attacked | **Compliant** | signed payloads, 40 assertions — see §28, §29 |
| 29 | Refunds & connected-account forgery | **Compliant** | handler-level, real database — see §29 |
| 30 | Operator visibility on failure | **Compliant** | `reportIssue`; 22 assertions — see §30 |
| 31 | Misconfiguration ≠ attack | **Compliant** | 500 not 400 on unset secret — see §32 |
| 32 | Order creation survives a bad event | **Compliant** | permanent vs transient split — see §33 |
| 33 | Order creation in a real request | **Compliant** | real server + real Postgres; 32 assertions — see §34 |
| 34 | Customer confirmation exists at all | **Compliant** | `orderConfirmation.ts`; 63 assertions — see §35 |
| 35 | Confirmation actually delivered | **EXTERNALLY BLOCKED** | needs a Resend credential — see §35 |
| 36 | One parcel cannot be paid for twice | **Compliant** | claim before spending — see §36 |
| 37 | Checkout metadata is authoritative | **Compliant** | real action, real Postgres; 30 assertions — see §37 |
| 38 | Shipping checkout can actually complete | **Compliant** | gated on Stripe; 4 assertions — see §38 |
| 39 | Order fulfilment lifecycle | **Compliant** | real Postgres; 27 assertions — see §39 |
| 40 | Refund path / money out | **Compliant** | real Postgres; 38 assertions — see §40 |
| 41 | Partial refunds modelled | **NOT MODELLED** | known gap, decision needed — see §40 |

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

PayPal's reason was rewritten during this audit. It used to say "no per-merchant
OAuth handoff is implemented", which reads as an admission of laziness; the fact
is that PayPal's delegated (multiparty) flow **is not self-serve** — a platform
must apply and be approved by PayPal before acting on a seller's behalf in live
mode. Until that approval exists the merchant's own app credentials are the only
honest option. Applying is on the Action Required list.

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

**The audit of that claim found it half true, and the code was changed to make
it fully true.** It held for requests and not for responses: eleven call sites
did ``throw new Error(`... failed (${res.status}): ${body}`)`` with the raw
response body. That message is not ephemeral — the execution engine catches it,
writes it to `ExecutionLog.message` in the database, and renders it on the
owner's Connections card. Three problems, worst last: a business owner is shown
raw JSON from an API they have never heard of; token endpoints are exactly where
credentials live, and a failure body echoing submitted parameters back is a real
provider behaviour rather than a hypothetical; and unlike a log line that scrolls
away, a secret in `ExecutionLog` persists until someone deletes the row.

`describeProviderError()` now takes the status and the provider's own error name
and description, redacts anything token-shaped, caps the length, and quotes
nothing at all from a body it cannot parse. Prose is left intact — a redaction
that eats the message it was protecting is no use. Both properties are asserted.

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

**The same bug was still in two other connectors, and declaring the problem is
what found them.** Phase 0 had added an optional framework-level `refresh()` that
no connector ever implemented — the suite printed "(none yet)" every run, which
read as a gap and was not one. The method was simply the wrong shape: renewal
belongs immediately before the call that needs a live token, which is where each
connector already does it. What was actually wanted was *visibility*, and that is
data, not a method. So it became `capabilities.tokenLifetime`:

| permanent | expires | rotating |
|---|---|---|
| Stripe, PayPal, EasyPost, Mailchimp | Google, Facebook, Instagram | **QuickBooks, Printful, TikTok** |

Writing those three columns down immediately surfaced two live defects:

- **TikTok had the QuickBooks bug verbatim.** It read only `access_token`,
  discarded the rotated `refresh_token`, and persisted nothing at all — so every
  call re-refreshed and the second one would have presented a retired token.
  TikTok's own documentation is explicit: *"You must use the newly-returned token
  if the value is different than the previous one."* Unfired only because nobody
  has connected TikTok in production yet.
- **Printful's `verify()` dropped the refreshed credentials.** The fulfillment
  path saves what `refreshPrintfulToken` returns; the connector's own verify did
  not, so a Recheck that happened to trigger a renewal retired the stored token.

Both now persist through the same tested merge as QuickBooks and Google.

Facebook and Instagram are declared `expires` for a subtler reason worth naming:
the Page token used for every API call is effectively non-expiring, but the user
token kept beside it *for revocation* lasts about 60 days. The connection keeps
working; `disconnect()` quietly loses the ability to revoke at Meta. That is
logged rather than silent, and reconnecting restores it.

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

`lib/tenantIsolation.ts` refuses any Prisma collection read or mutation on a
tenant-owned table that lacks a store-scoping filter — enforced as a client
extension at a single choke point, not by convention. A real bug it caught:
`designateAsset` performing an unscoped update.

**It had no test, and this document marked it compliant anyway** — on the
strength of the file existing, which is exactly the standard this audit exists to
reject. Writing the assertions found two real bypasses, both of which selected
other tenants' rows *while passing the check*:

```
{ storeId: { not: "mine" } }      every store EXCEPT the caller's
{ store: { published: true } }    every published store on the platform
```

The first passed because `storeId` was merely **present**; the second because
`store` was merely a non-empty object. Presence is not scoping — a negation is
its exact opposite, and a relation filter naming no particular store narrows
nothing. A scope key must now carry an identifying value (a bare id, `equals`,
or `in`), and a `store` relation filter must name an `id`, `slug`, or `userId`.

The OR/AND asymmetry is asserted because it is the one that leaks: AND needs only
one scoped branch (every branch must match anyway), but OR needs **every** branch
scoped, since a single unscoped branch returns other stores' rows on its own.

Per-store credential boundaries are structural, not conventional. EasyPost has no
platform-wide key and `resolveStoreEasyPostClient` takes a storeId with no
environment-variable variant, so Genesis cannot fund a merchant's postage from a
shared account.

## 11. API error handling, rate limits and backoff

Sync failures record `syncFailureCount` and back off exponentially, capped at
24h, so a broken connection is not hammered. A single unreadable EasyPost tracker
does not fail an entire sync.

**Rate limiting is handled once, at the connector layer** —
`lib/integrations/rateLimit.ts`, not sprinkled per provider. The question asked
first was whether each provider even needs it, and the answer is no, so three
connectors deliberately got nothing:

| Provider | What it actually does | Wrapped? |
|---|---|---|
| Mailchimp | 429, limit of 10 *simultaneous* connections | yes |
| TikTok | 429 + `rate_limit_exceeded`, 600/min | yes |
| Google | **403 *or* 429**, and asks for backoff **with jitter** by name | yes |
| QuickBooks | 429 when throttled | yes |
| Printful | 120/min; status code **undocumented** — 429 handled defensively | yes |
| Stripe | stripe-node retries 429s itself; `maxNetworkRetries` defaults to 2 | no — nothing to do |
| EasyPost | official SDK, same reasoning | no — nothing to do |
| **Meta** | **does not return 429 at all** | no — **would be wrong** |

Meta is the one worth stating plainly. The Graph API signals throttling with an
error *code in the body* (4 app-level, 17 user-level, 32/80001 page-level) and
puts the wait in `X-Business-Use-Case-Usage`'s `estimated_time_to_regain_access`,
in minutes. A 429 handler there would never fire once, and would read as
protection that is not there. Adding it would be worse than the gap.

Two details are the provider's, not ours. `Retry-After` is legally either
delta-seconds or an HTTP-date and both forms appear in the wild, so both parse —
and a header we cannot parse is `null`, never a guess. Jitter is real because
Google documents *why*: without it, every client throttled together retries
together and is throttled again.

**A rate limit is a deferral, not a failure**, and that distinction is the most
valuable part. It reaches the scheduler as PARTIAL carrying the provider's own
timing, so a throttled connector waits exactly as long as it was asked to and its
`syncFailureCount` is left alone. Previously it would have counted as a failure
and walked a healthy, popular connection up the exponential curve toward the 24h
cap — the owner seeing a connection that "stopped syncing" when nothing was wrong
with it. `nextSyncAttempt()` is pure and asserts all three outcomes.

**Still open:** the token-exchange and revocation endpoints are not wrapped. They
run once per connection rather than on every sync, so the volume that provokes a
rate limit is not there. Recorded rather than done.


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

## 14. Authentication

Three defects, all found by auditing the auth surface rather than the connectors.

**There was no password requirement at all.** Signup checked `if (!email || !password)`; the reset flow checked nothing. `"a"` was a valid password on a platform holding merchants' connected Stripe accounts. One shared policy now guards both — a reset path with weaker rules than signup is a way around the rules.

The rules follow NIST SP 800-63B, so the notable part is what is *absent*: no composition requirements. Demanding an uppercase and a symbol pushes people to `Password1!` and away from passphrases. `correct horse battery staple` passes, and there are assertions saying so, so nobody "improves" that later. bcrypt's 72-byte truncation is enforced rather than ignored — past it, two different passwords become the same stored password.

**Resetting a password did not evict whoever prompted the reset.** Sessions are JWTs, so there is no session row to delete, and a token already in an attacker's hands stayed valid until it expired on its own. `passwordChangedAt` is stamped on reset and any JWT issued before it is refused.

That was verified against `@auth/core` twice rather than assumed: returning `null` from the jwt callback really does push `sessionStore.clean()` and drop the cookie, and the `iat` comparison still works despite Auth.js re-issuing the token on every session read, because the callback runs *before* that re-encode. The units are the trap — `iat` is seconds, `Date` is milliseconds, and comparing them directly signs out every user on the platform. That is why it is a named function with its own assertion.

**A reset burned only the link that was used.** An attacker's outstanding link survived, so securing the account left the back door open for the rest of the hour. All of an account's unused links are now burned together.

## 15. Brute force, and the cron gate

**No auth endpoint had any rate limiting.** Login, signup and password-reset requests could be hammered at whatever rate a script managed.

Two limits, because they stop different attacks: per-identifier is tight and catches a password list against one address; per-source is looser (offices share an IP) and catches one common password sprayed across many addresses, which never trips a per-identifier limit at all. Either alone leaves the other untouched.

Both refusals return the *same* response as an ordinary failure — a distinct "too many attempts" would confirm the address exists. The reset endpoint counts attempts whether or not the email matches a real account, because counting only real ones makes the limit itself an oracle.

A database table, not an in-memory counter: this is serverless, so a Map resets on every cold start and is not shared between instances — it would look like protection and provide none. What is stored is a **hash**; a table full of plaintext emails typed by attackers, belonging to real people who never signed up here, would be a liability created in the name of security.

**The cron gate failed open.** It compared the header against a template string that becomes the literal `"Bearer undefined"` when `CRON_SECRET` is unset — behind which sits `runDueSyncs`, the scheduler's cross-tenant execution bypass. The secret is set in production so this was latent, but "the environment happens to be configured correctly" is not an access control.

## 16. Authorization — audited, and mostly sound

Every id-taking export in every `"use server"` module was checked. **One trusted its caller:** `confirmStoreDraftCore(userId)` was written as an internal helper, but every exported async function in a `"use server"` file is a callable endpoint — so it was "name any account, and their draft becomes a published Store and the draft is deleted". All four call sites already passed the signed-in user's own id.

The rest held up, and that is worth recording so it is not re-checked from scratch:

- `toggleProductActive` / `deleteProduct` / `toggleOrderFulfilled` look unguarded — bare resource id, unscoped lookup — but they pass the **resource's** storeId into `execute()`, which runs `requireStorePermission` against exactly that store. A caller naming another tenant's product fails on their own missing role.
- The product-image executables scope every query by `ctx.storeId`.
- The chat uploads guard inside their turn functions, not at the exported wrapper.
- `lib/dashboard/pendingApprovals.ts` takes a raw `storeId` and looked alarming until checked: it is not a server-action module at all.
- The approval actions (`performApproveGenesisAction`, `…Group`, and the J4 conversation and onboarding-meeting wrappers that reuse them) all scope by the session's storeId, so a cross-store approval id resolves to `not_found`.

**One more tightened (2026-08-20).** `performApprovePendingChanges(storeId)` took a caller-supplied store id. It could not approve anything cross-store — every path below it re-derives the storeId from the session — but it *did* perform an unscoped read of another store's pending approvals before those guards caught it. The id is confirmed against the session now, because "the next function down happens to be safe" is not a reason to read another tenant's rows at all.

## 17. False success states

The standing rule: Genesis never tells anyone something happened unless it did.

**Buying a shipping label said nothing about whether the customer was told.** "Bought a USPS label — tracking 9400…" was the whole message. On every store today the buyer had heard nothing, because email is unconfigured. The owner would read that as done; the customer would be waiting. It now says plainly that they were not emailed and that the owner needs to send the tracking number themselves.

**Four PayPal exits dropped the buyer on the shop's front page with no message.** Missing credentials, a failed capture, a failed re-fetch of an already-captured order, and a custom_id mismatch. Two of those happen *after* PayPal has taken the money — and silence is the worst false state, because the comfortable assumption is "it failed, I'll try again", and they would pay twice. There are exactly two honest things to say and now exactly two notices, with the money-moved one asserted hard: retrying is not safe, and the words say so rather than relying on a missing button. Both money-moved paths also write a FAILED `ExecutionLog` so the owner sees a real captured payment that produced no order.

**Checked and found honest** (recorded so they are not re-audited): the newsletter signup says "you're on the list", which is exactly what happened and claims nothing about sending; `?payment_pending=1` renders a real banner with a reference; the forgot-password success copy is only reachable when email is actually configured, and a send failure becomes an error rather than a success; "Order marked as fulfilled" claims only the state change; Stripe's webhook is idempotent inside a transaction and both webhook routes verify signatures.

---

## 18. Scheduled work, and failing in isolation

The daily cron does three independent things: connector syncs, growth-point
refreshes, and first-party intelligence cycles. A store needs no connected
integration to be due points, and none to have intelligence to run.

**They were awaited bare, and both cross-tenant loops were unguarded.** Three
silent failure modes, all found by reading the loops rather than by anything
breaking:

- One store's failure inside the sync loop — a Prisma write that throws, a
  connector failing in a way `execute()` does not catch — **abandoned every
  store after it in the same run**, until the next invocation.
- The growth-point loop had the same shape, so one failed transaction silently
  denied every later store a month's points.
- A throw in any stage 500'd the whole route and skipped the two after it, with
  nothing recording that they had been *skipped* rather than *found empty*.

All three loops are isolated per store now, and each stage reports its own
outcome. The response carries `stageErrors`, because a stage that failed and a
stage that found nothing to do produce identical counts, and telling them apart
is the entire reason that field exists.

Change detection is isolated separately and deliberately: it is interpretation
layered on a sync that has already succeeded and already been recorded, so it
must never be able to undo the run it is commenting on.

`runDueIntelligenceCycles` already had per-store isolation and was left alone.

## 19. Verified honest, no change needed

Checked against implementation during this pass and found correct. Recorded so
the next audit does not re-derive them:

- **Every API route** is authenticated, cron-gated, or intentionally public. The
  only three without a session check are the NextAuth handler, the PayPal buyer
  return (buyers are not signed in), and registration.
- **Blob uploads** run the session and permission check inside
  `onBeforeGenerateToken`, before any token — and therefore any byte — is
  issued, with content types and a size ceiling enforced. Paths are
  `products/{uuid}`, so one tenant cannot guess or overwrite another's.
- **Checkout** re-checks `canStoreAcceptPayments` on the server even though the
  button hides itself, because the action is a public POST target regardless of
  what rendered. `selectProvider` only ever returns a provider whose status is
  actually CONNECTED, so it cannot route a customer to a broken one.
- **Unknown errors** in storefront actions map to a generic message and are
  logged, never surfaced raw to a customer.
- **Payment badges, `canStoreAcceptPayments` and `selectProvider`** all agree on
  one definition of connected: `status === "CONNECTED"`. Three places, one rule.

---

## 20. The OAuth CSRF Phase 0 missed

Phase 0 replaced `state = storeId` with a signed, single-use, session-bound,
expiring handoff across every OAuth callback — and left one route untouched.

The onboarding fulfillment callback still used `state = "${draftId}:PRINTFUL"`
and split it on a colon. It was **not** an open takeover, because the route
checks that the draft belongs to the signed-in user. But a crafted callback
clicked by a signed-in owner would still have stored **the attacker's Printful
credentials on the victim's draft** — and every fulfillment order that store
later placed would have gone to the attacker's account, with real product and
real money.

The route parses nothing now. Onboarding needed one extension to Phase 0's
payload, which assumed a Store exists: an optional `storeDraftId`, set *instead
of* `storeId`. That has a useful side effect worth keeping — a state minted for
the dashboard's own Printful connect carries a `storeId` and no draft, so it
cannot be replayed against the onboarding callback even though the provider
matches. Asserted both ways.

Only three API routes read query parameters at all. The other two are the shared
integrations callback (signed state since Phase 0) and the PayPal buyer return,
which cannot be forged for a different store: capture runs against that store's
own credentials and the `custom_id` is checked against the store it claims.

## 21. Money that arrives and produces nothing

Three paths where a real payment completed and the only trace was a console line
the owner never sees. Stripe had been told OK, so it never retried.

- **A storefront checkout that could not be resolved to a store and product.**
  The customer got their Stripe receipt; the owner saw nothing.
- **A Growth Point purchase or plan subscription that could not be applied.**
  Someone paid Genesis and received nothing.
- **A PayPal capture that succeeded with a mismatched `custom_id`.** Fixed
  earlier in this audit; the same shape.

Each now writes a durable FAILED `ExecutionLog` naming the session and amount,
telling the owner to reconcile it before assuming it was not a real sale. Where
the store genuinely cannot be resolved — a session from an account matching no
connection — there is nothing to attach a record to, and the code says so rather
than quietly accepting it.

**A related inversion, on the same money path.** `execute()` deducts Growth
Points *after* the work is done and the success is already recorded. That
deduction was awaited bare, so a ledger write that threw fell into the catch
block, overwrote the record with FAILED, and returned FAILED — telling the owner
their action failed when it had succeeded, which invites them to do it again.
Under-charging on a database hiccup is the right way to be wrong: a missed
deduction is a few points, a false failure is duplicated work.

Verified rather than assumed while there: `recordExecutionEvent` really does
catch everything, and `creditGrowthPointsFromPurchase` really is idempotent —
it checks a unique `externalRef` inside the same transaction, so a redelivered
Stripe event cannot double-credit real money.

**Left alone deliberately:** partial refunds still do not flip `Order.status`.
The existing comment already names that as a real gap rather than an oversight,
and relabelling a substantially-paid order "refunded" would mislead the owner
about what they still have to ship.

**Now covered.** This was recorded as inspection-only, with a database-backed
test named as the honest next step. That harness exists — see §26 — and the
ledger half of it is proven: `verify-ledger-live.ts` runs the real
`deductGrowthPoints` and `creditGrowthPointsFromPurchase` transactions against a
real Postgres. What remains inspection-only is narrower: the webhook handlers
themselves, which need HTTP request plumbing rather than just a database.

---

## 22. Proof that each defect was real

A test asserting the current code is correct is not evidence on its own — it
might have passed before the fix too.

`scripts/verify-regressions.ts` carries the **actual pre-fix implementations**,
copied from the commits that replaced them, and asserts two things per defect:
the attack succeeds against the old code, and fails against the current one.
Nine of them: both tenant-isolation bypasses, the forged onboarding OAuth state,
payment badges claiming a dead Stripe account can take money, the discarded
rotated refresh token, `"Bearer undefined"`, a rate limit counted as a failure, a
stolen session surviving a password reset, `"a"` as a password, and an access
token written into `ExecutionLog`.

Both halves have to keep telling the truth: revert a fix and the second assertion
breaks; "simplify" an old-code reproduction until it stops being vulnerable and
the first breaks. Each section also asserts the *legitimate* case still works,
because half these fixes could be made to pass by breaking the feature.

## 23. Growth Points — three ways money leaked

Points are sold for real money. The credit side had guarded itself all along;
the debit side had not.

**Deducted twice.** `creditGrowthPointsFromPurchase` checks a unique
`externalRef` inside its own transaction, so a redelivered Stripe event cannot
double-credit. `deductGrowthPoints` took an `executionLogId` and never looked at
it. Idempotency is now decided *first* — before plan coverage or balance — so a
second attempt does nothing even if the store has since moved to an unlimited
plan or the balance changed.

**Spent below zero.** `checkGrowthPointBalance` runs in `execute()` before the
work; the decrement ran in a different transaction afterwards. Two concurrent
actions could both pass the check and both decrement. The decrement is
conditional now — the balance must still cover the cost at write time — and a
race lost to a concurrent spend writes an honest zero-amount row naming the
shortfall rather than going negative or pretending the action was free.

**Minted for free.** `addGrowthPointsForTesting` was gated on `BILLING_MANAGE`,
which every store OWNER has on their own store — so any real customer could give
themselves 500 points per submit, unlimited times. The code's own comment called
this "a real product decision to gate/remove before that stops being true". It is
platform-operator only now on both sides: the action refuses, and the form does
not render, so nobody is shown a button that throws.

`planDeduction` is pure, so the boundaries are asserted where money quietly
leaks: a balance exactly equal to the cost still charges, one point short does
not, a zero-cost action is a charge of zero rather than a shortfall, and coverage
is checked before affordability so an unlimited plan works at a zero balance.

## 24. Roles — audited, and pinned before it matters

No privilege escalation, for a structural reason: **OWNER is derived from
`Store.userId`, never from a `StoreMember` row**, so it cannot be granted by
writing to a membership table. EMPLOYEE comes from `StoreMember` — and **no code
path anywhere creates one**. `EMPLOYEES_MANAGE` is defined and never referenced;
there is no invite flow. Today every user is either OWNER of their own store or
has no role at all.

That is a reason to pin the matrix *now*. The realistic way this breaks is not an
attacker but someone adding a line to the EMPLOYEE array while wiring up a
feature, months from now, once an invite flow exists. So the owner-only
permissions are asserted **by name**, each paired with an assertion that the
owner genuinely holds it.

## 25. Forging webhook events at the money boundary

The trust boundary for money arriving was only reachable through a database, so
it had never been attacked directly. The rules are unchanged — lifted verbatim
out of the webhook — but `resolveWebhookStore` is pure now and gets forged
events thrown at it.

The attack: a connected merchant holds an API-key-equivalent access token for
their own Stripe account, so they can create a Checkout Session directly with any
metadata they like — including someone else's `storeId`. `event.account` is
stamped by Stripe and cannot be forged, so metadata may only *disambiguate*
between stores that genuinely hold that account.

Six forgeries, all landing nowhere useful — including the subtle one: a **null**
stored `externalAccountId` must not match a null account, or any connected event
could be claimed for a store whose account id had been cleared. An account
matching nothing resolves to null rather than guessing, which is what makes that
money visible as unrecorded rather than quietly filed under a wrong store.

The legitimate case is asserted too, because it is why this is not simply "use
`event.account`": `externalAccountId` has no unique constraint, so one owner
running two stores can connect the same Stripe account to both.

Replay and reordering get their own section: resolution is a pure function of the
event, so a redelivered event always lands in the same store. That matters
because the order-level idempotency guard keys on session id *within* one store —
if resolution drifted between attempts, the guard would be looking in the wrong
place.

---

## 26. A real database for the tests that could only be read

Twelve suites could not run locally, and every fix in database-bound code was
verified by reading. `scripts/lib/testDatabase.ts` closes that: PGlite in-process,
speaking the real wire protocol, with the schema built by running **the real
migration files** — a harness that invents its own schema tests a database that
does not exist.

**Not the production database, deliberately.** The obvious shortcut is to point
the suites at `DATABASE_URL` and roll back, which is one bad transaction boundary
away from mutating a real merchant's store. Nothing here can reach production: the
connection string is built from a port the test process opened.

It immediately turned three read-only claims into tested ones:

- **The tenant guard is real.** The two bypasses were proven against the
  predicate; this proves the *extension* uses it, by running unscoped `findMany`,
  `count`, `updateMany`, a negated `storeId` and a store relation naming no
  store — all refused against a live database with another tenant's order in it.
- **The constraints under the idempotency checks are real.** A replayed Stripe
  session cannot become a second order; a redelivered Growth Point purchase
  cannot credit twice; deleting a store takes its orders and ledger with it
  rather than orphaning a closed merchant's customer emails and money history.
- **Every migration applies cleanly from scratch** — the one property a
  migration has that cannot be code-reviewed.

Three PGlite constraints are written down where they cost time, so they cost
nobody else any: the migration must run **async** (a sync child process blocks
the event loop the in-process server needs, and it hangs with no clue why);
`sslmode=disable`, or the handshake fails as the misleading "Can't reach database
server"; and PGlite **closes the connection on any Postgres-level error**, so a
deliberate constraint violation kills the client — healed in the harness, but
only for errors that actually reached Postgres, since disconnecting after a
guard-level error breaks the *next* query instead.

**And it revived twelve dormant suites.** `scripts/run-db-suites.ts` runs the
suites that import `lib/prisma` against the harness. They had never run: they
died instantly with "Can't reach database server", so they contained coverage
nobody could execute — worse than no coverage, because it looks like coverage in
a file listing. **8 of 12 pass now**, up from 1.

The finding there mattered more than the count. **Eleven of the twelve were
written to run against production**, reaching for "a real store", "a real
product", "a real user" via a bare `findFirst`. Some of them *mutate* what they
find — `verify-product-content-change` renames the first product it sees, which
against the production database renames a live merchant's item. They need no
particular data, only *some*, so the runner seeds it.

The four that still fail are reported rather than hidden, because which ones and
why is the useful part:

| Suite | Why |
|---|---|
| `stripe-webhook-e2e` | POSTs to the webhook route over HTTP — wants `next dev`, not a database |
| `brand-logo-flow`, `social-connections-pipeline`, `product-image-gallery-e2e` | PGlite closes the connection on any Postgres-level error, and these exercise error paths, so each fails on its *next* query rather than on what it was asserting |

**No longer inspection-only.** The handlers are called directly with real
Stripe-signed payloads — see §28. One path remains server-dependent and is named
there: the merchant webhook's order-creation branch, which ends in Next's
`after()`.

---

## 27. No test can touch real merchant data

Eleven suites were written to run against production and several of them
**mutate what they find** — `verify-product-content-change` renames the first
product it sees. The only thing between a real catalogue and a test run was
whoever typed the command remembering which `DATABASE_URL` was in their shell.

Two conditions guard that now, and **both** are required:

1. `GENESIS_TEST_DATABASE=1`, which the harness sets — catches the ordinary
   mistake of running a suite directly with production credentials loaded.
2. A **marker table** only the harness creates. This is the one that matters:
   exporting a variable by hand cannot make production look like a test
   database, because production has no marker table and these suites never
   create one.

A guard satisfiable from a shell profile would be theatre, so
`verify-test-isolation.ts` asserts each condition fails *on its own*. Verified
against the real production database too — with the flag deliberately set and
production credentials loaded, it refuses and names the missing marker (a
read-only `information_schema` lookup; nothing was written).

The fifth assertion is the one with a future: the realistic regression is not
someone deleting a guard but someone adding a **thirteenth suite** without
knowing this exists, so the suite scans `scripts/` and fails if any file touching
Prisma lacks the call.

## 28. The webhook handlers, attacked

§25 asserted the store-resolution *decision*. This calls the actual `POST`
handlers with real Stripe-signed payloads and asserts what lands in the database.

**It found a real defect immediately.** A Growth Point purchase naming a store
that no longer resolves — deleted between checkout and delivery, or stale
metadata — threw `P2025` straight out of the handler. That is a 500, so **Stripe
retried it for days against something that could never succeed**, and the payment
left no trace anyone would find. Both money branches are guarded now and record
the loss instead; the subscription branch had the same shape and the same fix.

Signature verification is the security boundary, so it is asserted three ways —
no signature, wrong secret, payload edited after signing — and each case then
checks that **no point was credited and no ledger row written**, because
"returns 400" is only half the property. The two endpoints hold independent
secrets precisely so a leak of one does not authorise the other, so that is
asserted too: the platform secret does not work on the merchant endpoint.

Replay is covered end to end rather than at the constraint level: three
deliveries of one event credit once and write one row, and a genuinely different
session still credits — idempotency keyed on the wrong thing would silently lose
the second sale.

**Scope, stated as a limit rather than omitted:** the merchant webhook's
order-creation branch ends with Next's `after()`, which throws outside a request
scope, so that one path still needs a running server (`verify-stripe-webhook-e2e`).
Everything returning before it is covered here, and the platform billing webhook
is covered end to end because it never calls `after()` at all.

---

## 29. Refunds, and a merchant claiming someone else's sale

Two more handler paths, both money-state transitions never previously exercised.

**Refunds move exactly one order, and only on a full refund.** A partial refund
deliberately leaves it `paid` — the owner still has to ship it, and relabelling a
substantially-paid order would mislead them about that. Replays are no-ops, an
unmatched refund is acknowledged rather than crashing the endpoint into a Stripe
retry loop, and the store's *other* orders are asserted untouched, because a
refund sweeping siblings along with it is the failure hardest to notice.

**The connected-account forgery is now proven at the handler level**, not just
against the resolution function: a merchant creating a session on their own
Stripe account with the victim's `storeId` in metadata gets the event filed
against their own store. Nothing recorded against the victim, no order anywhere.

## 30. The operator could not see any of it

Sentry is wired and its DSN is set in production. But **nineteen error paths**
across the webhooks, the checkout return, the scheduler and the execution engine
were `console.error` and nothing else. Not one reached Sentry.

Those are precisely the paths this audit added or hardened because they matter: a
completed payment that produced no order, points that could not be credited, a
PayPal capture that took money and could not be recorded, one store's failure
inside a cross-tenant cron, a deduction that silently did not happen.

On Vercel a console line goes to runtime logs — retained briefly, and found only
by someone who already suspects a problem. *"Money arrived and produced nothing"*
cannot depend on somebody thinking to look. The owner-facing half already existed
(these paths write a durable `ExecutionLog`); this is the **operator** half.

Tagged by subsystem, stage and storeId rather than buried in a message, so "which
store is this?" is a filter and not a full-text search at 3am.

Two properties are proven rather than assumed. It **never throws** — every call
site is already inside a catch handling something that has gone wrong, so a
Sentry outage there must not become the thing that breaks a payment. And it
**redacts**: provider errors carry response bodies, and the same token this audit
kept out of the database must not go to a third party instead. Both directions
asserted, including that the redaction does not eat the reason it was protecting.

## 31. The harness limit, diagnosed properly

The three suites still failing under the harness were assumed to be hitting
PGlite's connection-close-on-error. **That was wrong.** Confirmed in isolation:
**concurrent queries** close the connection. Prisma's pg adapter uses a pool, so
a `Promise.all` of three counts opens more than one connection to PGlite's wire
server and it drops them. All three run code that legitimately parallelises reads
(`reasoning.ts`, `understanding.ts`, the image executables' `Promise.all` of
updates).

This is a harness limitation, **not a defect**: real Postgres handles concurrent
queries, which is the entire point of a pool. Capping the pool at one connection
would fix the harness by changing how production talks to Neon — the wrong trade.
So those three stay uncovered here, and are named rather than hidden.

---

## 32. A missing secret told Stripe to give up on real payments

Both webhook routes read their secret with a non-null assertion and handed it to
`constructEvent`. With the variable **unset**, that throws a `TypeError` — which,
at that catch, is indistinguishable from a forged signature. So the route
answered **400**.

400 is how you tell Stripe a request is permanently bad. **Stripe stops
retrying.** A missing environment variable therefore converted every real payment
during that window into an order that never existed, with no retry and nothing in
the logs but "Invalid signature" — which reads as an attack rather than a
deployment mistake, so nobody would go looking for the cause.

A misconfiguration answers **500** now: Stripe keeps retrying, and the moment the
secret is set the backlog delivers. It also reports to the operator, which is
exactly the class of failure §30 existed to surface.

The test proves the fix does not merely move the problem: a blank secret is
treated the same as an unset one, a genuinely forged signature is **still 400**
(answering 500 to everything would have Stripe retrying forgeries forever), and
once configured a real event credits normally.

Checked per request rather than at module load — a config check that runs once on
cold start cannot report anything useful, and the value changes between deploys.

---

## 33. The order-creation branch

`after()` was checked against Next's own documentation first: it is valid in
Route Handlers, runs after the response, and shares the route's max duration. The
usage here is correct — Stripe gets a fast ack and the observation sweeps run
afterwards, wrapped in `.catch()` so they cannot affect the response.

**The defect, found by reading and then reproduced.** A platform-key event takes
`storeId` straight from metadata, *unvalidated*. If the store was deleted between
checkout and delivery, `order.create` violates the foreign key and that threw
straight out of `POST`. Next answers 500, Stripe retries for days against
something that can never succeed, then gives up: a real payment, no order, no
record anywhere.

The fix is a **split, not a catch-all**, because the two directions are expensive
in opposite ways:

| | Meaning | Answer | Why |
|---|---|---|---|
| **Permanent** (`P2003`, `P2025`) | the store or product is gone | acknowledge, report | retrying is a slower way to lose the same sale |
| **Transient** (everything else) | a blip | rethrow → 500 | a retry is exactly what recovers it |

`isPermanentOrderFailure` is pure and both directions are asserted — including
the default, since anything unrecognised is treated as **transient**. That
direction is deliberate: retrying a permanent failure wastes a few days of
Stripe's patience, while not retrying a transient one loses a real sale.

This is now verified end to end through a real server — see §34.

---

## 34. The order-creation branch, for real

The environment was the blocker, so the environment was fixed rather than the
application. PostgreSQL refuses to start under an administrator account on
Windows — correctly; it is protecting itself — and this shell is elevated.
`scripts/run-unelevated.ps1` drops privileges via `runas /trustlevel:0x20000`
(same user, administrators group disabled) and captures the output and exit code
that `runas` otherwise detaches. Verified before being relied on: the wrapped
command reports `Elevated=False` where the caller reports `True`.

**Nothing about the application was bent to make this run.** The connection pool
is untouched, `after()` is not stubbed, the handler is not bypassed, the database
is not mocked, and the production guard is intact — the server is *proven* to be
on the test database before a single webhook is sent, via a canary row read back
through `/api/cron/status`. `next dev` loads `.env` files, so without that check
this suite could have written orders into a live merchant's database.

### The defect it found

**A payment naming a product that no longer exists created no order at all.**

The code's own comment promised otherwise — *"the order is still created when the
product is missing — the money is real whatever the catalogue says"* — but it
wrote `productId` unconditionally, and `Order.productId` is a **foreign key**. A
deleted product violated it and the entire order was lost. Money taken, nothing
recorded.

The column is nullable and the relation is `onDelete: SetNull`, so an order
without a product was always the intended shape; the write simply never honoured
it. It now links only when the product genuinely exists in that store.

### What is proven

Thirty-two assertions about **database state**, not status codes — a 200 that
wrote nothing is the exact failure this audit has been chasing:

- One `Order` for the right store *and* product, the product's real name, the
  amount, the buyer's email, the charge id refunds match on, all five shipping
  fields recovered from metadata, and the address the customer typed.
- The `BusinessEvent` that commits **in the same transaction** — one without the
  other means the intelligence engine's view silently diverges from the money.
- Three replays of one event leave exactly one `Order` and one `BusinessEvent`,
  while a genuinely different session still creates a second.
- Unsigned, wrong-secret and tampered-after-signing payloads all 400 and create
  nothing. 400 is correct: a forgery is permanently bad and Stripe should not
  retry it.
- A deleted store is acknowledged (200) rather than retried to death.
- A cross-store claim lands in the attacker's own store, with no product borrowed
  from the victim and no dangling link.
- And a legitimate payment still succeeds after all of it.

**Harness note:** `reset()` retries on deadlock, because `after()` work is still
running when the next section truncates — `TRUNCATE` wants an
`AccessExclusiveLock` while the post-response sweep holds an `AccessShareLock`.
That is not flake-tolerance; it is the test racing work it deliberately
triggered, and it is incidental proof that `after()` genuinely executes.

---

## 35. The customer who paid was never told anything

Tracing every caller: the Stripe webhook committed the `Order` and scheduled
observation sweeps, the PayPal return committed and redirected, and **the only
customer email anywhere in the codebase was `notifyCustomerShipped`** — called
once, from the shipping-label purchase, which happens days later if it happens at
all. A customer paid, saw a success page, and then heard nothing.

`notifyCustomerShipped` is **not** misnamed and is **not** doubling as a
confirmation mechanism. That was worth checking and came back clean: one caller,
name matches. The problem was absence, not misuse.

### A fourth state

| field | axis |
|---|---|
| `status` | the money — paid / refunded |
| `fulfillmentStatus` | the owner's acknowledgment |
| `trackingNumber` | a label exists |
| **`confirmationSentAt` / `shipmentNotifiedAt`** | **the customer was told** |

The fourth had no representation at all. They are not interchangeable: an order
can be paid and unconfirmed, fulfilled without the buyer ever being emailed, or
confirmed and never shipped.

### Idempotency is a claim, not a check

`after()` runs on **every** webhook delivery, so a check-then-send would email
the customer again on each redelivery. The claim is a conditional update matching
only while the column is null — proven with three concurrent calls, exactly one
of which sends. A **failed send releases the claim**, so the next delivery
retries rather than the order being permanently marked as told when it never was.

Placement is load-bearing: the confirmation runs inside `after()`, which fires
after the response and therefore strictly after the transaction commits, so a
rolled-back order can never be confirmed. Inside the transaction it would risk
the opposite — an email about an order that then failed to commit.

The shipped notification got the same treatment; it had none, and the
label-purchase guard is a check-then-act, so two concurrent submits could send
two "your order shipped" emails for one shipment.

### Two defects found in this work itself

- **The tenant-isolation guard rejected the first version** — the claim was an
  `Order.updateMany` with no store scoping, and it was right to. The function
  takes the order/store pair now, so scoping is structural.
- A deleted order reported **`already_sent`**, which is a false statement, and
  precisely what an operator would read while working out why a customer never
  heard anything. It reports `not_found` now, which also covers a mismatched
  order/store pair.

### EXTERNALLY BLOCKED: delivery

**No email has been sent and nothing here claims one was.** There is no Resend
credential. The sender is injected — not to fake delivery, but because delivery
is the one part that genuinely requires it.

Everything up to handing a provider the payload is real and asserted against a
real Postgres: the decision to send, the recipient, the exact subject and body,
the claim, the release, the retry, the four-way state separation, and that one
tenant's customer never hears about another's order. What remains unproven is
strictly *"Resend accepted it and a human received it"*.

---

## 36. One parcel could be paid for twice

`purchaseShippingLabelExecutable` guarded on `order.trackingNumber` — but that is
written **after** the label is bought, and everything between the check and
`Shipment.buy` is awaited: a shipment creation, a rate fetch, a comparison. Two
concurrent submits both passed the check and both reached EasyPost. Real postage,
charged twice, for one parcel.

Fixed with the same claim pattern as the order confirmation — by this point a
proven shape in this codebase rather than a new idea. Released on failure so an
order cannot get stuck permanently unshippable, but **only while
`trackingNumber` is still null**: if the purchase succeeded and only the write
failed, the original guard refuses to buy again, and the two conditions together
are what make a retry safe rather than expensive.

**Worth naming as a pattern.** This is the third place in two days where a
check-then-act sat in front of something irreversible — the Growth Point
deduction (§23), the customer notification (§35), and now money at a carrier. All
three read as correct and all three had a window. It is worth recognising on
sight in review.

---

## 37. Checkout-session creation — audited adversarially, and it held

The half of the money route everything downstream trusts. `createCheckoutSession`
decides which store the money belongs to, which product, and what the customer is
charged; if a client can substitute any of it, the webhook faithfully records a
corrupted sale.

**No defect found.** Worth recording *why* rather than only that, because the
reasons are structural and easy to break later:

- **Cross-store products are impossible.** The lookup is
  `findFirst({ id, storeId, active })`, so a `productId` from another store
  resolves to nothing rather than to that store's product. Proven both
  directions — including the legitimate case of one owner running two stores on
  **one Stripe account**, where the `storeId` in metadata is the only thing
  keeping their sales apart.
- **The price is never client-supplied.** No code path reads an amount from the
  form; `unit_amount` comes from `product.priceInCents`, read server-side.
  Asserted by passing `priceInCents` and `amount` in the form and showing they
  change nothing.
- **Shipping cannot be priced by the browser.** `confirmSelectedRate` re-quotes
  EasyPost server-side and matches the chosen `rateId` against that *fresh*
  quote, taking the amount from the carrier's answer.
- **CONNECTED is the only status that can take money.** FAILED, NEEDS_ATTENTION
  and DISCONNECTED are each refused, with a message a shopper can act on.

**The join in the chain is now asserted**, which nothing covered before.
`createCheckoutSession` writes metadata the webhook reads hours later in a
different process, joined by nothing but string keys — a rename on either side
would fail no typecheck and silently produce orders with no shipping. Tested as a
**round trip** rather than a key comparison, because a key list can match while
the values are mangled.

**Externally blocked, not skipped:** the Stripe API call needs a Stripe test key,
and `confirmSelectedRate`'s re-quote needs an EasyPost key. Every guard in front
of both is proven against a real Postgres.

**Checked and found correct:** `amountInCents` stores `session.amount_total`,
which *includes* the shipping charged — and profitability computes
`amountInCents − productCost − postageCost`, so the shipping margin is counted
correctly rather than double-counted. That looked like a defect until traced.

---

## 38. A PayPal-only store sent shipping customers into a dead end

Found by auditing PayPal's checkout creation after Stripe's. **PayPal's own path
is sound** — `custom_id` and the amount are both server-derived from the store
and product, and it refuses unless the connection is CONNECTED. The defect was
next door.

`productSupportsLiveShipping` required EasyPost and a product weight. It did
**not** require Stripe — but `checkoutWithShipping` calls
`createStripeCheckoutSession` *directly* rather than going through
`selectProvider`, because a chosen service has to become a Stripe
`shipping_options` line.

So a store with EasyPost and PayPal but no Stripe passed the check. The
storefront showed the customer the entire live-shipping flow — type a full
delivery address, wait for real carrier rates, choose a service — and then the
buy failed with *"Something went wrong on our end."* **The customer did the most
work available and got the least useful error**, and the owner had no way to know
it was happening.

Gated on Stripe now, so those storefronts offer the ordinary checkout, which
works. The test proves the fix did not merely turn a broken path into a missing
one: adding Stripe turns live shipping back on, a FAILED Stripe connection does
not, and the weight precondition still stands alone.

**Not live today** — it needs EasyPost, still blocked on account verification —
but it would have been the first thing to break when that clears.

---

## 39. An order already in the post could be marked unfulfilled again

Buying a label marks the order fulfilled, records tracking, and emails the buyer
that it shipped. The Orders list then offered **"Mark as unfulfilled"** on that
same order, unconditionally — and it worked. The result: an order showing as
still needing fulfilment while the parcel was gone and the customer had tracking
for it. An invitation to ship the same order twice.

The label is the authoritative signal, so it wins. The refusal names the carrier
and tracking number, because an owner who clicked that button deserves to know
why. The button is gone from the UI for shipped orders too — offering an action
that throws is worse than not offering it — while marking fulfilled by hand
still works for orders shipped without a label, and *that* reversal still works,
since nothing has left the building.

**The toggle also trusted the caller.** `currentlyFulfilled` arrived from the
action, computed from a read taken before the page rendered, so a stale tab could
toggle against a status that had since changed. The executable reads the real
state itself now, and the field is **deleted rather than ignored** — a field
nobody reads is a trap for whoever next assumes it is authoritative. The write is
conditional on the state that was read.

### Proven, not reasoned about

- **Cross-tenant:** an authorised owner of store A naming store B's order id gets
  `Order not found` — both directions, on fulfilled and unfulfilled orders —
  while their own orders still work.
- **The Orders list** is session-scoped with **no filter, search or pagination
  parameter to manipulate**: its only `searchParams` are flash flags. Revenue is
  excluded from the query for roles without `REVENUE_VIEW` rather than hidden in
  the markup. The tenant guard refuses an unscoped list outright.
- **Missing orders:** invented id, empty id and deleted order all refuse.

### A correction worth recording

My first version of the concurrency section asserted that only one of two
toggles should take effect. **That is wrong** — two sequential toggles returning
to the start *is* a toggle, and the test was asserting a bug. It now asserts the
property that matters: the executable follows the database rather than any
caller's idea of it.

---

## 40. Refunds — three ways money left without anyone deciding

Money *in* was proven end to end; money *out* had never had an adversarial pass.
Three defects, none of which had any guard at all.

**Postage.** Nothing checked payment status before buying a label, so a fully
refunded order could still have a real one bought: **the customer keeps their
money and receives the goods, posted at the owner's expense.** Refused now —
and refused *before* the claim, so a refused attempt does not leave the order
locked out of shipping if it is later un-refunded.

**Fulfilment.** A refunded order could be marked fulfilled — committing to send
goods for money that had gone back.

**Revenue.** `getOrderSummary` summed `amountInCents` across every order
regardless of status, so the dashboard kept reporting refunded money as earned.
The **count** still includes refunded orders deliberately: one genuinely
happened, and hiding it would make a refund-heavy month look quiet rather than
troubled. Only the money is corrected.

**Profit** had the same shape but needed the opposite care. Excluding refunded
orders entirely would have been the mirror-image error — the product cost and the
postage were still spent, so a shipped-then-refunded order is a **real loss the
owner should see**, not a zero. Revenue goes to nothing; the costs stay.

**Deliberately still allowed:** an order shipped *before* it was refunded keeps
both facts. Goods went out and money came back; both happened. The label guard
still outranks any attempt to un-ship it.

### NOT MODELLED: partial refunds

`charge.refunded` only flips `Order.status` on a **full** refund, which the
handler's own comment has always named as a gap. The consequence is worth stating
plainly rather than leaving implied: a partially refunded order still reads as
fully paid, and **its full amount still counts as revenue and profit**. Genesis
has no field for a partial refund, so there is nothing to correct against.

**Deliberately not implemented, and awaiting Sean's approval.** Fixing it means a
schema change *and* a decision about how partial refunds should affect revenue
reporting — that is a product call, not one to make inside an audit. Recorded
here as a known divergence between money state and order state.

---

## 41. The other payment rail had never been run

*Connections roadmap, P0.3 — "PayPal as the second payment rail, via the existing
integration architecture, **same lifecycle guarantees as Stripe**" (VISION.md).
The Stripe rail was audited to that standard in §34, §37 and §40. The rail beside
it never had been, and the first end-to-end run of it found three defects.*

PayPal matters more than Stripe here, not less. Stripe has a webhook behind it:
when order creation fails, Stripe retries, and §34's permanent/transient split
decides whether that retry can help. **PayPal has nothing behind it.** Capture
happens synchronously in `app/api/checkout/paypal/return/route.ts` when the buyer
returns from PayPal's site, and if anything after the capture fails, no second
delivery is ever coming. Whatever that route drops is dropped for good.

`scripts/verify-paypal-live.ts` runs the real route handler against a real
Postgres. Only PayPal's own HTTP responses are supplied — that is the externally
blocked boundary, and it is the only thing substituted. The store and product
resolution, the transaction, the order, the business event and the confirmation
claim are all production code.

### A product deleted mid-checkout destroyed a real payment

`Order.productId` is a foreign key. The route wrote the `productId` out of
`custom_id` unconditionally, so if the owner tidied the catalogue while a buyer
was on PayPal's site approving, the write violated the constraint, the whole
transaction rolled back, and the buyer was redirected to `?payment_pending=1`.

Money captured. No order. No webhook to retry it. Nothing.

This is the same defect §34 found on the Stripe rail, and it was still live here
— which is the argument for running each rail rather than reasoning that the fix
must have generalised. Reproduced first (`0 orders`), then fixed the same way:
`productId: product?.id ?? null`, so the sale is recorded even when the catalogue
has moved on.

### Another store's product could be attached to a sale

The product lookup was `findUnique({ where: { id: productId } })` — no store
scope. The suite fed a `custom_id` pairing store A with store B's product, and
the order came back linked to the foreign product with **its name on it**:
`productName: "victim candle"`.

`custom_id` is built server-side, so no live path reaches this today. It is
recorded as a real defect anyway, because the only thing standing between an
unscoped lookup and a tenant leak was a value nobody had to keep trustworthy.
Now scoped to `store.id`, exactly as the Stripe rail is.

### A PayPal refund had nothing to attach to

`Order.externalPaymentId` exists precisely so a refund can find its order:
`externalOrderId` is the checkout-level id, and a refund arrives one level down —
the payment intent on Stripe, the **capture** on PayPal. The Stripe rail has
written it since the field was added. This rail never did.

So the schema's own guarantee was quietly true for one rail only, and a PayPal
refund could not have been reconciled even by hand. Now recorded from
`purchase_units[0].payments.captures[0].id`.

### What still is not there: PayPal refunds

Recording the capture id **unblocks** refund handling; it does not implement it.
`charge.refunded` has no PayPal counterpart in this codebase, so today:

- a PayPal refund never flips `Order.status`, so refunded money still counts as
  revenue and profit (§40's accounting fix is Stripe-only in practice)
- `purchaseShippingLabelExecutable`'s refund guard — the one that stops the owner
  posting goods to somebody who already has their money back — never fires for a
  PayPal order

This is **an engineering gap, not an external blocker**, and it is the next piece
of P0.3. It needs a design decision that touches Sean's own PayPal account, so it
is written up separately rather than built inside this section.

### The harness was not the database production runs on

Found while reproducing the first defect: the route tried to record the failure,
and the write itself failed with `22P05` — an arrow in the Prisma error message
had no WIN1252 equivalent. `initdb` had been taking its encoding from the Windows
host locale for every real-Postgres suite written so far.

Neon is UTF8. A harness that is not can pass what production would fail, and fail
what production would pass. Fixed at the source — `initdbFlags:
["--encoding=UTF8", "--no-locale"]` — rather than by avoiding the character, and
every existing real-Postgres suite was re-run on it: all still pass.

### Proven

| | |
|---|---|
| A real capture becomes a paid order, with the product, buyer and address | PASS |
| A deleted product no longer costs the owner the sale | PASS (was: 0 orders) |
| A foreign product is neither linked nor named | PASS (was: linked, named) |
| The capture id is recorded, so a refund can land | PASS (was: null) |
| A reload after paying creates one order, one event, one email | PASS |
| A capture belonging to another store is refused, and recorded | PASS |
| A declined capture never becomes a paid order | PASS |
| An unconnected store never reaches PayPal at all | PASS |


---

## 42. A PayPal refund now reaches Genesis

*The last piece of P0.3 — "refunds/status changes are handled". §41 recorded the
capture id, which gave a refund somewhere to land. This is the thing that lands.*

Before this, a PayPal refund changed nothing. Every consumer of that decision
reads `Order.status`, and nothing on this rail ever set it, so a refunded PayPal
sale kept counting as revenue **and the owner could still be told to post the
goods** — the guard that stops that (§36) reads the same field.

### Where the trust comes from

The store id is in the URL path, so **anyone can post to any store's endpoint**.
That is fine, and it is the design: the path is a *claim*, and the signature is
the *proof*. Each delivery is verified against the webhook id stored in **that
store's own credentials**, so a forged delivery naming any store fails, and a
genuine event for store A posted at store B's endpoint fails too — B's webhook id
is not the one it was signed for. The same shape as the Stripe rail, where
`event.account` is the claim and the signature is the proof.

The signature is checked against the **raw bytes**. The verification request is
assembled as text with the body spliced in rather than re-serialised from a
parsed object: PayPal signs what it sent, and `JSON.stringify` reproducing those
bytes is a convention, not a rule.

### Nobody has to paste a webhook id

PayPal webhooks are per-app, and each merchant here supplies their own app — so
the subscription is created **with the merchant's own credentials at connect
time**, and deleted at disconnect. A reconnect finds the existing subscription
(`WEBHOOK_URL_ALREADY_EXISTS`) and reuses it rather than failing.

When PayPal will not take the URL at all — a development host, an app that
refuses it — the connection still succeeds and the integration says so on itself:
*"Connected, but refunds will not reach Genesis… A refunded order will keep
counting as revenue until this is fixed."* Failing the whole connection over it
would trade a reporting gap for no payment rail at all. The connector's declared
capabilities were updated too: creating a webhook in the merchant's app is a real
write, and a capability list that omitted it would understate what connecting
does.

### Three answers, and why they are different

A webhook endpoint's status code is an instruction, and §32 is the record of what
happens when the wrong one is sent:

- **400 — forged.** The only branch that says it. Retrying an unverifiable
  delivery cannot make it verifiable.
- **404 — no webhook configured for this store.** *Not* 400. A store that
  connected before refund webhooks existed has done nothing wrong; PayPal keeps
  retrying, so reconnecting collects the backlog. Proven: the same delivery that
  got 404 lands as soon as the store reconnects.
- **503 — the order is not in the database yet.** The capture route writes the
  order *after* PayPal takes the money, so a refund issued moments later can
  genuinely arrive first. Inside a ten-minute window a retry is the fix. Outside
  it nothing is coming, so the answer becomes 200 plus a durable, owner-visible
  record naming the capture — retrying for three days would only delay somebody
  looking at money that has left the merchant's account.

### Partial refunds, on this rail too

Only a genuinely full refund flips the status, identical to the Stripe rail. What
is new is that the **cumulative** total is what decides: PayPal's
`total_refunded_amount` is used in preference to this refund's own `amount`, so
two halves add up instead of each looking partial forever. A refund that is still
genuinely partial leaves the status alone — the same named, deliberate gap
recorded in this document's close-out.

### Proven

`scripts/verify-paypal-refund.ts` — the real route, a real Postgres. Only PayPal's
`verify-webhook-signature` is supplied, and it answers SUCCESS **only** for the
webhook id an event was signed for, which is what gives the refusals below any
meaning.

| | |
|---|---|
| A verified full refund marks the order refunded | PASS |
| …and the owner can no longer post the goods at their own expense | PASS |
| A forged refund is refused, and changes nothing | PASS |
| A delivery with no signature headers never reaches PayPal | PASS |
| **The same event, properly signed, is accepted** (the positive control) | PASS |
| Store A's genuine refund is refused at store B's endpoint | PASS |
| A verified event naming another store's capture applies to nothing, and is recorded | PASS |
| No webhook configured answers 404, and the retry lands after reconnecting | PASS |
| A partial refund does not relabel the order | PASS |
| Two partials that complete the total do | PASS |
| Three concurrent redeliveries write once | PASS |
| A refund that beats its order asks PayPal to retry | PASS |
| An old one is recorded for reconciliation instead | PASS |
| A reversal is treated as a refund; other events are acknowledged, not acted on | PASS |

The positive control is the line worth keeping. Without it a suite can assert
`400` forever while the route refuses every delivery for some entirely unrelated
reason, and read as proof the whole time.


---

## 43. The subscription's own lifecycle

*§42 proves what happens when a refund arrives. This is the other half: whether a
store is in a state where one **can** arrive. Different question, and the one
every store connected before §42 gets wrong.*

### Two defects in the work from §42 itself

**Every already-connected store would have gone on losing refunds.** The
subscription is created at connect time, and nothing else would ever create one
— so a store connected last week keeps 404ing every refund while showing a
contented green *Connected*. Nothing in the system would have said so.

`verify()` is now the repair path, and it re-checks rather than assumes: if the
stored id no longer resolves at PayPal, or was never there, it creates one and
persists it. A **500** is explicitly not a **404** — "PayPal is having a bad
minute" must not be read as "this subscription is gone", or every wobble churns
a new subscription and leaves dead ones in the merchant's account.

**The subscription was being registered against the request's own host.**
`getBaseUrl()` derives the host from the request, which is right for an OAuth
redirect and wrong for anything durable: a merchant connecting from a preview
deployment would get a refund webhook pointing at that preview's hostname. It
works until the deployment rotates, and then their refunds stop arriving with
nothing anywhere saying why. Now resolved through `canonicalBaseUrl()`, which
prefers `VERCEL_PROJECT_PRODUCTION_URL` — present automatically on every Vercel
deployment, so it needs no new configuration.

### Proven

`scripts/verify-paypal-webhook-lifecycle.ts` — the real connector, a real
Postgres, PayPal's own subscription API supplied as a small stateful world so
"nothing was created" is as provable as "something was".

| | |
|---|---|
| Connecting registers a subscription for this store, on the canonical domain | PASS |
| Reconnecting reuses it rather than failing on `WEBHOOK_URL_ALREADY_EXISTS` | PASS |
| A refused subscription still leaves a working payment rail, and says what it costs | PASS |
| Verify repairs a store that connected before any of this existed | PASS |
| Verify replaces a subscription deleted at PayPal | PASS |
| An inconclusive lookup does not throw away a good one | PASS |
| Verify still fails when the credentials are the problem | PASS |
| Disconnecting deletes it at PayPal too | PASS |
| A subscription that will not delete never blocks disconnecting | PASS |
| One owner's two stores never share a subscription | PASS |

The last one is the tenant case in ordinary clothes: one PayPal app, two stores,
two subscriptions, each carrying its own store id — so a refund can only ever be
verified for the store it belongs to.

---

## 44. The customer paid for overnight and got five-day ground

*P0.4 — "Paid order → shipping address → label workflow → USPS → tracking number
→ shipped order". Audited as far as the EasyPost blocker permits, which turned
out to be far enough to find the worst defect on the path.*

### The defect

Checkout let the customer choose a shipping service and charged them for it. The
webhook faithfully recorded which one: `selectedShippingCarrier`,
`selectedShippingService`, `shippingChargedInCents`, `selectedShippingRateId`.

**Nothing ever read them.** The label purchase filtered the carrier's rates to
USPS and bought the cheapest, full stop. So a customer who chose Priority Mail
Express and paid $31.40 for it got Ground Advantage at $5.50 — the delivery
promise made to them quietly broken, and $25.90 landing in the store's margin
without anybody deciding that it should.

The same line held a second defect: `carrier === "USPS"`. A customer who chose
and paid for UPS Ground could never receive it. The purchase would buy a USPS
service instead, or — with no USPS rates on the table — fail claiming USPS
returned no rates for a shipment nobody asked USPS about.

Both are reproduced against the pre-fix implementation in
`verify-regressions.ts` §10.

### The fix, and the half that is easy to get wrong

`chooseRate()` buys the service the order says was paid for. Where the carrier is
no longer offering it, it **refuses** — it does not fall back to the cheapest.
Falling back is the original defect wearing a hat: it is exactly the behaviour
that broke the delivery promise, just reached by a more sympathetic route. The
refusal names what the customer paid for, what the carrier is actually offering,
and says plainly that nothing was bought, because the owner is the only person
who can resolve it.

An order that chose nothing — an ordinary checkout with no live shipping — still
buys the cheapest USPS rate, unchanged. There is no promise to keep, and no
consent to a different carrier.

Service names are compared through `humanService()`, the same normalisation
checkout showed the customer: `GroundAdvantage` at the carrier is
`Ground Advantage` on the order. Matching raw against stored would never hit,
which would have turned every live-shipping order into a refusal — a fix that
fails closed on all of them is not better than the bug.

### A seam, and what it is for

The carrier round trip moved into `lib/shipping/labelPurchase.ts` behind an
injectable `LabelBuyer`, the same shape and for the same reason as the order
confirmation's injectable sender (§35): the EasyPost HTTP call is the one part
of this path that genuinely needs a credential this environment does not have,
and keeping it inline meant **none** of the surrounding decisions could be
proven. The default buyer is the production path. The rate chooser inside it,
`selectRateForLabel`, is the real function and runs in the suite too — so what
gets bought, and when the purchase refuses, are proven rather than described.

### Proven

`scripts/verify-label-purchase-live.ts` — real Postgres, the real executable, the
real rate chooser.

| | |
|---|---|
| The service the customer paid for is what gets bought | PASS (was: the cheapest) |
| A non-USPS carrier is honoured | PASS (was: unbuyable) |
| An order with no selection still buys the cheapest USPS rate | PASS |
| A cheaper non-USPS rate is not substituted in where nothing was chosen | PASS |
| A service the carrier will not sell is refused, naming what is available | PASS |
| …and the claim is released, so the retry buys the right service | PASS |
| No rates at all is a different failure, and says so | PASS |
| A refunded order is refused before the carrier is asked anything | PASS |
| No weight, no address, no ship-from address: all refused before any spend | PASS |
| Three concurrent submits buy one label | PASS |
| One store cannot buy postage against another's order | PASS |

### EXTERNALLY BLOCKED

The EasyPost HTTP call itself, and therefore whether a real carrier returns the
rates this suite's table describes. Needs EasyPost account verification. Nothing
else on P0.4 waits on it.

### Also true, and not a defect

The owner still types the parcel's weight at label time rather than it coming
from `Product.weightOz` — deliberate, since the person holding the box knows
what it weighs and the quote's weight was an estimate. Worth knowing that the
label can therefore be for a different parcel than the one quoted.

---

## 45. The catalog, as the base of something

*P0.5 — the real product catalog, and Sean's own framing for it: the foundation
of Genesis's future product-discovery system, not a static list. Multiple
sources, print-on-demand held apart from wholesale, and room for J4 to recommend
from what it understands about the business. Designed and evidenced in
`PRODUCT_SOURCING.md`; this section is the audit record.*

Three things were missing before recommendation could sit on anything.

**Nothing recorded where a product came from.** `Product.fulfillmentProvider`
answers a narrower question — which connector it arrived through — and is null
for everything Cubit & Coil sells, because Sean makes the rings himself. So an
owner-made product and a dropshipped one were indistinguishable, and they differ
in ways the code already acts on: who buys the shipping label, whether there is
stock, whether "customise this" means anything.

**The supplier abstraction only fitted one shape.** `FulfillmentConnector` is
built around applying artwork to something that does not exist yet. Wholesale is
the structural opposite. Forcing it through would have meant lying about the
image or making every field optional on a contract that is currently honest.

**Discovery did not survive the request**, so a suggestion the owner had already
turned down was indistinguishable from one Genesis had never raised.

### Two defects found in this work itself

Both by its own suite, before anything shipped, and both recorded because the
alternative reading is that the design was right first time.

**An unrelated product could be recommended on a fact about the supplier.**
Customisation fit was a scoring term like any other, so a phone case with no
connection to a copper-ring business scored positive on it alone and would have
been raised with *"your own artwork can go on it"* as its entire justification —
a sentence about Printful wearing the costume of a recommendation. Relevance is
now a **gate**: signals that connect the candidate to the business are summed
first, and if that total is zero, nothing is said. Modifiers can never be the
reason something is suggested.

**An exact duplicate of the store's best seller scored positive.** The
already-selling penalty was −20 against a relevance total that reached +24.
Recommending something the owner already sells is the clearest possible signal
that nothing was understood, and it cannot be outweighed by how relevant the
thing is — being relevant is precisely why it is already in the catalogue. Now
disqualifying rather than penalised.

A third was caught during the build: adoption derived the fulfilment provider as
`createsListings ? "PRINTFUL" : null`, correct exactly until a second print
partner exists, at which point every product from it would have been labelled
Printful and handed to Printful's order routing. Each source now declares its own,
and it is recorded on the candidate so adoption never re-resolves it.

### A modelling decision worth recording

`SourcedProduct.externalVariantId` is **NOT NULL with `""` meaning "this source
has no variants"**. Nullable was the natural modelling and wrong twice: Postgres
treats NULLs in a unique index as distinct, so every re-run of discovery would
have inserted another copy of every variant-less candidate — which is every
wholesale listing — and Prisma cannot target a compound unique containing a
null, so the upsert that makes discovery idempotent could not have been written.
The sentinel converts back at exactly one place.

### Proven

`scripts/verify-sourcing-live.ts` (real Postgres, the real pipeline) and
`scripts/verify-product-sourcing.ts` (pure).

| | |
|---|---|
| Discovery holds print-on-demand and wholesale at once, kept apart | PASS |
| Every suggestion carries reasoning in the business's own words | PASS |
| Three runs produce two rows; a changed price corrects in place | PASS |
| A dismissal is respected next run, and blocks adoption | PASS |
| Adoption carries sourceKind, sourceKey and the supplier's ids onto the Product | PASS |
| …and claims no fulfilment partner where there is none | PASS |
| Two clicks, and three concurrent adoptions, produce one product | PASS |
| One store cannot adopt or dismiss another's suggestion | PASS |
| A blocked source is named and contributes nothing | PASS |
| A failing source is a provider error, not a configuration one | PASS |
| A candidate claiming another source's key is dropped | PASS |
| Deleting an adopted product does not erase the record of finding it | PASS |
| Nothing worth saying is nothing written down | PASS |
| Products that predate all of this are OWNER_MADE with no source | PASS |
| A source declares its capabilities; none is inferred from its name | PASS |
| A blocked source refuses rather than returning an invented catalogue | PASS |
| An unknown cost is never reasoned about as a zero | PASS |
| A store Genesis knows nothing about gets no suggestions at all | PASS |

### UNVERIFIED

- **Printful's real catalogue through the new adapter.** The connector beneath it
  was validated live against Printful's API when written; the adapter has not
  been run against a connected store.
- **`buildSourcingContext` against a real store's understanding.** The scorer is
  proven against contexts; the projection that builds them is not.

### EXTERNALLY BLOCKED

- **AliExpress** — `ALIEXPRESS_APP_KEY` / `ALIEXPRESS_APP_SECRET`. Registered,
  and refuses rather than inventing a catalogue.
- **Printful** — a store with Printful connected, to search anything at all.
- ~~**The migration is not applied to production.**~~ **Wrong when written** — it
  was already applied by the Vercel build. Corrected in §46, along with the
  reason this document believed otherwise.

### NOT MODELLED — deliberately, and named

Variants beyond one representative per candidate; inventory, including for
`WHOLESALE_STOCKED`, which is an honest shape with no quantity behind it;
automatic order routing to a supplier, which stays the explicit non-goal it has
been since `ONBOARDING_V2_DESIGN.md`; and any owner-facing surface — there is no
discovery screen, because interface work needs a confirmed design first.

---

## 46. The migration gate had been gone for a week

*Found while trying to apply a migration deliberately. The instruction was to
apply `20260820060000_product_sourcing` to production as a separate, reviewed
step, exactly as `DEPLOYMENT.md` describes. Reading the production database to
do it showed it **already applied** — by the Vercel build triggered by the push
that added it.*

### What is actually true

`package.json`:

```
"build": "node scripts/migrate-deploy.mjs && next build"
```

`5002093` (2026-08-01, Track 0) removed automatic production migrations, for
reasons that are still all true: no staging, no review step, no human in the
loop, and real customer and order data on the other end. `a2a05bf` (2026-08-13)
put them back, and `db27a05` later moved them onto the unpooled connection to
fix a genuine advisory-lock problem. Both were reasonable changes on their own
terms. **Neither updated `DEPLOYMENT.md`**, which went on describing the gate as
in place for a week — including a paragraph asserting that applying a production
migration "genuinely requires a real human with Neon console access — not
something I (or any agent) can complete unassisted, even in principle."

That paragraph's premise is still true: the production `DATABASE_URL` is a
Vercel Sensitive variable and reads `[SENSITIVE]`, verified again today. Its
conclusion is not. Nothing has to read the credential — a push applies the
migration.

### This document was wrong too

§45 recorded, under EXTERNALLY BLOCKED: *"The migration is not applied to
production."* It was applied before that sentence was written. The claim was
inherited from `DEPLOYMENT.md` rather than checked against the database, which
is precisely the failure mode this document's own opening rule exists to stop —
*code that looks like it supports something is not evidence that it does*, and a
document that says something is not evidence either.

Corrected in place rather than quietly amended: the entry now says the migration
is applied, and how it got there.

### The migration itself, verified against production

Read directly from the production database, not inferred from a green build:

| | |
|---|---|
| `ProductSourceKind` | `OWNER_MADE, PRINT_ON_DEMAND, WHOLESALE_DROPSHIP, WHOLESALE_STOCKED, DIGITAL` |
| `SourcedProductStatus` | `SUGGESTED, DISMISSED, ADOPTED` |
| `Product.sourceKind` | NOT NULL, default `'OWNER_MADE'` |
| `Product.sourceKey` | nullable text |
| `SourcedProduct` | all 21 columns present, correct nullability |
| Indexes | primary key, the unique discovery key, and the `(storeId, status, score)` index |
| Existing products | 55, **all** reading `OWNER_MADE` — nothing rewritten |
| `SourcedProduct` rows | 0 |

The migration is additive and did exactly what it said. That is not the finding.

### The finding

**Every push to `master` migrates the production database with no review step**,
and the only document describing how that works said the opposite.

Deliberately **not** changed back. The reasons the gate was introduced have not
changed, but the reason it was reversed is not recorded anywhere, and quietly
re-removing a build step somebody added three weeks after removing it the first
time is how a project ends up flip-flopping on a safety property nobody is
actually deciding about. It is on the **Action required from Sean** list as a
decision.

Two things worth weighing if it does come back: the advisory-lock problem
`db27a05` fixed was real and a manual path has to keep that fix; and code and
migration deploying together is currently the *only* thing making the
"migration first, then the code that depends on it" ordering true, so removing
it reintroduces an ordering somebody has to get right by hand.

---

## 47. Six clicks, six products

*A defect in §45's own adoption path, found by its own suite — on a **re-run**,
having passed the first time. Recorded because a race that only sometimes loses
is the kind that ships.*

### What was wrong

Adoption claimed the candidate and created the product in two separate
statements:

```ts
const claimed = await prisma.sourcedProduct.updateMany({
  where: { id, storeId, status: { not: "ADOPTED" } },
  data: { status: "ADOPTED" },
});
if (claimed.count === 0 && candidate.status !== "ADOPTED") {
  const winner = await /* read adoptedProductId */;
  if (winner?.adoptedProductId) return { ok: true, ... };
}
// ...and then created the product regardless
```

The loser of the claim **fell through and created anyway** whenever the winner
had not yet written `adoptedProductId` — a window that is open for exactly as
long as a product insert takes. Three simultaneous adoptions produced three
identical products in the owner's catalogue.

The claim itself was correct. What was wrong was treating "somebody else won"
as a condition to check rather than a path that ends.

### The fix, and why the lock does the work

Claim and create are now one transaction. A second caller's conditional update
**blocks on the winner's row lock**, then re-evaluates its predicate against the
committed row and matches nothing. By the time a loser sees `count === 0`, the
product id it needs is committed too, because both writes belong to the same
transaction. There is no window left to fall through.

The predicate is deliberately not `status != ADOPTED`. A row whose product was
later deleted is still ADOPTED with a null `adoptedProductId`, and that genuinely
should be adoptable again — so the condition is *not adopted, **or** pointing at
nothing*.

A loser that finds no claim and no product now refuses rather than creating a
second one. A duplicate in the owner's catalogue is worse than a retry.

### Proven

The test that found it now runs six concurrent adoptions, five times over, so a
regression fails reliably rather than eventually:

| | |
|---|---|
| Six concurrent adoptions, five rounds: exactly one product each time | PASS (was: 3 products from 3 callers) |
| Every caller that succeeded points at the same product | PASS |
| At least one caller succeeds — the fix does not deadlock them all | PASS |
| Re-adopting after the product was deleted still works | PASS |

The whole suite was then run three times end to end, clean each time.

### Worth saying plainly

Every other claim-then-act in this codebase — Growth Points, the order
confirmation, the shipping label, the customer notification, the PayPal refund —
puts the claim and the effect far enough apart that the same question applies to
each. Those were reviewed when this was found. They differ in one way that
matters: their effect is idempotent or externally keyed (an email that has
already been sent, a label that already has a tracking number), so a fallthrough
produces a duplicate *attempt*, not a duplicate *row*. This one created a row,
which is why it was the one that showed.

---

## 48. One account, more than one business

*Audited against the requirement that a Genesis account holds several businesses,
each with its own identity, vision, catalogue, sourcing relationships and J4
understanding. The data model already allows it. The application does not, and
the gap is one function.*

### What is genuinely independent already

Every one of these is keyed by `storeId`, verified by reading the schema rather
than trusting the comments on it:

| | |
|---|---|
| Identity, brand positioning, blueprint, creative direction | `Store` |
| Sourcing relationships | `StoreIntegration.storeId` |
| Catalogue, orders, discovery | `Product`, `Order`, `SourcedProduct` |
| Growth Points balance | `GrowthPointTransaction.storeId` |
| Plan | `Store.planId` |
| J4's understanding | `getBusinessUnderstanding(storeId)` |

Nothing about the domain assumes one business per account. That is the good news
and it is most of the work.

### What does not work

**`resolveUserStore` picks the most recently updated store**, and **28 of the 29
protected call sites in the app use it implicitly** — `requireStorePermission()`
with no `storeId`. There is no route segment carrying a business, no session
field holding one, and no switcher anywhere in the interface.

So today a second business is not a business you can be *in*. It is a row that
becomes "the" business the moment anything touches it. Editing a product in
business B silently moves every unrelated screen — orders, connections, billing,
J4's understanding — to business B. That is not a switcher; it is a side effect
that happens to look like one.

The function says so itself: *"mirrors the app's existing one-store-per-user
assumption"*. The assumption was accurate when it was written.

**`StoreDraft.userId` is `@unique`**, so an account can have only one business
being created at a time. A second business cannot be started while a first is
still in the onboarding flow.

### Latent, not live

Read from production directly: **16 accounts, every one with exactly one
business**, and zero `StoreMember` rows. Nobody is affected today. The first
account to hold two is the one that finds out.

### A recommender defect this found

Writing the two-businesses-on-one-account test surfaced a real false positive.
A foam roller described as a *"tool for training at home"* was **recommended to a
hand-poured candle business**, because that business is filed under *Home* and
the word matched.

Category was a fourth relevance signal, alongside the owner's own words, what
already earns, and the rest of the catalogue. It should never have been:
matching a category is not understanding a business — which is the distinction
the whole recommender exists to hold. It is now a **modifier**, able to sharpen a
judgment that already stands on its own and never to create one.

The same change fixed a second, quieter problem. `knowsTheBusiness` counted a
category slug as understanding, so a business that had picked *Home* and said
nothing else would have been told a product "doesn't fit the brand you've
described" — about a brand nobody had described. A category alone now yields
`unknown`, which is the honest answer.

Two accounts made this invisible: different owners, different everything, and a
weak match still looks like a match. One owner with two businesses is where a
shallow signal stops hiding.

### Proven

`scripts/verify-sourcing-live.ts` §16 — one account, two businesses, real
Postgres:

| | |
|---|---|
| Each business is understood in its own words, with its own positioning | PASS |
| The same supplier listing fits one and is **ruled out** of the other | PASS (was: recommended to both) |
| Separate rows and separate reasoning for the same external listing | PASS |
| Connecting a supplier to one business does not connect it to the other | PASS |
| Adoption reaches one catalogue and not the other | PASS |
| One business cannot adopt the other's suggestion — same owner, same account | PASS |

And in `verify-product-sourcing.ts` §7a: a category word alone never makes
something relevant; a category still confirms a judgment that stands on its own;
a business that has only picked a category is `unknown`, not judged.

### Fixed here

`rewardReferralIfEligible` took `stores[0]` from an unordered `take: 1` — whichever
row Postgres returned first. Points are per business, so on an account with two
it credited an arbitrary one. Ordered to match `resolveUserStore`, which is a
defensible answer rather than a correct one, and the reason the real answer has
to stop being a convention repeated at each call site.

### NOT MODELLED — and this is the part that needs a decision

**Which business am I in?** There is no answer today, and inventing one touches
routing, sessions, navigation, onboarding and J4's own sense of who it is talking
about. It is an architecture decision, not a defect to quietly fix, and it is
proposed rather than built — see the discovery proposal's own section on it.

Nothing in this audit changed how the store is resolved. Twenty-eight call sites
depend on that behaviour and changing it silently is how an owner ends up editing
the wrong business's products.

---

## 49. Which business am I in

*Business context made a first-class concept. Not a patch to the old resolver —
the old resolver was a heuristic doing an architecture's job, and the fix is the
architecture.*

### The audit

Forty-seven call sites resolved "the" business implicitly: 28 server actions and
route handlers through `requireStorePermission()` with no id, and 19 more calling
`resolveUserStore` directly. Every one of them got **whichever store had been
updated most recently.**

So a second business never had to be chosen to become the active one. It only had
to be *touched*. Sorted by what it would have cost:

| Surface | What attaches to the wrong business |
|---|---|
| **Billing** | `subscribeToPlan` — a real subscription, charged against whichever business was written to last |
| **Growth Points** | `purchaseGrowthPoints` — real money, credited to the wrong balance. Points are per business |
| **Connections** | `disconnectIntegration` — a supplier disconnected from a business nobody chose |
| **Products / Orders** | writes land in the wrong catalogue and the wrong order list |
| **J4 understanding** | the chat, the voice route and the recent-messages route all resolve this way — J4 would be reasoning about a business the person is not looking at |
| **Uploads** | product images and business assets attach to the wrong business |
| **Analytics / recommendations** | read the wrong business's numbers and advise on them |

Latent, not live: read from production, **all 16 accounts hold exactly one
business.** Nobody has been affected. The first account to hold two is the one
that would find out, and it would find out by being charged.

### The rule

> **Authorization context must be explicit. A navigation default may be
> remembered. Recency is never either.**

Those are different things, and collapsing them is what caused this. *Where
should I send someone who just opened the app* is allowed to be a remembered
preference. *Which business does this write belong to* is not allowed to be a
preference at all — it is stated, or unambiguous, or the question gets asked.

`lib/businessContext.ts` has three outcomes and no fourth:

- **resolved** — stated explicitly, or the account has exactly one, or the person
  deliberately switched to it
- **ambiguous** — more than one and nothing says which. **Not a guess.** Callers
  ask
- **none** — no business yet, an ordinary state for a new account

`Store.updatedAt` appears nowhere in the file. That is the point.

### Authorization boundaries

One definition of reach, and everything derives from it: **owner or member.**
`accessibleBusinesses` and `accessTo` are the only places that decide, so
ownership and membership can never drift apart in one call site and not another.

Two properties that are easy to get wrong and are asserted:

- **A named business the account cannot reach is refused, never substituted.**
  Succeeding with a different business than the one asked for by id is worse than
  failing, because it succeeds.
- **An owner who is also a member of their own business is still an owner.**
  Taking the lower role would quietly demote them.

### Migration strategy

`20260820070000_active_business` is additive plus one deterministic backfill.

Every account owning **exactly one** business gets it as its active one — not a
guess, the only answer, and the same answer the old lookup was already giving.
Employees belonging to exactly one, likewise. An account with **more than one is
left NULL on purpose**: there is no correct answer, and inventing one in a
migration would be the exact recency guess this change exists to remove.

Both statements only touch `NULL`s, so re-running never overwrites a real choice.

The backfill was not reasoned about — it was **run against real rows** covering
all four account shapes (one business, two businesses, employee-only, empty) and
asserted, including that a re-run is a no-op.

### Keeping the ambiguous branch unreachable

Handling ambiguity is not the same as avoiding it. Business creation now calls
`adoptNewBusiness`, so an account making its second business is *working in it*
rather than landing in a state where nothing can proceed. Ambiguity is reachable
only if a business is created outside that path — and then it fails closed.

`resolveUserStore` survives as a thin adapter for its 19 callers and returns
`null` on ambiguity. **Failing closed, not picking**, is the property that
matters for the sites not yet migrated.

### A guard that was right, and a map that was incomplete

`accessibleBusinesses` needs `StoreMember.findMany({ where: { userId } })`, and
the tenant-isolation guard refused it — correctly, on its own terms: an unscoped
`findMany` on `StoreMember` does leak other tenants' rows.

What was wrong was the map, not the rule. `userId` is a required column, so
filtering by it bounds the read to one person's own membership rows and leaks
nothing — the same dual-key shape `productEvent` and `aiUsageEvent` already carry,
and for the same reason. Added, with a test asserting that **widening the map did
not widen the rule**: every bypass closed for `storeId` (negation, `notIn`, bare
presence, an OR with one unscoped branch) is still closed for `userId`.

Working around the guard with the unguarded client would have been faster and
would have removed a real protection to avoid a five-line change.

### Proven

`scripts/verify-business-context-live.ts` — real Postgres, ten sections:

| | |
|---|---|
| A business never becomes active by being touched — edited, published, product added | PASS (was: silently switched) |
| More than one with nothing chosen is a question, not a pick | PASS (was: picked) |
| Switching is explicit, durable, and symmetrical | PASS |
| Creating a business makes it the active one | PASS |
| A named business wins; one you cannot reach is refused, not substituted | PASS |
| Employees reach only what they belong to; an owner-member is still an owner | PASS |
| A deleted business clears the pointer; a revoked membership does not dangle | PASS |
| Products, orders, connections and Growth Points all follow the active business | PASS |
| The permission layer refuses rather than picking | PASS |
| The migration's backfill, run against all four account shapes | PASS |

And `verify-regressions.ts` §11 reproduces it against the pre-fix implementation:
the old resolver returns the touched business, the new one does not.

### Confirmed in production

Read from the production database after the deploy, not inferred from a green
build:

| | |
|---|---|
| `20260820070000_active_business` | applied, finished |
| `User.activeStoreId` | text, nullable |
| `User_activeStoreId_fkey` | on delete **SET NULL** |
| Accounts owning exactly one business | 16 |
| Accounts with an active business set | **16** — every one backfilled |
| Accounts pointed at a business they cannot reach | **0** |

The last row is the one worth checking rather than assuming: a backfill that set
a pointer to a business the account has no access to would have created exactly
the authorization gap this change exists to close.

### Remaining architectural risk

**The 47 call sites still resolve implicitly.** They are now *safe* — explicit
where a pointer exists, unambiguous where there is one business, refusing
otherwise — but "which business" is still an ambient fact rather than something
each call site names. The URL carries no business, so two tabs on two businesses
are impossible and a link cannot address one.

That is the next step, and it is deliberately not taken here: a route migration
across 28 screens plus a real onboarding change (`StoreDraft.userId` is unique,
so an account can only have one business *being created* at a time). None of it
is required for correctness today; all of it is required before a business
switcher is worth building.

---

## 50. J4 was talking about the wrong business

*Found by the real browser session, and by nothing else. Every suite in this
document asserts on resolution and authorization; this took a rendered page.*

### What was wrong

`J4Surface` is rendered by the workspace shell, so it appears on **every** screen
— including every screen under `/b/[slug]`. It resolved the account's **active**
business rather than the one being viewed.

So an owner opening Copper & Coil saw J4's tasks, ideas, decisions and
information **for Iron Gym**. The observation that gave it away, rendered on
`/b/copper-and-coil/website`:

> *"Your store is live, but the only product is a placeholder (named
> ZZTOPBARBELL, description just "d", no photo)…"*

ZZTOPBARBELL is the other business's product.

**Nothing in the database was wrong, and no authorization was bypassed.** Every
row was correctly scoped to the business it belonged to. This read the wrong
business — the same class of defect as a leak, and just as visible to an owner.

### Why nothing else caught it

Every other suite asks *which business does this resolve to* and *may this
account reach it*. Both answers were correct here. The defect was in what a
**rendered page** showed, and only a browser can see that.

The browser session was the argument for the browser session.

### How it was found, and the two wrong turns on the way

Worth recording, because both were mine and both would have hidden it.

**The first assertion was on `body.innerText`.** Every positive check failed and
every "the other business is not here" check passed — both for the same reason.
J4's surface is a fixed layer over the workspace, so the section beneath it
renders but is not *visible* text, and `innerText` returned neither business's
products. **A negative assertion that passes because nothing rendered is worth
nothing.** Switched to the page's own markup, which is the right thing to read
when the question is *which business's data reached this page*.

**Then five sections failed and two isolated probes could not reproduce it.** The
temptation at that point is to call it flaky and move on. The reproduction needed
the full sequence, because J4's content is generated live — this server has a
real `ANTHROPIC_API_KEY` — and only exists once enough pages have been visited.
The match context, captured rather than guessed at, named the surface directly.

### The fix

`J4Surface` takes the business it was rendered inside. The workspace passes it,
and the `/b/[slug]` layout supplies it. The legacy route passes nothing and
resolves the active business, which is correct there — it has no slug to be told
about.

### Proven

`scripts/verify-business-browser.ts` — a real Next server, a real Postgres, a
real browser, a real sign-in through the login form:

| | |
|---|---|
| Signing in through the real form | PASS |
| A URL naming a business shows that business, beating the active one | PASS |
| Another account's business is a 404, not a substitution | PASS |
| An invented slug is the same answer | PASS |
| **Two tabs, one account, a different business in each, three rounds** | PASS |
| All 15 sections render inside a business | PASS |
| No section shows the other business's data | PASS (was: 5 did) |
| The legacy route still works and shows the active business | PASS |

### What this suite deliberately does not assert

Anything about J4's generated text itself. It is model output, different on every
run, and an assertion over it would mean something different each time. What is
asserted is the deterministic half: which business's data reached the page.

---

## 51. Everything could be decided, and nothing could be known

*Not a defect. A gap of exactly the shape that produces one — recorded because
the system was, for a fortnight, correct and useless at the same time.*

### What was wrong

Units 1–12 built a progression engine that reasons about minimum orders, bulk
prices, margins, payback periods and affordability. All of it verified, all of it
correct.

In production it fired on nothing. No supplier this platform can reach states
bulk pricing, so `bulkTerms()` resolved to nulls, so `assessFeasibility` returned
`cannot_assess`, so **every deepen move in production was an unblock**. The
system was behaving exactly as designed, and the design was honest about it:
faced with unknown economics it said *"I can't tell you"* rather than guessing.

The honest failure is still a failure. An owner who has sold sixty of something
sees "I don't know what this costs" and nothing else, forever.

### The tempting fix, and why it was refused

There is an obvious way to make the whole engine light up: default a missing
minimum to 1, or derive a bulk price as some percentage off the unit cost.

Both invent a number about somebody's money. A defaulted minimum of 1 does not
read as a guess on the screen — it reads as *"you can buy one"*, and the owner
finds out it was 500 when they try. I2 and I11 exist for exactly this, and the
whole point of a stated-provenance model is that there is nowhere for an invented
figure to hide.

### What was built instead

Somewhere for real numbers to live, three ways for them to arrive, and one way to
say there are none. See `PRODUCT_PROGRESSION.md` §C for the model.

The load-bearing one is the least technical: **`ownerStatesEconomics`**. Somebody
rings their supplier, asks two questions, and types in the answers. No connector,
no API, no waiting for a supplier integration that may never exist. The move
changes from a question into a recommendation the moment they do.

Which makes the unblock's wording part of the mechanism rather than decoration.
*"I don't know the minimum order"* is a fact about Genesis. *"It decides what
buying in bulk would actually cost you up front"* is a reason for a person to
pick up the phone. `ECONOMICS_GAP_EXPLANATION` is that second sentence, and it is
the only reason the first sentence is worth showing.

And when the answer is *there is no answer*, that is recorded too. `UNAVAILABLE`
resolves to nulls but is not itself null — so J4 asks *"can you find another
supplier?"* rather than asking the same question again next week.

### Status

**VERIFIED** — `scripts/verify-economics-live.ts`, real Postgres.

Seven sections, of which two are the point:

- **Identity is all four parts.** Two suppliers sharing one external id keep
  separate terms; a variant-less listing does not match the first variant of
  something else; another business sees none of it.
- **The whole journey, in one test.** No capital, no sales, no stock → J4
  recommends something that costs nothing up front → sixty real sales → the
  product earns rung 1 → J4 asks the one question it needs → the owner answers →
  `not_yet`, with the real shortfall → the owner reinvests what they earned →
  `recommended_now` → accepted, and the product is theirs at 410 instead of 980.

  Asserted at every step: **capital was never inferred from the revenue.** The
  business took $1,080 and its posture stayed `unstated` until a person said
  otherwise.

---

## 52. Stored, read, and then thrown away

*Four gaps I named myself at the end of §51 and then closed. Recorded because
three of the four are the same defect wearing different clothes: something the
system knew, and did not use.*

### Decorative columns

`shippingPerUnitInCents`, `leadTimeDays` and `requiresCapabilities` were written
to the database, selected back out, and discarded one line before
`assessFeasibility` — the only function that could have used any of them.

That is worse than not storing them. A column that exists reads as a fact the
system accounts for. An owner told an order costs $410 would have been told the
same thing whether or not somebody had recorded that delivery adds $6,000 to it.

What each does now is in `PRODUCT_PROGRESSION.md` §C4. The one worth restating:
**lead time is part of payback**, because the clock starts when the money leaves,
not when the boxes arrive. A supplier who takes four weeks to ship is four more
weeks of an owner's money sitting in transit.

### The judgement call, named rather than buried

Unknown shipping could have blocked. It does not.

Requiring it would have sent every stocked recommendation back to
`cannot_assess` — the exact paralysis §51 was written about — over a delivery
charge that is usually a fraction of the order. So the total is computed from
what is known and marked as a **floor**: the owner reads *"at least $410"*, never
a bare total claiming a completeness it does not have.

This is the one rule in the economics layer I decided rather than derived, and it
is recorded in the open-questions list as mine.

### Broken data that looked like good data

`parseTiers` returned null on anything malformed, and `bulkTerms` then fell
through to the flat `unitCostInCents` in the same row. So a corrupt price-break
table produced a confident 100 x 410 with nothing indicating the price breaks
were nonsense.

Now an unusable record quotes **nothing at all** — including the flat figures
beside it, and including the discovery row that would otherwise have been the
fallback. The owner gets *"what's recorded doesn't add up, so I've stopped using
it rather than quote you a figure I can't stand behind"*; whoever maintains the
connector gets the store, the source, the product and the specific problem.

The true contradiction, worth naming because it is not obvious: **two different
prices for the same quantity**. There is no way to know which an order of that
size would be charged, and picking either is picking a number about somebody's
money at random. A bigger order costing *more* per unit is not rejected — that is
odd, not contradictory, and Genesis does not know the supplier's business better
than the supplier does.

### A timestamp nobody read

`statedAt` was written from day one and read by nothing. A quote obtained in
February and one obtained this morning were the same fact to the engine.

**Stale data qualifies; it does not block** — the reasoning is in
`PRODUCT_PROGRESSION.md` §C3, and the short version is that replacing a slightly
old truth with "I don't know" is strictly less true. The caveat survives all the
way to `recommended_now`, deliberately: the outcome that actually causes somebody
to spend money must not be the one that says least about where its figures came
from.

### And the write path that did not exist

`stateEconomics` took provenance as an argument, so any caller could write any
provenance anywhere. Two rules that were written down in §C the day the table was
created were enforced by nothing.

Both are now structural rather than checked. `ingestFromSupplier` takes one
`sourceKey` for the batch and stamps it onto every record — the records have no
such field, so there is no code path by which one supplier's sync reaches
another's row. And a catalogue sync that would overwrite an `OWNER` figure is
refused and reported as `preserved`, because an owner's answer has to be
re-asked, not refreshed.

### Status

**VERIFIED** — `scripts/verify-economics-ingest.ts` (6 sections) and
`scripts/verify-economics-live.ts` (11 sections), both against real Postgres,
plus the full regression.

Malformed tier data is tested by writing it **past** the validator with raw SQL,
which is the only way it can exist: an import, a migration, or a connector
written before the validator did. Six shapes, each asserted to quote nothing and
to name itself in a diagnostic — and one assertion that the plausible figure
sitting in the discovery row never appears in what the owner is shown.

---

## 53. A question with nowhere to send the answer

*The gap I named at the end of §52 and then closed. Not a defect in anything
built — a defect in what it added up to.*

### What was wrong

Everything worked and nothing was reachable. `nextMoves` produced exactly the
right question — *"what would this cost you to buy in bulk, and how many would
you have to order?"* — and a repo-wide search found no caller outside
`lib/sourcing/` and `scripts/`. The question was a sentence with no destination,
and the only way to answer it in production was for a developer to open a
console.

So the honest state of the economics layer was: correct, verified, and inert.

### What was built

The loop, and nothing beside it. `PRODUCT_PROGRESSION.md` §C5 has the diagram.

**No second mechanism at any step**, which was the constraint that shaped every
choice:

- **The question is a `Task`** — where everything else Genesis needs from an
  owner already lives. `requiredInput` and the `AWAITING_INPUT` status had been
  in the schema since M1 and written by nothing; `requiredInput` now has its
  first real producer. A separate table for "questions about suppliers" would
  have been a parallel inbox nobody merges.
- **The answer is a registered action** rather than a direct write, so it gets a
  permission check, an `ExecutionLog` row and an actor. A supplier's terms decide
  whether Genesis tells somebody to spend thousands; *who told us this, and when*
  has to be answerable afterwards.
- **The fact is stored by `recordOwnerQuote`**, unchanged in everything but one
  respect, below.

### The tier, locked for the opposite of the usual reason

`answer_supplier_economics` is `always_ask` with `maxAuthorityTier: always_ask`.

Every other lock in the registry is there because the change is too visible or
too irreversible for Genesis to make alone. This one is locked because **Genesis
cannot make it at all.** The value comes from a conversation between an owner and
their supplier. An autonomous tier would not be a convenience, it would be a
route for Genesis to fill in a number about somebody's money — the exact thing
the whole economics layer exists to make impossible.

### "I don't know" is not an answer about the supplier

The branch a system like this usually gets wrong, because there is an obvious
place to put it and the obvious place is a lie.

Recording `UNAVAILABLE` when the owner says *"I haven't found out yet"* would be
Genesis claiming somebody asked and was refused. That is a different fact, it is
false, and it would stop J4 asking — which is precisely the wrong outcome, since
the person who said they'd find out is the one most likely to.

So `dont_know_yet` writes **nothing at all** and the question stays open. It is a
real branch rather than the absence of a call, specifically so there is somewhere
to assert that nothing was written.

### One contract changed, deliberately

`recordOwnerQuote` demanded both figures. It now accepts either alone and rejects
only a call with **neither** — its own stated rule, *"a call with neither answer
is not a quote"*, is untouched.

The reason is the owner, not the code. Somebody who rang their supplier and came
back knowing the minimum but not the price has found out something real, and
refusing it would throw that away and ask them the same two questions again.
`missingEconomics` then narrows the next card to the half still outstanding,
which is what "ask only the specific missing question" actually requires.

### Currency, which had been implicit

`SupplierEconomics` had no currency column, so every figure was implicitly in the
business's own. A supplier quoting in EUR to a business selling in USD would have
been read as USD — a wrong number about money that looks exactly like a right one.

Now `NOT NULL`, written from the owning Store at ingest, with no default and no
backfill: the table was empty in production (confirmed by counting rows on the
live database), so there was no row to invent a currency for. A default would
have been the invention.

A mismatch produces `cannot_assess` with `matching_currency`, never a conversion.
Nothing in this codebase has an exchange rate.

### And three models joined the isolation map

`sourcedProduct`, `supplierEconomics` and `progressionDecision` were absent from
`TENANT_SCOPED_MODELS`, so collection reads on them were unguarded. All three
were written store-scoped throughout; they are now guarded structurally, so a
future query that forgets cannot run rather than merely being unlikely to exist.

### Status

**VERIFIED** — `scripts/verify-economics-answer.ts`, 10 sections, real Postgres.

The complete loop, plus the four things it would be easy to get quietly wrong:
"I don't know" writing nothing (asserted at the row-count level, and asserted
specifically not to be a refusal); a restatement re-evaluating nothing while
still storing the current truth; a partial answer being kept and the next card
asking only for the rest; and an answer landing on neither another supplier's
product nor another business.

---

## 54. Tuesday's answer erased Monday's

*The conversational end of the loop, and the one real defect building it found.*

### What was wired

`answer_supplier_economics` is now a tool on the existing unified chat call, and
the open questions are put in the model's context the same way pending approvals
already are. `PRODUCT_PROGRESSION.md` §C6 has the shape.

Nothing new was needed to make it work, and that is worth recording because it
was the thing to check first. `create_product_from_design` is `always_ask` with
`maxAuthorityTier: always_ask`, and `route.ts` already executes it directly
through the engine on an explicit instruction in conversation. So the tier
governs whether **Genesis** may act unsupervised; an owner typing the fact is the
ask being answered, not a reason to make them approve their own sentence.

### The model is not allowed to name a supplier

The tool schema has no `sourceKey` and no `externalProductId`. A language model
cannot know either, and letting it emit one would mean a hallucinated string
deciding which supplier's terms an owner's answer lands on — the exact
wrong-number-about-money failure the four-part identity key exists to prevent.

The model names the product in the merchant's own words; the server resolves that
against the question it actually asked. Anything that does not resolve to exactly
one question writes **nothing** and asks which — asserted with a name that
matches no open question, and with two questions open and no name given.

### The defect

An owner who answered in two turns lost the first answer.

`writeOne` treats an absent figure as absent, which is correct for a connector: a
sync that stops publishing a price break has withdrawn it, and carrying the old
one forward would quote a price nobody offers. A person is the opposite case —
J4 deliberately asks only for the half it is missing, so the second message is
answering the second question, not restating the record.

Nothing about this is visible when reading the write. It was found because the
verification walked two turns, which is the normal shape of the conversation and
more than the write had ever seen.

`recordOwnerQuote` now merges with an existing OWNER row. A correction still
wins — the rule protects a person from being erased, not from changing their
mind — and a connector's absent-means-absent behaviour is unchanged, asserted in
both directions.

### The limit, named rather than worked around

Merging happens only from an OWNER row. If a catalogue published a price and the
owner supplies only the minimum, the supplier's price is **dropped** rather than
carried into a record stamped `OWNER`, because carrying it would relabel the
supplier's number as the owner's.

The honest fix is per-field provenance, which is a real schema change rippling
through `bulkTerms`, the freshness windows, the sync-may-not-overwrite-an-owner
rule and every test that reads `provenance`. **It is not done here.** It is
asserted in `verify-economics-ingest.ts` §7 so the behaviour is recorded rather
than discovered, and the practical consequence is that J4 asks again for the
figure it dropped rather than quoting one it cannot attribute.

### And one test premise that was wrong

A restatement after the question had already closed came back "I don't have an
outstanding supplier question", and that is correct: the tool answers questions
J4 asked. The test was rewritten to restate while the question is still open. An
unprompted price update with nothing outstanding is out of scope and is named as
such in §C6, not quietly half-supported.

### Status

**VERIFIED** — `scripts/verify-economics-chat.ts`, 9 sections, real Postgres,
plus `verify-economics-ingest.ts` §7 for the erasure regression.

`execute()` resolves permission from a live session a script cannot have — the
constraint `verify-orders-live.ts` already records. It is solved the same way:
the suite drives the executable with the exact ctx `execute()` would build once
`requireStorePermission` approved, through an injection point that production
never passes. Without it the conversational path could only be proven as far as
the engine's front door, and everything that decides where an owner's money goes
is behind it.

---

## 55. The four gaps before the catalog

*Closed in order, and one of them deleted a limitation §54 had recorded as
permanent-for-now.*

### 1. The question had no production caller

`raiseEconomicsQuestions` was complete and nothing ran it, so in production no
question was ever raised — the loop worked end to end for anybody who could open
a console.

It now runs inside **`runTaskDetection`**, the pass Home already awaits on every
load. That is the correct home rather than a scheduler: a separate timer for one
question would be a second thing to run, a second thing to forget to run, and a
second answer to "why did this card appear now".

**Gated, because it is not free** — it runs the whole progression engine, and
Home awaits it. The gate is one indexed count: does this business have an active
product that names a supplier listing? Exact rather than a heuristic, because a
question can only ever concern such a product. Both directions asserted.

### 2. Per-field provenance, which §54 said was not done

It is done. `PRODUCT_PROGRESSION.md` §C6a has the model.

The failing case §54 recorded — a partial owner answer dropping the supplier's
other figure — is now a passing test asserting the opposite: the owner's minimum
is `OWNER`, the supplier's price is `SUPPLIER`, both are usable, and the next
sync refreshes the supplier's own figure without touching the owner's.

Three consequences fell out that were not the point but are worth as much:
freshness is judged per fact, so a price from this morning is not aged by a
minimum from February; `UNAVAILABLE` is per fact, so a supplier who quotes a
price and refuses a minimum is asked about the minimum alone; and a sync no
longer has to be refused whole to leave one figure alone.

The row-level `provenance`/`statedAt`/`statedByUserId` trio is **gone**. "Who
last wrote this row" answered a question nothing should have been asking.

Destructive migration, safe because the table was empty in production — row count
queried on the live database, not assumed. There was no row whose one provenance
would have had to be spread across five facts, and guessing which fact an old
value described is precisely what the change exists to prevent.

### 3. The producer contract

Defined, not built. `economicsProducer.ts` names exactly what a legitimate
producer must provide — the table is in §C6b — and provides the one door it comes
through.

The load-bearing part is what a producer **cannot** supply: no `sourceKey` (the
key comes from the registry entry, checked against it), no provenance, no
freshness, and no access to Prisma. A connector supplying its own source key is a
connector that could supply somebody else's, and everything that decides whether
a number can be trusted stays on this side of the door where it is tested once.

Currency moved onto the **producer**, and that is a real correction: the previous
version stamped every row with the business's currency, which is right for an
owner typing what they were quoted and wrong for a supplier that quotes in its
own money. A EUR producer writing to a USD business now stores EUR, and
`assessFeasibility` refuses to compare rather than applying a rate nobody
supplied. Asserted end to end.

### 4. What a supplier price change does

**Decided: a supplier's own fact is theirs to change. It updates in place,
silently, and raises no question.** Asking an owner to approve a price they do
not control is asking them to approve the weather; a rise does the same nothing,
because Genesis does not model reordering and there is no decision to revisit.

A price change reaches the owner by exactly one existing route — the
reconsideration mechanism, when it materially changes a decision they actually
declined. No catalogue feed, no alert, no new question type.

The honest counterpart, and the one case that DOES ask: **withdrawing a figure
reopens the gap.** A catalogue that stops publishing a price has not changed the
price — Genesis no longer knows it, and the response is the same one it gives
when nobody ever said. The question returns automatically, asking only for the
half that vanished.

Out of scope and named as such: a general catalogue-change system.

### Status

**VERIFIED** — `scripts/verify-economics-producer.ts`, 7 sections, real Postgres,
covering items 1, 3 and 4; item 2's write rules are in
`verify-economics-ingest.ts`, where they belong.

Full regression green: 7 pure suites, 9 live ones, typecheck and build.

Three test premises were wrong and were fixed rather than the code, all three
because per-field provenance made the old behaviour obsolete: a sync being
refused wholesale, the dropped-supplier-figure limitation, and a decision
snapshot hand-built from a shape that no longer carries attribution. One real
mistake of my own was caught the same way — a value import from `lib/` at module
scope in a verification script, which loads Prisma before `DATABASE_URL` points
at the harness and produced exactly one `ECONNREFUSED`.

---

## 56. Three instruments, two of which lied

*The last three pre-catalog items. The third is mostly a story about measurement,
and it is the part worth reading.*

### The card is the form

`PRODUCT_PROGRESSION.md` §C5a has the shape. The short version: every other Task
card hands off to a conversation because the work is open-ended; this one is two
numbers, so the card collects them and goes through the identical path the
conversation does.

`parseCardEconomicsAnswer` is pure and separately tested, because parsing is
where a figure about somebody's money gets invented. An empty field stays absent
rather than becoming 0. A fractional minimum is refused rather than rounded.
Both fields blank is not a quote — it is somebody who has not found out, and it
is recorded as such rather than as an empty answer.

### The first real producer

`ProductSource` gained `economics()` behind a `statesEconomics` capability,
asserted if-and-only-if over the registry the same way `quote` already was.
Printful implements it; AliExpress declares `false` and has nothing behind it.

The judgement in it is what Printful is allowed to say. It states a minimum of
**1**, and that is a stated fact rather than a default: print on demand genuinely
has no minimum. It is the only place in this codebase where a minimum of 1 is
true, and it is only true because the method makes it true.

It states shipping as **null** when the rate lookup fails. `getCost` reports that
as 0, which is right for an order estimate and wrong for a stated fact, so
`printfulEconomicsQuote` exists as a separate function rather than a reuse — the
economics layer has to be able to tell "free" from "we could not find out".

And it reads the currency from Printful's own `/store` endpoint rather than
assuming dollars, which is one extra call and removes the last figure in that
path that would have been a guess.

### Three instruments, two of which lied

The question was whether `nextMoves`' per-candidate economics reads are a real
bottleneck. Answering it took three attempts and the first two produced numbers
that looked completely credible.

**`pg_stat_database.xact_commit`** said 394 round trips over 25 candidates —
about 1.2 seconds of network wait against Neon. It was nonsense: reads do not
commit, so most of that count was autovacuum working through the rows the
fixture had just inserted. A breakdown showed `buildSourcingContext` at 378
"round trips", which was the tell — it writes nothing.

**`pg_stat_all_tables`** was the right shape — scans of one table — and reported
**0**, because the stats collector lags. The assertion built on it passed
vacuously. A green test proving nothing is worse than a red one.

**A counter in the layer itself** is deterministic and is what the number now
comes from: 25 candidates + 1 graduation resolve in **3 reads**, and the
assertion is that the count does not grow with the candidate list.

So the honest answer to the original question: **yes, the pattern was one read
per candidate, and it is now one read for all of them** — but the 1.2-second
figure that nearly justified a much larger change was an artefact. The fix is one
batched query and a map keyed by the same four identity parts as always;
`bulkTerms`, ranking, fit and feasibility are untouched, and the suite asserts the
same three moves in the same order with everything still considered.

### Status

**VERIFIED** — `scripts/verify-economics-production.ts`, 6 sections, real
Postgres. Full regression green: 7 pure suites, 10 live ones, typecheck, build.

One test premise was wrong and was fixed rather than the code: it tried to have
the owner answer a question that the producer had already closed, which
`applyEconomicsAnswer` correctly refuses. One real bug of mine was caught by the
suite — `runEconomicsProducer` reported "had nothing to state" for a supplier
that was actually unreachable, because it read `blockedOn` before the call that
discovers it.

---

## 57. The catalog, and what it was allowed to decide

*The screen everything since §41 was built for.*

### What it is

Not a grid of things a supplier sells. Every row is a recommendation with its
reasoning attached, and **the screen decides none of it** — `catalogView`
assembles the page by calling the functions that already make those judgements,
and adds no judgement of its own. `PRODUCT_SOURCING.md` has the table.

That constraint did real work. Affordability, fit, framing and provenance all
arrive already decided, so the catalog cannot disagree with what J4 says in chat
about the same product. A screen with its own opinion about whether something is
affordable would have been a second opinion able to drift.

### The four things a catalog gets wrong

Each has a section in the verification.

**Naming a supplier.** The whole recommendation surface is searched for every
registered source's display name and key. One exception is deliberate and
asserted separately: a source that could not be searched IS named, under "places
I couldn't look", because the alternative is searching less than the page claims
to and saying nothing.

**Inventing a price.** A row with nothing recorded says so and claims nobody said
it. A supplier's figure is credited to their catalogue; an owner's to the owner;
a refusal reads as "nobody would say" and shows no number. The mixed case — the
owner's minimum beside the supplier's price, each with the right name on it — is
asserted, and is only possible because of per-field provenance.

**Claiming a fit it cannot judge.** A business that has described itself as
nothing gets "I don't know enough about your business yet", not "nothing fits
you" — different sentences, and only one of them is the owner's problem. The
suggestion is still listed, still honest about why it cannot be judged, because
hiding it would be pretending nothing was found.

**Letting one business see another's shelf.** Two businesses on one account, one
suggestion each, and neither view contains the other's.

### Three test premises were wrong, and one design question was real

The premises: a print-on-demand candidate was expected to fail a currency check
that correctly never runs at rung 0 (nothing is bought, so there is no figure to
compare); a store meant to have said nothing about itself still had a tagline,
which is part of "the business in its own words"; and the supplier-name sweep
covered the blocked-sources list, where naming is the entire point.

The design question was that third one. `describeBlockedSources` was built to
answer "why did this only search one supplier" without reading code, and the
answer necessarily contains a supplier's name. Keeping it means one place on the
page names a supplier to the owner. That is the lesser cost: the alternative is a
page that quietly searched half of what it implies.

### Status

**VERIFIED** — `scripts/verify-catalog-live.ts`, 9 sections, real Postgres. Full
regression green: 7 pure suites, 11 live ones, typecheck, build. Both routes
build — `/dashboard/catalog` and `/b/[slug]/catalog`, the latter resolving its
business from the URL like every other migrated screen.

---

## 58. Four blockers, and what the browser found

*The catalog's own follow-up. Three closed, one externally blocked and named.*

### A real browser, and what it caught

`verify-catalog-browser.ts` signs in through the real form, navigates real
`/b/[slug]/catalog` URLs against a real Next server on real Postgres, and reads
what the server actually rendered. Six sections: the right business's
suggestions and not the other's, grouping in the owner's terms, adding a product
through the real form at a typed price, the other business's catalog being its
own, a dismissal sticking, and a business Genesis knows nothing about being told
so rather than looking empty.

Three things it caught that no read-model test could:

**A locator matching the wrong element** — `li:has-text("ZZFOAMROLLER")` matched
the *starting-set* list item, which carries the same product name and no form.
Not a product defect, but the class of mistake that makes a browser test pass
while proving nothing.

**`fill()` leaving a number input empty.** Playwright's one-step fill left the
price field blank, the form fell back to the supplier's suggested retail, and the
adoption looked successful. Typing the digits works. So the field is fine and the
fallback is correct — but a test that had asserted only "a product was created"
would have called that a pass. It now asserts the value reached the field
*before* submitting, because a price that never arrived and a price the server
ignored look identical afterwards.

**A sign-in that intermittently did not complete** when run straight after
another browser suite: the page stayed on `/login` showing no error, which is
precisely what a *rejected* login would not do. One retry after waiting for the
server to settle; stable across repeated runs.

### Discovery's caller, and the producer's

Both use the `after()` lifecycle Home already runs, not a scheduler.
`PRODUCT_SOURCING.md` has the gates. The one worth repeating: **the supplier
freshness policy IS the producer's schedule.** Thirty days already means "too old
to stand behind"; a cron would have been a second answer to a question already
answered, and the two would drift.

### Genesis's own verdict, made durable

`RULED_OUT` — and the previous reasoning for *not* storing it is worth keeping
because it was half right. A stored row for something Genesis declined would
indeed be indistinguishable later from one it raised. The fix is a status that
says which, not discarding the judgement.

It is never confused with `DISMISSED`: one is Genesis's opinion and is
re-evaluated every run, the other is the owner's decision and is respected
forever. Both asserted, including a business that changes how it describes itself
and is then offered the thing it was refused.

### The one that is blocked

Verifying Printful's `economics()` against the live API. Credentials exist —
five Printful connections in production, four on Genesis's own audit accounts.
Two things stop it, and neither should be worked around:

1. **No store has an adopted Printful product**, so `economics()` correctly
   states nothing and never reaches the API. Adopting one to make a test pass
   would mean writing to production data.
2. **Production credentials are encrypted with the production
   `INTEGRATION_ENCRYPTION_KEY`**, a Vercel secret this machine does not hold.
   Attempting it with the local key fails to decrypt, which is the credential
   encryption working exactly as designed.

`scripts/check-printful-economics-live.ts` exists, is read-only, refuses to touch
the one connection belonging to a real customer rather than to Genesis, and is
deliberately not part of the regression. It reports the block rather than
pretending to have checked.

### Status

**VERIFIED** — `verify-catalog-browser.ts` (6 sections, real server + browser)
and `verify-catalog-live.ts` (11 sections, real Postgres). Full regression green:
7 pure suites, 13 live ones including both browser suites, typecheck and build.

Three assertions in `verify-sourcing-live.ts` asserted that a ruled-out candidate
wrote no row, which is the behaviour this pass deliberately changed. They were
rewritten to assert the new contract while keeping the property they existed to
protect — that one business's discovery never writes into another's — which is
still true and still asserted. One assertion in `verify-economics-live.ts` was
flaky and had been passing by luck: it searched a serialised move for "900" and
a generated cuid eventually contained "9000". It now reads only the sentences an
owner sees.

---

## 59. An opinion the owner can overrule

*Two follow-ups from §58, and one blocker formally accepted as external.*

### Genesis was making rules about somebody else's business

`RULED_OUT` was correct in the domain and wrong on the page. `adoptSourcedProduct`
had never checked it — only `DISMISSED` binds — so an owner could always have
overruled the verdict. The catalog simply never offered a way, which in practice
made Genesis's opinion a prohibition.

Every ruled-out row now carries **Add anyway**: the same action, price field and
fallback as any other adoption. The section says what it is — *"My opinion, not a
rule. You know things about your business I don't."*

The distinction the two statuses exist for is now asserted in both directions: a
ruled-out product adopts, and a dismissed one still refuses. One is an opinion,
re-evaluated every run; the other is a decision, respected forever.

The 12-item cap is gone, replaced by the same limit the suggestions use, and the
page renders "Showing 40 of 45" whenever the list is short. A silently truncated
list of things Genesis decided against reads as all of them.

### The trigger, recorded rather than left implicit

Discovery and the economics refresh fire **on a Home load and at no other time**.
A business whose owner never opens Home is never searched and never refreshed.

That is the deliberate scope for this milestone, not an oversight. Scheduled and
background intelligence belongs to the Business Intelligence milestone, which
already owns a scheduler; a second one here would be the parallel mechanism this
codebase keeps refusing to build.

### Printful's live API — accepted as EXTERNALLY BLOCKED

Formally closed as external, on Sean's instruction, and the three things that
would have "fixed" it are all refused on the record:

- **Not** by weakening credential encryption.
- **Not** by creating fake production data.
- **Not** by adopting a Printful product solely to manufacture a passing test.

What blocks it: no store has an adopted Printful product, so `economics()`
correctly states nothing and never reaches the API; and production credentials
are encrypted with the production `INTEGRATION_ENCRYPTION_KEY`, a Vercel secret
this machine does not hold. The local key fails to decrypt them, which is the
encryption working as designed.

`scripts/check-printful-economics-live.ts` is kept: read-only, outside the
regression, and it refuses to touch the one connection belonging to a real
customer rather than to Genesis. What it verifies when a key and an adopted
product both exist: that `/store` states a currency, that a variant price parses,
and that a failed rate lookup reports null rather than free.

### Status

**VERIFIED** — `verify-catalog-live.ts` (13 sections) and
`verify-catalog-browser.ts` (7 sections, real server + browser, including the
override exercised through the real disclosure and the real form). Full
regression green.

The browser suite caught one more thing worth recording: the ruled-out list sits
behind a `<details>`, so nothing inside it is clickable until the summary is
clicked. The first version of the test failed on an invisible element — which is
what a person would have hit too, and is why the disclosure is opened rather than
worked around.

---

## 60. What a run may spend, refused before it is spent

*BI milestone, increment 2. The scheduler stage makes outbound calls to third
parties with nobody watching, and until now nothing bounded what it could cost.*

### The ceiling is at the call

A budget that counts requests after they are made has already spent the money it
was meant to protect. So the boundary is `supplierRequest`, wrapping all nine
outbound calls in `lib/fulfillment/printful.ts` — the only place in the codebase
that fetches a supplier. It asks the budget **before** invoking, and an exhausted
budget throws instead of fetching.

That distinction is what the verification is built to prove rather than assume:
a fake supplier counts its own invocations, and twenty attempts past a limit of
three produce **three calls**. A tally-afterwards implementation reads twenty
there.

Two ceilings, because one is not enough: a per-run total, and a per-business
share. Without the second, one business with a large catalogue consumes the whole
pass and starves everything behind it — the opposite of what a bounded
backlog-working scheduler is for.

### Scoped to a run, so fulfilment is never throttled

The same connector buys shipping labels and creates orders. Those must never be
refused because a discovery pass used up its allowance, so the budget lives in an
`AsyncLocalStorage` run scope: inside a pass it applies, outside it there is no
budget and the call proceeds untouched. Asserted directly — eight calls outside a
run all go through, and none is attributed to a run.

### A third axis, not AI cost and not Growth Points

`SupplierRequestEvent`. Folding supplier HTTP into `AiUsageEvent` would put
network calls in a table whose every column is about tokens and models; folding
it into `GrowthPointTransaction` would charge an owner for work Genesis chose to
do unprompted. Both would be lies that balance. The suite asserts both tables
stay empty while supplier requests are recorded.

A **failed** request is still spend and still counts, otherwise a broken supplier
would be free to hammer.

### The refusal has to leave

Four places catch errors and carry on — the per-product loop in `economics()`,
the quote path, `discoverProducts`'s per-source catch, and the lifecycle
wrappers. Every one of them would have turned the ceiling into a suggestion by
swallowing the refusal and asking again for the next product or the next source.
All four now rethrow a budget refusal specifically, and the last section proves
it end to end through the real discovery stack: the supplier is asked **zero**
times and nothing is written.

### What the flawed first version got wrong

Selection truncated to the budget, so the loop simply ran out of candidates and
reported `completed` while businesses were still waiting — a truncated pass and a
complete one were indistinguishable from inside. It now selects **one more than
it can afford**: the extra candidate is never processed, only counted, which is
how a page knows it is not the last page.

A stopped run reports `budget_exhausted`, records no store as failed, writes
nothing partial for the business it never reached, and leaves that business at
the front of the queue for the next pass. All four asserted.

### Status

**VERIFIED** — `scripts/verify-sourcing-budget.ts`, 9 sections, real Postgres.
Full regression green: 7 pure suites, 12 live including the browser suite,
typecheck and build.

---

## 61. The layer whose job is remembering had a hole where sourcing was

*BI milestone, increment 3. Belief as persistent business memory.*

### What was lost

`recordExecutionEvent` maps an execution to a `BusinessEvent` through a
five-entry allow-list — the product actions. Everything else returns null. So an
owner telling Genesis what their supplier charges produced **no event**, and
therefore no change detection, no insight and no belief: a real fact about the
business, learned from a person and immediately forgotten by the layer whose
whole job is remembering.

Adoption had the same hole from the other direction. It creates a real owned
product without going through `create_product`, so the execution engine never saw
it — the event log was empty exactly where a first-party store's catalogue comes
from.

Both now write through `writeBusinessEvents`, the seam every other event already
uses. No second event system, no second ledger. The adoption event is written
inside the **same transaction** as the product and the claim, so an event can
never describe an adoption that did not commit.

### The half-built read, and why it returned nothing

`reasoning.ts` documented `Belief.recordId`/`entityType` as a gap: the per-record
read had existed since Learn's Phase 2 and always returned `[]`.

The cause was one line. `upsertBelief`'s **create** branch set both fields and its
**update** branch did not — and beliefs are re-derived on every pass, so any
belief that existed for more than one cycle lost its record identity. The read
was fine. Nothing had ever been readable through it.

### Belief is not a second source of truth

The rule the whole increment turns on, and it is asserted rather than asserted-in-
prose: **no supplier figure reaches a belief.** A price lives in
`SupplierEconomics` and nowhere else; a belief is a pattern across what happened,
grounded by real evidence ids. The event payload carries the supplier's identity
— enough to trace an answer back — and none of its numbers.

The three answers also stay three different facts. "They quoted me", "they
wouldn't say" and "I haven't found out" become three distinct event types rather
than collapsing into "the owner replied", because the difference between them is
the whole reason the answer path has three branches.

### Verification, and one boundary it found

`scripts/verify-business-memory-live.ts`, 9 sections, real Postgres — the
consolidated live pass the BI Engine had been missing since M1. `BI_ENGINE.md`
had said plainly that none of its nine milestones had ever touched a database.

It found one thing worth recording: **`runIntelligenceCycle` cannot complete
without an AI provider.** Its last stage is the one AI call in the engine, and a
harness has no credentials. That is an external boundary like the Printful one,
not something to paper over with a fake key — and what it proves anyway is the
property that matters: Learn runs before Reason and unconditionally, so a
business's memory does not depend on a provider being reachable. The beliefs
asserted in that section were distilled during a pass that then failed.

### A claim of mine that was wrong

I reported the BI suites as pure-logic-only, based on grepping for
`startRealPostgres`. That was the wrong probe: several of them are database-backed
through the shared `run-db-suites` harness instead, and `intelligence-cycle`
passes there. Corrected by running the harness rather than re-reading the grep.

The same run showed four pre-existing failures — `brand-logo-flow`,
`product-image-gallery-e2e`, `social-connections-pipeline`, `stripe-webhook-e2e`,
all external-dependency. **Confirmed pre-existing by stashing this increment and
re-running the baseline**, rather than assumed from their names.

### Status

**VERIFIED** — `verify-business-memory-live.ts` (9 sections, real Postgres), plus
15 separately-hosted live suites, 15 harness suites (11 pass, 4 pre-existing
external failures), 15 pure suites, typecheck and build.

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
scripts/verify-rate-limit.ts              Retry-After, jitter, what is and is not retried
scripts/verify-sync-backoff.ts            deferral vs failure, and the caps on both
scripts/verify-provider-error.ts          what a failed provider call may say
scripts/verify-password-policy.ts         password rules, and evicting a reset session
scripts/verify-auth-throttle.ts           brute-force buckets, and the cron gate
scripts/verify-checkout-outcome.ts        what a buyer is told when checkout breaks
scripts/verify-shipped-notification.ts    whether the customer was actually emailed
scripts/verify-tenant-isolation.ts        what counts as a store-scoping filter
scripts/verify-regressions.ts             each defect reproduced against the pre-fix code
scripts/verify-growth-point-ledger.ts     points never lost, duplicated, or double-charged
scripts/verify-permissions.ts             the role matrix, asserted by name
scripts/verify-webhook-store.ts           forged Stripe events at the money boundary
scripts/verify-credential-encryption.ts   tampering, re-keying, and legacy rows
scripts/verify-db-integrity.ts            the guard, the constraints, the migrations (real Postgres)
scripts/verify-ledger-live.ts             the ledger's real transactions (real Postgres)
scripts/run-db-suites.ts                  runs the suites that need a database
scripts/verify-test-isolation.ts          no suite can point at production
scripts/verify-webhook-handlers.ts        signed payloads against the real handlers
scripts/verify-report-issue.ts            never throws, never leaks a token
scripts/verify-order-webhook-live.ts      the order-creation branch (real server + real Postgres)
scripts/verify-order-confirmation.ts      what the confirmation says, and to whom
scripts/verify-confirmation-live.ts       claim, release, retry, tenant separation (real Postgres)
scripts/verify-checkout-live.ts           checkout guards against the real action (real Postgres)
scripts/verify-orders-live.ts             fulfilment lifecycle and tenant scoping (real Postgres)
scripts/verify-paypal-live.ts             the PayPal rail, end to end (real Postgres)
scripts/verify-paypal-refund.ts           forged, cross-tenant and replayed refunds (real Postgres)
scripts/verify-paypal-webhook-lifecycle.ts  the refund subscription, connect to disconnect (real Postgres)
scripts/verify-label-purchase-live.ts     which rate is bought, and when it refuses (real Postgres)
scripts/verify-product-sourcing.ts        source capabilities and recommendation honesty
scripts/verify-sourcing-live.ts           discovery, dismissal and adoption (real Postgres)
scripts/verify-business-context-live.ts   which business is active, and how it is chosen (real Postgres)
scripts/verify-business-browser.ts        the whole thing through a real browser (real server + Postgres)
scripts/verify-business-paths.ts          business-scoped navigation paths
scripts/verify-progression.ts             evidence, policy, capital posture, earned rungs
scripts/verify-moves.ts                   ranking, and what a move may claim
scripts/verify-progression-live.ts        the progression engine end to end (real Postgres)
scripts/verify-economics-live.ts          supplier economics, and the zero-capital journey (real Postgres)
scripts/verify-economics-ingest.ts        the only way economics get written (real Postgres)
scripts/verify-economics-answer.ts        J4 asks, the owner answers, the progression moves (real Postgres)
scripts/verify-economics-chat.ts          the same answer, typed into the conversation (real Postgres)
scripts/verify-economics-producer.ts      detection, the producer contract, and price changes (real Postgres)
scripts/verify-economics-production.ts    the card form, the first real producer, and what nextMoves costs (real Postgres)
scripts/verify-catalog-live.ts            what the catalog shows, and what it may not claim (real Postgres)
scripts/verify-catalog-browser.ts         the catalog through a real browser (real server + Postgres)
scripts/verify-sourcing-schedule.ts       who an unattended pass reaches, and that cron runs it (real Postgres)
scripts/verify-sourcing-budget.ts         what a run may spend, refused at the call (real Postgres)
scripts/verify-business-memory-live.ts    facts to events to beliefs, and what a belief may not hold (real Postgres)
```

No item here is marked compliant on the strength of reading the code alone.

Both migrations added during this audit — `passwordChangedAt` and `AuthAttempt` —
were confirmed applied in production by reading `_prisma_migrations` directly,
not inferred from a green build.

---

## Close-out — what each of these words means

*The money-surface audit is complete. **The system is not verified as a whole**,
and this section exists so that cannot be misread. Four categories, and they are
not interchangeable.*

### VERIFIED — behavioural proof exists

Each of these was exercised against a real Postgres, or a real Next server, with
the defect reproduced against the pre-fix behaviour first:

| Surface | Where |
|---|---|
| Checkout-session creation | §37 — real server action, real database |
| Webhook signature and store resolution | §25, §28 — real signed payloads |
| Order creation, shipping metadata, BusinessEvent | §34 — real server, real request scope |
| Replay and idempotency (orders, points, confirmations) | §23, §26, §34, §35 |
| The confirmation's decision, payload and claim | §35 |
| Fulfilment lifecycle and the label state machine | §36, §39 |
| Refunds and money out | §40 |
| The PayPal rail, end to end | §41 — the real route, real database |
| PayPal refunds, forged and cross-tenant | §42 — the real route, real database |
| The refund subscription's lifecycle | §43 — the real connector, real database |
| The label purchase, and which rate it buys | §44 — the real executable, real database |
| Product sourcing and discovery | §45 — the real pipeline, real database |
| The sourcing migration, as it landed in production | §46 — read from the production database |
| Two businesses on one account, kept separate | §48 — the real pipeline, real database |
| Active-business resolution and its migration | §49 — the real resolver, real database |
| The migrated screens, through a real browser | §50 — real server, real browser, real sign-in |
| Tenant isolation | §26 — the guard through the real client |
| Authentication, sessions, brute force, roles | §14–16, §24 |
| Growth Points ledger | §23 — real transactions |

Every defect found is reproduced against its old behaviour in
`verify-regressions.ts` or in the suite that found it.

### UNVERIFIED — real, and not proven

Not failures. Things this environment cannot demonstrate, named so nobody
assumes otherwise:

- **The Stripe API call itself.** Every guard in front of it is proven; the call
  needs a Stripe test key.
- **`confirmSelectedRate`'s live re-quote.** The logic is proven; the round trip
  needs an EasyPost key.
- **Cross-tenant SERVER ACTIONS composed under one live HTTP session.** Narrowed
  2026-08-21. The page-level half is now proven, not inferred:
  `scripts/verify-business-browser.ts` signs in through the real login form
  against a real server and a real Postgres, and asserts that another account's
  business answers 404 — with no business's products quietly shown instead — that
  two tabs hold two businesses through three rounds of navigation, and that all
  fifteen migrated sections render inside a business. What remains unproven is
  narrower than this bullet used to claim: INVOKING a server action
  cross-tenant, which still needs an action ID from a rendered page.
- ~~**Three suites** that parallelise reads and cannot run on PGlite.~~
  **Closed 2026-08-21.** Not a limitation of the suites and not a PGlite
  limitation either: `PGLiteSocketServer` defaults `maxConnections` to 1 and
  refuses the second pooled client, and the error it produces names whichever
  query happened to be second rather than the pool that opened it. One option in
  `scripts/lib/testDatabase.ts` fixed all three, with nothing in production and
  nothing in the suites touched. The harness runs 13 of 13.
- **Email delivery.** Everything up to the provider handoff is proven; the
  handoff is externally blocked.

### EXTERNALLY BLOCKED — waiting on a credential, account or approval

Engineering is complete on every one; none is an engineering gap. The full list
with instructions is under **Action required from Sean** at the top of this
document. In short: Resend (every customer email), QuickBooks reconnect, Google
OAuth publish, Mailchimp / Facebook / TikTok / Square client credentials,
EasyPost account verification, the Intuit hosting-IP question, and a Stripe test
key.

### NOT MODELLED — a product decision, not a defect

**Partial refunds** (§40, §42 — both rails). Genesis has no field for one, so a partially refunded
order reads as fully paid and its full amount counts as revenue. **Deliberately
not implemented, and awaiting Sean's approval** — it needs a schema change *and*
a decision about how a partial refund should affect revenue reporting: whether it
reduces recognised revenue, appears as a separate adjustment, or shows only in
the order view. Guessing at that inside an audit would put a number on a
merchant's dashboard that nobody chose.

### Closed since this section was written

**PayPal refunds are now handled** (§42) — recorded here because this close-out
named the gap and it would be worse to leave it reading as open. Both rails now
learn about a refund, and both stop at the same place: a genuinely partial one.
