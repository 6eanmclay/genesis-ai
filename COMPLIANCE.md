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
| 3 | Credentials encrypted at rest | **Compliant** | `credentials.ts`, AES-GCM via `INTEGRATION_ENCRYPTION_KEY` |
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

**Still inspection-only:** the webhook handlers, which need HTTP request plumbing
rather than just a database.

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
```

No item here is marked compliant on the strength of reading the code alone.

Both migrations added during this audit — `passwordChangedAt` and `AuthAttempt` —
were confirmed applied in production by reading `_prisma_migrations` directly,
not inferred from a green build.
